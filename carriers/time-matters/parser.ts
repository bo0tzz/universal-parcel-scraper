import { ChallengeError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { windowEstimate } from '../../core/result/window.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { timeMattersPoint, timeMattersStatus } from './status.js';

export const PROVIDER = 'time:matters';
export const TIME_MATTERS_MAX_BYTES = 1024 * 1024;
export type TimeMattersLanguage = 'en' | 'de' | 'fr';

/**
 * The tracking form takes S and digits, or eight or nine digits, each with a rebooking's dash
 * and digits after it. A number can reach the adapter without that dash.
 */
export function normalizeTimeMattersNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^(?:S\d{2,20}|\d{8,12})(?:-\d{0,3})?$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

/** The address the tracking page reads one order's status from. */
export function timeMattersUrl(number: string): string {
  return `https://booking.time-matters.com/services/css-orders/orders/${encodeURIComponent(number)}/status/basic`;
}

// A rebooking suffix is part of the order identity.
const folded = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).toUpperCase().replace(/[\s.]/g, '') : '');
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;
const POINT_TYPE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const CANCELLATIONS = new Set(['NONE', 'REQUESTED', 'PROCESSED', 'REJECTED']);
// The stops an order starts and ends at; a transport, customs or handling entry lies between two of them.
const STOPS = new Set(['LOCATION', 'AIRPORT', 'TRAIN_STATION', 'SECURITY_PARTNER']);

/** Read one reply of the status service: an order, a missing one, or a failure of its own kind. */
export function parseTimeMattersReply(status: number, body: string, rawNumber: string, language: TimeMattersLanguage = 'en'): CarrierResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'time:matters answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'time:matters answered with a page instead of its tracking JSON', { cause });
  }
  if (status === 404) {
    if (isRecord(payload) && payload.title === 'no such order found') throw new NotFoundError(PROVIDER);
    throw new TransportError(PROVIDER, 'time:matters tracking service is unavailable', { status });
  }
  return parseTimeMatters(payload, rawNumber, language);
}

interface Scan { event: CarrierEvent; at: number; index: number }
type Row = Record<string, unknown>;

/** A list the reply may leave out, of at most `limit` objects. */
function rows(value: unknown, limit: number, what: string): Row[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > limit || !value.every(isRecord)) throw new SchemaError(PROVIDER, `time:matters returned an invalid ${what}`);
  return value;
}

/** An airport by its town and code, a station by its name; an address is never read. */
function placeOf(stop: Row): string {
  if (stop.entityType === 'TRAIN_STATION') return clean(stop.name, 80);
  if (stop.entityType !== 'AIRPORT') return '';
  const code = typeof stop.iataCode === 'string' && /^[A-Z]{3}$/.test(stop.iataCode) ? stop.iataCode : '';
  const town = isRecord(stop.address) ? clean(stop.address.city, 80) : '';
  return town && code ? `${town} (${code})` : town || code || clean(stop.name, 80);
}

export function parseTimeMatters(payload: unknown, rawNumber: string, language: TimeMattersLanguage = 'en'): CarrierResult {
  const number = normalizeTimeMattersNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'time:matters returned no order');
  // The order is asked by its own address; a reply that names an order must name the requested one.
  if (payload.orderNumber != null && folded(payload.orderNumber) !== folded(number)) {
    throw new SchemaError(PROVIDER, 'time:matters did not identify the requested number');
  }
  const stated = [payload.basicStatus, payload.status].find((value): value is string => typeof value === 'string' && value !== '') ?? '';
  const cancellation = payload.cancellationStatus == null ? 'NONE' : payload.cancellationStatus;
  if (!timeMattersStatus(stated) || typeof cancellation !== 'string' || !CANCELLATIONS.has(cancellation)) {
    throw new SchemaError(PROVIDER, 'time:matters returned an order without a known status');
  }
  // The page replaces the status of an order whose cancellation went through.
  const name = cancellation === 'PROCESSED' ? 'CANCELLED' : stated;
  const state = timeMattersStatus(name)!;

  const routing = rows(payload.routing, 60, 'routing');
  const last = [...routing].reverse().find(stop => typeof stop.entityType === 'string' && STOPS.has(stop.entityType));
  const toDoor = last?.entityType === 'LOCATION';
  const scans: Scan[] = [];
  let index = 0;
  for (const stop of routing) {
    const place = placeOf(stop);
    for (const point of rows(stop.trackingPoints, 60, 'tracking point list')) {
      index += 1;
      const type = typeof point.type === 'string' && POINT_TYPE.test(point.type) ? point.type : '';
      if (!type) throw new SchemaError(PROVIDER, 'time:matters returned a tracking point without a type');
      // A point that is only scheduled or estimated has not happened.
      if (point.actual == null || point.actual === '') continue;
      const at = explicitOffsetTime(point.actual);
      if (!at) throw new SchemaError(PROVIDER, 'time:matters returned an event clock without an offset');
      const known = timeMattersPoint(type);
      scans.push({ at: at.timestamp, index, event: {
        time: at.iso, description: known?.[language] ?? type.replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
        ...(place ? { location: place } : {}), provider_code: type,
        ...(known ? { stage: known.stage, stage_source: 'carrier_map' } : {}),
      } });
    }
  }

  // The page dates "Delivered" by the hand-over at the last stop, or by the arrival at a delivery address.
  const ending = last ? rows(last.trackingPoints, 60, 'tracking point list') : [];
  const closing = ending.find(point => Boolean(point.handover) && point.actual)
    ?? (toDoor ? ['Arrival', 'Available'].map(type => ending.find(point => point.type === type && point.actual)).find(Boolean) : undefined);
  const mark = (code: string, at: { iso: string; timestamp: number } | null): void => {
    const status = timeMattersStatus(code)!;
    if (at) scans.push({ at: at.timestamp, index: 10_000, event: { time: at.iso, description: status[language], provider_code: code, stage: status.stage, stage_source: 'carrier_map' } });
  };
  if (name === 'FINISHED') mark(name, closing ? explicitOffsetTime(closing.actual) : null);
  // The page reads the cancellation's clock, which states no offset, as UTC.
  const cancelled = clean(payload.cancellationProcessTime, 40);
  if (name === 'CANCELLED' && cancellation === 'PROCESSED' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/.test(cancelled)) mark(name, explicitOffsetTime(`${cancelled}Z`));

  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const events = scans.map(({ event }) => event);

  // An order for a door that waits at its last station is still on its way; one that ends there is ready to collect.
  const stage: Stage = name === 'PACKAGE_CLAIM' && (toDoor || (typeof payload.transportType === 'string' && payload.transportType.endsWith('TO_DOOR')))
    ? 'in_transit' : state.stage;
  // "Delivery time" on the page: the estimated, else the scheduled, arrival at the delivery address.
  const promised = toDoor && (stage === 'registered' || stage === 'in_transit')
    ? ['Arrival', 'Available'].flatMap(type => ending.filter(point => point.type === type)
      .flatMap(point => [point.estimated, point.planned])).find(value => typeof value === 'string' && value !== '') : undefined;
  const moment = promised === undefined ? null : explicitOffsetTime(promised)?.iso ?? clean(promised, 40);
  const estimate = moment ? windowEstimate(moment, moment) : { expected_delivery: null };
  const delivered = name === 'FINISHED' ? events.find(event => event.provider_code === name)?.time : undefined;

  const summary = { status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
    last_status_text: state[language], ...(events[0]?.provider_code === name ? {} : { provider_code: name }) };
  if (!events.length) return { ...summary, last_update: null, ...estimate, summary_only: true, events: [] };
  return { ...summary, last_update: events[0]!.time ?? null, ...estimate, ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}
