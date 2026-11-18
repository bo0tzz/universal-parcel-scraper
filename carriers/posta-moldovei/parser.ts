import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postaMoldoveiStage } from './status.js';

export const PROVIDER = 'Poșta Moldovei';

const MAX_LOGS = 500;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// Domestic items: `D`, a letter, ten digits and the service's two letters.
const DOMESTIC = /^D[A-Z]\d{10}(?:AR|AS|CC|RC|RR)$/;

/**
 * The tracker's mailing search takes UPU S10 item codes, Poșta Moldovei's own and those of
 * the posts that send mail to Moldova, with a valid check digit, and its fourteen-character
 * domestic numbers.
 */
export function normalizePostaMoldoveiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number) || DOMESTIC.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Poșta Moldovei tracks S10 item codes and its domestic numbers');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Poșta Moldovei returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's `created_at`, "2026-07-06T22:00:00Z": the scanning office's wall clock less two
 * hours, whatever the season, labelled UTC. A delivery attempt Moldova dates by day reads
 * 22:00 the evening before in July, when Moldova is three hours ahead of UTC. Adding the two
 * hours back gives the office's wall clock, which keeps no zone: another post's scans keep its
 * own clock.
 */
function wallClock(value: string): string {
  const stamp = STAMP.test(value) ? DateTime.fromISO(value, { zone: 'UTC' }) : null;
  if (!stamp?.isValid || stamp.toFormat("yyyy-MM-dd'T'HH:mm:ss'Z'") !== value) {
    throw new SchemaError(PROVIDER, 'Poșta Moldovei returned an invalid scan time');
  }
  return stamp.plus({ hours: 2 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function scanOf(log: unknown): CarrierEvent {
  if (!isRecord(log)) throw new SchemaError(PROVIDER, 'Poșta Moldovei returned an invalid scan');
  const description = text(log, 'description', 200);
  if (!description) throw new SchemaError(PROVIDER, 'Poșta Moldovei returned a scan without wording');
  const local = wallClock(text(log, 'created_at', 32));
  // "Moldova (the Republic of) - CNT CHISINAU", "Germany - FRANKFURT A DEA IPZ 1", or an
  // office's postcode ("MD2006").
  const location = text(log, 'additional_description', 120);
  const staged = postaMoldoveiStage(description);
  return {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of `GET trimiteri-api.posta.md/public/track/{number}`, which the tracking page
 * makes once its Turnstile check passes: `shipping_logs`, newest first. The reply does not
 * repeat the number; the request names it. The sender's and recipient's names, which some
 * replies carry, and the weight are not read.
 */
export function parsePostaMoldovei(payload: unknown, rawNumber: string): CarrierResult {
  normalizePostaMoldoveiNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.shipping_logs)) throw new SchemaError(PROVIDER, 'Poșta Moldovei returned an invalid reply');
  if (!payload.shipping_logs.length) throw new NoHistoryError(PROVIDER, 'Poșta Moldovei holds no scan of the item yet', { reason: 'portal_not_found' });
  if (payload.shipping_logs.length > MAX_LOGS) throw new SchemaError(PROVIDER, 'Poșta Moldovei returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  payload.shipping_logs.forEach((log) => {
    const event = scanOf(log);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    events.push(event);
  });
  // The service lists scans newest first. Different offices can use different local clocks.

  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
