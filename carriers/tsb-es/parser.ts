import { ChallengeError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochMillisTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { tsbSituation, tsbState, tsbStep } from './status.js';

export const PROVIDER = 'TSB';
export const TSB_MAX_BYTES = 2 * 1024 * 1024;
export type TsbLanguage = 'es' | 'en' | 'ca';

/** TSB publishes no layout, so a number is one token of letters, digits, hyphens and underscores. */
export function normalizeTsbNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,39}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

/** The address the public tracker reads one shipment from. */
export function tsbUrl(number: string): string {
  return `https://www.tsbconnect.net/tracking/find?number=${encodeURIComponent(number)}`;
}

// A number reaches the adapter in capitals and without separators, so the reply's own is compared the same way.
const folded = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).toUpperCase().replace(/[\s./_-]/g, '') : '');
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;

/** Read one reply of the tracker's service: a shipment, a missing one, or a failure of its own kind. */
export function parseTsbReply(status: number, body: string, rawNumber: string, language: TsbLanguage = 'es'): CarrierResult {
  if (status === 404) throw new TransportError(PROVIDER, 'TSB tracking service is unavailable', { status });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TSB answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'TSB answered with a page instead of its tracking JSON', { cause });
  }
  return parseTsb(payload, rawNumber, language);
}

// The steps of the public page's progress rail, in its order, each with the field that dates it.
const RAIL = [['alta', 'fechaAlta'], ['recepcion', 'fechaRecepcion'], ['salida', 'fechaSalida'], ['llegada', 'fechaLlegada'],
  ['reparto', 'fechaReparto'], ['repartoFallida', 'fechaRepartoFallida'], ['entrega', 'fechaEntrega']] as const;

interface Scan { event: CarrierEvent; at: number; index: number }

/** A date of the service: milliseconds since 1970, as the page reads them. Absent is null; anything else is a changed service. */
function moment(value: unknown): { iso: string; timestamp: number } | null {
  if (value == null) return null;
  const at = typeof value === 'number' ? epochMillisTime(value) : null;
  if (!at || at.timestamp < 1e12 || at.timestamp >= 1e13) throw new SchemaError(PROVIDER, 'TSB returned a date that is not a moment in milliseconds');
  return at;
}

/** The recipient as the page shows them: the name, then the street and the postcode with the town. */
function recipientOf(shipment: Record<string, unknown>): Pick<CarrierResult, 'receiver_name' | 'receiver_address'> {
  const name = clean(shipment.nombreDestinatario, 120);
  const address = isRecord(shipment.direccionDestinatario) ? shipment.direccionDestinatario : {};
  const town = [cleanScalar(address.codigoPostal, 16), clean(address.poblacion, 80)].filter(Boolean).join(' ');
  const lines = [clean(address.direccion, 200), town].filter(Boolean).join('\n');
  return { ...(name ? { receiver_name: name } : {}), ...(lines ? { receiver_address: lines } : {}) };
}

export function parseTsb(payload: unknown, rawNumber: string, language: TsbLanguage = 'es'): CarrierResult {
  const number = normalizeTsbNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'TSB returned no shipment');
  // The service repeats the number it was asked; a shipment without that echo must carry it as its number or its reference.
  const shipment = isRecord(payload.expedicion) ? payload.expedicion : undefined;
  const named = payload.num == null ? [shipment?.numeroExpedicion, shipment?.referenciaCliente] : [payload.num];
  if (!named.some(own => folded(own) !== '' && folded(own) === folded(number))) throw new SchemaError(PROVIDER, 'TSB did not identify the requested number');
  if (payload.error != null) {
    if (payload.error === 'tracking.notFound' && payload.expedicion == null) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'TSB returned an error it does not explain');
  }
  if (!shipment) throw new SchemaError(PROVIDER, 'TSB returned no shipment');

  const identifiers = [shipment.numeroExpedicion, shipment.referenciaCliente].filter(id => id != null && id !== '');
  if (identifiers.length && !identifiers.some(id => folded(id) === folded(number))) throw new SchemaError(PROVIDER, 'TSB returned another shipment');

  // The page reads two kinds of event: an international departure, which renames the arrival step, and a delivery position.
  const listed = shipment.eventos ?? [];
  if (!Array.isArray(listed) || listed.length > 500 || !listed.every(isRecord)) throw new SchemaError(PROVIDER, 'TSB returned an invalid event list');
  const departures = listed.filter(event => event.tipoEvento === 'SACO');

  const scans: Scan[] = [];
  const add = (code: string, status: { en: string; es: string; ca: string; stage: Stage }, at: { iso: string; timestamp: number }): void => {
    scans.push({ at: at.timestamp, index: scans.length, event: { time: at.iso, description: status[language], provider_code: code, stage: status.stage, stage_source: 'carrier_map' } });
  };
  for (const [step, field] of RAIL) {
    const at = moment(shipment[field]);
    if (!at) continue;
    const code = step === 'llegada' && departures.length ? 'llegadaAlmacenInternacional' : step;
    add(code, tsbStep(code)!, at);
  }
  for (const departure of departures) {
    const at = moment(departure.fechaEvento);
    if (!at) throw new SchemaError(PROVIDER, 'TSB returned an international departure without a date');
    add('SACO', tsbSituation('SACO')!, at);
  }
  // Newest first; steps on one clock keep the rail's order.
  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const events = scans.map(({ event }) => event);

  // The shipment's stated situation decides where it stands; without one, its newest step does.
  const state = tsbState(shipment.estadoExpedicion);
  const stage = state?.status.stage ?? (events[0]?.stage as Stage | undefined);
  if (!stage) throw new SchemaError(PROVIDER, 'TSB returned a shipment without a step or a situation');
  const delivered = stage === 'delivered' ? events.find(event => event.provider_code === 'entrega')?.time : undefined;
  const summary = { status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
    last_status_text: state?.status[language] ?? events[0]!.description!,
    ...(state && events[0]?.provider_code !== state.code ? { provider_code: state.code } : {}), ...recipientOf(shipment) };
  if (!events.length) return { ...summary, last_update: null, expected_delivery: null, summary_only: true, events: [] };
  return { ...summary, last_update: events[0]!.time ?? null, expected_delivery: null, ...(delivered ? { delivered_at: delivered } : {}), events };
}
