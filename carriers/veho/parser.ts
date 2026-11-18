import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { withTieOrder } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { statusMap, vehoEvent } from './status.js';

export const PROVIDER = 'Veho';
export const ORIGIN = 'https://track.shipveho.com';
/** The tracker's page, which obtains the guest attestation as it loads. */
export const PAGE = `${ORIGIN}/`;
export const API = 'https://esus.graph.shipveho.com/graphql';
/** The name the browser service's helper gives the attestation it captures on the page. */
export const ATTESTATION = 'https://content-firebaseappcheck.googleapis.com/v1/projects/veho-consumer-mobile/';
export const MAX_BYTES = 1_000_000;

// The tracker's own query, without the recipient's address, the support case and the delivery PIN.
export const QUERY = 'query getOrderByTrackingIdCWA($trackingId: String!) { order: getOrderByTrackingIdCWA(trackingId: $trackingId, '
  + 'includePickups: false, includeConsumerSupportCases: false) { clientDisplayName timeZone deliveryDateInfo { date dateType } '
  + 'packages { trackingId timeZone deliveryTimeWindow { startsAt endsAt } eventLog { operation timestamp message facility { city state } } } } }';

export const vehoRequest = (number: string): string => JSON.stringify({ operationName: 'getOrderByTrackingIdCWA',
  variables: { trackingId: number }, query: QUERY });

/** A Veho tracking id, `VH` and twelve letters or digits; anything else is asked as a label barcode. */
const TRACKING_ID = /^VH[A-Z0-9]{12}$/;

/** The tracker takes a tracking id or a sender's label barcode: one token of letters and digits. */
export function normalizeVehoNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

const unauthorized = (errors: readonly unknown[]): boolean => errors.some(error => isRecord(error)
  && /unauthori[sz]ed/i.test(`${clean(error.errorType, 100)} ${clean(error.message, 200)}`));

function instant(value: unknown): string | null {
  return typeof value === 'string' ? explicitOffsetTime(value)?.iso ?? null : null;
}

/**
 * Read the order service's reply to a guest query made for `rawNumber`. The reply names packages by
 * tracking id alone: a tracking id must be among them, and a label barcode stands for the only
 * package of its order, which the result names in `canonical_tracking_number`.
 */
export function parseVeho(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeVehoNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Veho returned no tracking reply');
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const data = payload.data;
  if (!isRecord(data) || !('order' in data)) {
    if (unauthorized(errors)) throw new ChallengeError(PROVIDER, 'Veho refused the guest attestation');
    throw new SchemaError(PROVIDER, 'Veho returned no order field');
  }
  const order = data.order;
  if (order === null) {
    // A refused or failed query has no order either: only a clean reply says the number is unknown.
    if (unauthorized(errors)) throw new ChallengeError(PROVIDER, 'Veho refused the guest attestation');
    if (errors.length) throw new IndeterminateError(PROVIDER, 'Veho did not confirm the order');
    throw new NotFoundError(PROVIDER);
  }
  if (!isRecord(order) || !Array.isArray(order.packages) || !order.packages.length || order.packages.length > 100) {
    throw new SchemaError(PROVIDER, 'Veho returned an invalid order');
  }
  const packages = order.packages.map(row => {
    if (!isRecord(row) || typeof row.trackingId !== 'string' || !/^[A-Za-z0-9]{4,40}$/.test(row.trackingId)) {
      throw new SchemaError(PROVIDER, 'Veho returned a package without a tracking id');
    }
    return { row, id: row.trackingId.toUpperCase() };
  });
  const named = packages.filter(candidate => candidate.id === number);
  if (named.length > 1) throw new SchemaError(PROVIDER, 'Veho returned the tracking id twice');
  let pkg = named[0];
  if (!pkg) {
    if (TRACKING_ID.test(number)) throw new SchemaError(PROVIDER, 'Veho did not identify the requested tracking id');
    if (packages.length > 1) throw new IndeterminateError(PROVIDER, 'Veho holds several packages under this barcode');
    pkg = packages[0]!;
  }
  const log = pkg.row.eventLog;
  if (!Array.isArray(log) || log.length > 500) throw new SchemaError(PROVIDER, 'Veho returned an invalid history');
  if (!log.length) throw new NoHistoryError(PROVIDER, 'Veho returned a package without events', { reason: 'listed' });
  const sender = clean(order.clientDisplayName, 100);
  const scans: { event: CarrierEvent; at: number; index: number }[] = [];
  const seen = new Set<string>();
  for (const [index, row] of log.entries()) {
    if (!isRecord(row) || typeof row.operation !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(row.operation)) {
      throw new SchemaError(PROVIDER, 'Veho returned an event without an operation');
    }
    const time = instant(row.timestamp);
    if (!time) throw new SchemaError(PROVIDER, 'Veho returned an event without a clock');
    const known = vehoEvent(row.operation, clean(row.message, 100) || null, sender);
    const facility = isRecord(row.facility) ? [clean(row.facility.city, 80), clean(row.facility.state, 40)].filter(Boolean).join(', ') : '';
    const event: CarrierEvent = { time, description: known.wording, provider_code: row.operation,
      ...(facility ? { location: facility } : {}), ...(known.stage ? { stage: known.stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); scans.push({ event, at: Date.parse(time), index }); }
  }
  // Newest first, as the reply lists them; events on one clock keep its order.
  const events = scans.sort((left, right) => right.at - left.at || left.index - right.index).map(({ event }) => event);
  withTieOrder(events);
  const stage = leadingScan(events, statusMap)?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  const zone = clean(pkg.row.timeZone, 64) || clean(order.timeZone, 64);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description,
    last_update: events[0]!.time ?? null,
    ...(stage === 'delivered' || stage === 'returned' ? { expected_delivery: null } : estimate(order, pkg.row)),
    ...(delivered ? { delivered_at: delivered.time } : {}),
    ...(sender ? { sender_name: sender } : {}),
    ...(pkg.id !== number ? { canonical_tracking_number: pkg.id } : {}),
    ...(/^[A-Za-z]+(?:\/[A-Za-z_+-]+){1,2}$/.test(zone) ? { timezone: zone } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}

/**
 * The package's delivery window once it has one, else the order's date: an estimated or
 * expected day, or a delay for which Veho names no new day.
 */
function estimate(order: Record<string, unknown>, pkg: Record<string, unknown>): Pick<CarrierResult,
  'expected_delivery' | 'expected_delivery_from' | 'expected_delivery_withdrawn'> {
  const window = isRecord(pkg.deliveryTimeWindow) ? pkg.deliveryTimeWindow : {};
  const [from, to] = [instant(window.startsAt), instant(window.endsAt)];
  if (from && to && Date.parse(from) < Date.parse(to)) return { expected_delivery_from: from, expected_delivery: to };
  const info = isRecord(order.deliveryDateInfo) ? order.deliveryDateInfo : {};
  if (info.dateType === 'Delayed') return { expected_delivery: null, expected_delivery_withdrawn: true };
  const parts = typeof info.date === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(info.date);
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  return { expected_delivery: day && (info.dateType === 'Estimated' || info.dateType === 'Expected') ? day : null };
}
