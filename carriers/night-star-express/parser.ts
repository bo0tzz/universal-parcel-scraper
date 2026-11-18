import { ChallengeError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { nightStarStatus } from './status.js';

export const PROVIDER = 'Night Star Express';
export const NIGHT_STAR_MAX_BYTES = 2 * 1024 * 1024;
// The service the tracking page posts its references to.
export const NIGHT_STAR_ENDPOINT = 'https://customer.night-star-express.de/api/orders';
export type NightStarLanguage = 'en' | 'de';

/** The page takes a reference of six characters or more; a comma would start another one. */
export function normalizeNightStarNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{5,49}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

// A number reaches the adapter in capitals and without separators, so the reply's own are compared the same way.
const folded = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).toUpperCase().replace(/[\s.-]/g, '') : '');
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;

/** Read one reply of the orders service: its orders, a missing reference, or a failure of its own kind. */
export function parseNightStarReply(status: number, body: string, rawNumber: string, language: NightStarLanguage = 'en'): CarrierResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Night Star Express answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'Night Star Express answered with a page instead of its tracking JSON', { cause });
  }
  if (status === 404) {
    if (isRecord(payload) && payload.message === 'Not found') throw new NotFoundError(PROVIDER);
    throw new TransportError(PROVIDER, 'Night Star Express tracking service is unavailable', { status });
  }
  return parseNightStar(payload, rawNumber, language);
}

interface Scan { event: CarrierEvent; at: number; index: number }
interface Package { scans: Scan[]; stage?: Stage; status: string }

/** One package's events, newest first, with the stage its own status or its newest staged event gives it. */
function readPackage(item: Record<string, unknown>, offset: number, language: NightStarLanguage): Package {
  const status = typeof item.status === 'string' && NAME.test(item.status) ? item.status : '';
  if (!status || !Array.isArray(item.events) || item.events.length > 500) throw new SchemaError(PROVIDER, 'Night Star Express returned an invalid package');
  const scans: Scan[] = [];
  for (const [index, row] of item.events.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Night Star Express returned an incomplete event');
    const name = typeof row.status === 'string' && NAME.test(row.status) ? row.status : '';
    const known = name ? nightStarStatus(name) : undefined;
    // The page shows the event's own wording, and its remark's under it.
    const wording = clean(row.description, 300) || known?.[language] || name.replaceAll('_', ' ').toLowerCase();
    const remark = clean(row.remarkDescription, 300);
    const at = explicitOffsetTime(row.timestamp);
    if (!at || !wording) throw new SchemaError(PROVIDER, 'Night Star Express returned an event without a wording or clock');
    scans.push({ at: at.timestamp, index: offset + index, event: {
      time: at.iso, description: remark && remark !== wording ? `${wording}: ${remark}` : wording,
      ...(name ? { provider_code: name } : {}),
      ...(known ? { stage: known.stage, stage_source: 'carrier_map' } : {}),
    } });
  }
  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const stage = nightStarStatus(status)?.stage ?? (scans.find(({ event }) => event.stage)?.event.stage as Stage | undefined);
  return { scans, status, ...(stage ? { stage } : {}) };
}

export function parseNightStar(payload: unknown, rawNumber: string, language: NightStarLanguage = 'en'): CarrierResult {
  const number = folded(normalizeNightStarNumber(rawNumber));
  if (!Array.isArray(payload) || payload.length > 50 || !payload.every(isRecord)) throw new SchemaError(PROVIDER, 'Night Star Express returned no order list');
  // The page shows "nothing found yet" for an empty list.
  if (!payload.length) throw new NotFoundError(PROVIDER);
  const orders = payload as Record<string, unknown>[];
  if (!orders.every(order => Array.isArray(order.colis) && order.colis.length <= 200 && order.colis.every(isRecord))) {
    throw new SchemaError(PROVIDER, 'Night Star Express returned an invalid order');
  }
  const packagesOf = (order: Record<string, unknown>): Record<string, unknown>[] => order.colis as Record<string, unknown>[];
  const named = (item: Record<string, unknown>): boolean => folded(item.barcode) === number || folded(item.alternateBarcode) === number;
  // A package's own barcode reads that package; the shipment's number reads every package of it.
  const own = orders.flatMap(packagesOf).filter(named);
  const whole = orders.filter(order => folded(order.id) === number);
  if (!own.length && whole.length !== 1) throw new SchemaError(PROVIDER, 'Night Star Express did not identify the requested number');
  const items = own.length ? own : packagesOf(whole[0]!);
  if (!items.length) throw new SchemaError(PROVIDER, 'Night Star Express returned an order without packages');

  const read = items.map((item, index) => readPackage(item, index * 1000, language));
  const seen = new Set<string>();
  const events = read.flatMap(({ scans }) => scans).sort((left, right) => right.at - left.at || right.index - left.index)
    .map(({ event }) => event).filter(event => { const key = JSON.stringify(event); return !seen.has(key) && Boolean(seen.add(key)); });

  // Several packages are delivered once each one is; until then the shipment is where the
  // undelivered package with the newest scan stands.
  const waiting = read.filter(({ stage }) => stage !== 'delivered');
  const current = waiting.length
    ? [...waiting].sort((left, right) => (right.scans[0]?.at ?? 0) - (left.scans[0]?.at ?? 0))[0]!
    : read.find(item => item.scans[0]?.event === events[0]) ?? read[0]!;
  const stage = current.stage;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  const levels = new Set(items.map(item => (isRecord(item.sla) ? clean(item.sla.name, 80) : '')));
  const service = levels.size === 1 ? [...levels][0]! : '';
  const extras = { expected_delivery: null, ...(service ? { service_name: service } : {}) };

  const wording = nightStarStatus(current.status)?.[language];
  const latest = current.scans[0]?.event;
  if (!events.length) {
    if (!stage || !wording) throw new SchemaError(PROVIDER, 'Night Star Express returned a package without a known status');
    return { status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map', last_status_text: wording,
      last_update: null, ...extras, summary_only: true, events: [] };
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest && latest.stage === stage ? latest.description : wording ?? latest?.description,
    last_update: events[0]!.time ?? null,
    ...extras,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
