import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { statusMap, hrxEvent } from './status.js';

export const PROVIDER = 'HRX';
export const HRX_MAX_BYTES = 512_000;
// The service the E-com Parcel tracking page asks, with the number in its path.
export const HRX_ENDPOINT = 'https://wop.hrx.eu/api/v1/public/orders/';

/** HRX publishes no layout, so a number is one token of letters, digits, hyphens and underscores. */
export function normalizeHrxNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{4,49}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

// A number reaches the adapter in capitals and without separators, so the order's own is compared the same way.
const folded = (value: string): string => value.toUpperCase().replace(/[\s.-]/g, '');

const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;

/** Read one reply of the public order service: an order, a missing one, or a failure of its own kind. */
export function parseHrxReply(status: number, body: string, rawNumber: string): CarrierResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'HRX answered with a verification page', { cause });
    // The site answers a path it does not serve with its application page.
    throw new SchemaError(PROVIDER, 'HRX answered with a page instead of its tracking JSON', { cause });
  }
  if (status === 404) {
    if (isRecord(payload) && payload.error === 'not_found') throw new NotFoundError(PROVIDER);
    throw new TransportError(PROVIDER, 'HRX tracking service is unavailable', { status });
  }
  return parseHrx(payload, rawNumber);
}

function weightOf(value: unknown): number | null {
  const weight = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,5}(?:\.\d{1,6})?$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(weight) && weight > 0 && weight < 100_000 ? Math.round(weight * 1000) / 1000 : null;
}

export function parseHrx(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeHrxNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'HRX returned no order');
  if (payload.error != null) throw new IndeterminateError(PROVIDER, 'HRX did not confirm the order');
  if (folded(clean(payload.tracking_number, 64)) !== folded(number)) throw new SchemaError(PROVIDER, 'HRX did not identify the requested number');
  if (!Array.isArray(payload.tracking_events) || payload.tracking_events.length > 500) throw new SchemaError(PROVIDER, 'HRX returned an invalid history');
  if (!payload.tracking_events.length) throw new NoHistoryError(PROVIDER, 'HRX returned an order without events', { reason: 'listed' });

  const scans: { event: CarrierEvent; at: number; index: number }[] = [];
  const seen = new Set<string>();
  for (const [index, row] of payload.tracking_events.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'HRX returned an incomplete event');
    const name = typeof row.event === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(row.event) ? row.event : '';
    const at = explicitOffsetTime(row.timestamp);
    if (!name || !at) throw new SchemaError(PROVIDER, 'HRX returned an event without a name or clock');
    const known = hrxEvent(name);
    const location = clean(row.location, 200);
    const event: CarrierEvent = { time: at.iso, description: known?.wording ?? name.replaceAll('_', ' '), provider_code: name,
      ...(location ? { location } : {}), ...(known?.stage ? { stage: known.stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); scans.push({ event, at: at.timestamp, index }); }
  }
  // Newest first; events on one clock keep the reply's order, reversed.
  const events = scans.sort((left, right) => right.at - left.at || right.index - left.index).map(({ event }) => event);
  const stage = leadingScan(events, statusMap)?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  const country = clean(payload.delivery_location_country, 8).toUpperCase();
  const weight = weightOf(payload.weight_kg);
  // The order's delivery address: the recipient's door, or the locker or point it goes to.
  const address = [clean(payload.delivery_location_address, 200), clean(payload.delivery_location_city, 100)].filter(Boolean).join('\n');

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description,
    last_update: events[0]!.time ?? null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(address ? { receiver_address: address } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}
