import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { bypostCode, SHIPMENT_NOTES } from './status.js';

export const PROVIDER = 'Bypost';
export const BYPOST_MAX_BYTES = 1024 * 1024;
// The service the tracking page asks, with the number as `number`.
export const BYPOST_ENDPOINT = 'https://bypost.no/api/track';

/** The page takes a tracking or package number of 6 to 40 letters and digits. */
export function normalizeBypostNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.replace(/\s+/g, '') : '';
  if (!/^[A-Za-z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;

export function bypostJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Bypost answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'Bypost answered with a page instead of its tracking JSON', { cause });
  }
}

const same = (left: unknown, right: string): boolean => typeof left === 'string' && left.replace(/\s+/g, '').toUpperCase() === right.toUpperCase();
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

interface Scan { event: CarrierEvent; at: number; index: number; signer: string }

function weightOf(packages: readonly Record<string, unknown>[]): number | null {
  const weights = packages.map(item => item.weight_kg);
  if (!weights.length || !weights.every((weight): weight is number => typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight < 100_000)) return null;
  return Math.round(weights.reduce((sum, weight) => sum + weight, 0) * 1000) / 1000;
}

/** One package's events, newest first, and the stage its newest staged event gives it. */
function packageScans(item: Record<string, unknown>, offset: number): { scans: Scan[]; stage?: Stage } {
  if (!Array.isArray(item.events) || item.events.length > 500) throw new SchemaError(PROVIDER, 'Bypost returned an invalid history');
  const scans: Scan[] = [];
  for (const [index, row] of item.events.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Bypost returned an incomplete event');
    const code = typeof row.code === 'string' && CODE.test(row.code) ? row.code : '';
    const known = code ? bypostCode(code) : undefined;
    // The page shows the event's own label, else its code's wording, else a bare "update".
    const label = textFromHtml(row.label, 300) || known?.wording || '';
    const detail = textFromHtml(row.description, 500);
    const at = explicitOffsetTime(row.occurred_at);
    if (!at || !(label || code)) throw new SchemaError(PROVIDER, 'Bypost returned an event without a name or clock');
    const location = clean(row.city, 120);
    scans.push({ at: at.timestamp, index: offset + index, signer: clean(row.signature, 120), event: {
      time: at.iso, description: [label || code.replaceAll('_', ' ').toLowerCase(), detail].filter(Boolean).join(': '),
      ...(code ? { provider_code: code } : {}), ...(location ? { location } : {}),
      ...(known?.stage ? { stage: known.stage, stage_source: 'carrier_map' } : {}),
    } });
  }
  // The service lists a package's events oldest first.
  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const stage = scans.find(({ event }) => event.stage)?.event.stage as Stage | undefined;
  return { scans, ...(stage ? { stage } : {}) };
}

export function parseBypost(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeBypostNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.packages) || payload.packages.length > 200 || !payload.packages.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Bypost returned no shipment');
  }
  const status = payload.status == null ? null : typeof payload.status === 'string' && CODE.test(payload.status) ? payload.status : undefined;
  if (status === undefined || typeof payload.source !== 'string') throw new SchemaError(PROVIDER, 'Bypost returned an invalid shipment');
  // The page shows "no updates yet" for these: the number is unknown, or not collected yet.
  if (payload.source === 'none' || (status === null && !payload.packages.length)) throw new NotFoundError(PROVIDER);

  const all = payload.packages as Record<string, unknown>[];
  const own = all.filter(item => same(item.number, number));
  if (!same(payload.number, number) && !own.length) throw new SchemaError(PROVIDER, 'Bypost did not identify the requested number');
  // A package's own number reads that package; the shipment's reads every package.
  const packages = own.length ? own : all;

  const read = packages.map((item, index) => packageScans(item, index * 1000));
  const seen = new Set<string>();
  const events = read.flatMap(({ scans }) => scans).sort((left, right) => right.at - left.at || right.index - left.index)
    .map(({ event }) => event).filter(event => { const key = JSON.stringify(event); return !seen.has(key) && Boolean(seen.add(key)); });

  // Several packages are delivered once each one is; until then the shipment is where its
  // least advanced package's newest scan left it.
  const waiting = read.filter(({ stage }) => stage !== 'delivered');
  const partial = waiting.length > 0 && waiting.length < read.length;
  const deciding = partial
    ? waiting.flatMap(({ scans }) => scans).sort((left, right) => right.at - left.at).find(({ event }) => event.stage)?.event
    : events.find(event => event.stage);
  const scanned = deciding?.stage as Stage | undefined;
  const declared = status ? bypostCode(status)?.stage : undefined;
  // A cancelled shipment is stopped whatever its scans say. No event states an exception ("Avvik"),
  // so the shipment's is newer than its scans, unless they end in a delivery or a return.
  const stopped = status === 'CANCELLED' || (status === 'EXCEPTION' && scanned !== 'delivered' && scanned !== 'returned') ? status : undefined;
  const stage = stopped ? 'exception' : scanned ?? declared;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  const destination = isRecord(payload.destination) ? clean(payload.destination.country_code, 8).toUpperCase() : '';
  // The recipient's postcode and town, as the page shows them.
  const address = isRecord(payload.destination)
    ? [clean(payload.destination.postal_code, 16), clean(payload.destination.city, 120)].filter(Boolean).join(' ') : '';
  const weight = weightOf(packages);
  const detail = packages.length === 1 && isRecord(packages[0]!.detail) ? packages[0]!.detail : undefined;
  const pickupPoint = detail ? clean(detail.pickup_point_name, 160) : '';
  // Who signed: the newest delivery's signature, else the single package's.
  const signer = stage !== 'delivered' ? ''
    : read.flatMap(({ scans }) => scans).sort((left, right) => right.at - left.at).find(({ event }) => event.stage === 'delivered')?.signer
      || (detail ? clean(detail.signature_name, 120) : '');
  const note = (detail ? textFromHtml(detail.status_description, 300) : '') || (status ? SHIPMENT_NOTES[status] ?? bypostCode(status)?.wording ?? '' : '');
  const extras = {
    expected_delivery: null,
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(address ? { receiver_address: address } : {}),
    ...(signer ? { signed_by: signer } : {}),
  };

  if (!events.length) {
    if (!stage || !note) throw new SchemaError(PROVIDER, 'Bypost returned a shipment without a status');
    return { status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map', last_status_text: note,
      last_update: null, ...extras, summary_only: true, events: [] };
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: stopped ? SHIPMENT_NOTES[stopped]! : partial ? deciding?.description ?? note : events[0]!.description!,
    last_update: events[0]!.time ?? null,
    ...extras,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
