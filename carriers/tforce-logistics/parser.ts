import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { tforceStage } from './status.js';

export const PROVIDER = 'TForce Logistics';
// A page is about sixteen kilobytes; several packages add a few each.
export const TFORCE_MAX_BYTES = 512 * 1024;

// What the tracker takes: a package id, an order number or a shipper's reference, with a piece
// suffix such as "-1" kept, since the tracker does not match the number without it.
const NUMBER = /^[A-Z0-9](?:[A-Z0-9-]{4,38})[A-Z0-9]$/;
// "1 found in the last 120 days for Package TF…": how many packages, and the number asked.
const FOUND = /^(\d{1,3}) found in the last 120 days for Package (\S{1,60})$/;
const NOT_FOUND = /^No shipments found that match Tracking Number (\S{1,60})$/;
// A row's time: "Aug 20 - 9:53 AM MDT", without a year.
const CLOCK = /^([A-Z][a-z]{2}) (\d{1,2}) - (\d{1,2}):(\d{2}) ([AP]M) ([A-Z]{3,4})$/;
// The North American zones the tracker names, by abbreviation.
const OFFSETS: Readonly<Record<string, string>> = {
  NST: '-03:30', NDT: '-02:30', AST: '-04:00', ADT: '-03:00', EST: '-05:00', EDT: '-04:00', CST: '-06:00', CDT: '-05:00',
  MST: '-07:00', MDT: '-06:00', PST: '-08:00', PDT: '-07:00', AKST: '-09:00', AKDT: '-08:00', HST: '-10:00',
};
// A town and its province or state, then a postal code that is not kept: "Edmonton, AB T6B 3E3".
const PLACE = /^(\p{L}[\p{L} .'-]{0,59}), ([A-Z]{2})(?: (?:[A-Z]\d[A-Z] ?\d[A-Z]\d|\d{5}(?:-\d{4})?))?$/u;
// Rows whose time column holds a value for the row above them, not a time.
const COMPANIONS = new Set(['Status', 'Delivered To']);
// The estimate the tracker can put above the history; not an event.
const ESTIMATE = 'Expected By';
// Firewall and bot check pages, which could stand in for the tracker's page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|g-recaptcha|h-captcha|sucuri_cloudproxy_js|Sucuri WebSite Firewall|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
const MAX_ROWS = 200;
// A scan can come up to a day ahead of the lookup's clock, across zones and clock drift.
const AHEAD_MS = 24 * 60 * 60 * 1000;

/** A number as the tracker takes it, in capitals and without spaces; anything else is not asked for. */
export function tforceNumber(raw: string): string {
  const number = raw.length <= 64 ? raw.trim().toUpperCase().replace(/\s+/g, '') : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TForce Logistics takes a package id, an order number or a reference');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A row's time on the offset its zone names. The tracker gives no year: lookups go back 120
 * days, so the year is the one that puts the scan no later than a day after `now`.
 */
function instantOf(value: string, now: Date): string {
  const match = CLOCK.exec(value);
  const offset = match ? OFFSETS[match[6]!] : undefined;
  const month = match ? MONTHS.indexOf(match[1]!) + 1 : 0;
  const hour = match ? Number(match[3]) : 0;
  if (!match || !offset || !month || hour < 1 || hour > 12 || Number(match[4]) > 59) invalid('TForce Logistics returned an invalid history time');
  const clock = `${String((hour % 12) + (match[5] === 'PM' ? 12 : 0)).padStart(2, '0')}:${match[4]}:00${offset}`;
  const year = now.getUTCFullYear();
  const time = [year, year - 1, year - 2].map((candidate) => {
    const date = calendarDay(candidate, month, Number(match[2]));
    return date ? `${date}T${clock}` : null;
  }).find((candidate) => candidate !== null && Date.parse(candidate) <= now.getTime() + AHEAD_MS);
  return time ?? invalid('TForce Logistics returned an invalid history time');
}

/** The text of one of a row's three columns. */
function column($: CheerioAPI, row: Element, index: number): string {
  return clean($(row).children('div').eq(index).text(), 200);
}

/** The history rows, as the tracker lists them: newest first. */
function historyOf($: CheerioAPI, rows: readonly Element[], now: Date): CarrierEvent[] {
  if (rows.length > MAX_ROWS) invalid('TForce Logistics returned an oversized history');
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if ($(row).children('div').length !== 3) invalid('TForce Logistics returned an unreadable history row');
    const description = column($, row, 0);
    const value = column($, row, 1);
    if (!description) invalid('TForce Logistics returned a history row without its wording');
    if (description === ESTIMATE) continue;
    // A companion row's value, the reason of a return or where the parcel was left, stays with the
    // row above it on the tracker's page; it is no scan of its own.
    if (COMPANIONS.has(description) && !CLOCK.test(value)) continue;
    const place = PLACE.exec(column($, row, 2));
    const stage = tforceStage(description);
    events.push({
      time: instantOf(value, now), description,
      ...(place ? { location: `${place[1]}, ${place[2]}` } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    });
  }
  return events;
}

/** The tracking panel's package rows for the number asked, or what the tracker says instead. */
function rowsOf($: CheerioAPI, html: string, number: string): Element[] {
  const content = $('#trackingContent');
  if (content.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TForce Logistics answered with a block page');
    invalid('TForce Logistics did not return its tracking page');
  }
  // Some old numbers get an empty panel instead of the notice; that says nothing either way.
  if (!clean(content.text(), 20)) throw new IndeterminateError(PROVIDER, 'TForce Logistics returned no answer for the number');
  const notice = clean(content.children('div').first().text(), 200);
  const missing = NOT_FOUND.exec(notice);
  if (missing) {
    if (missing[1]!.toUpperCase() !== number) {
      throw new IndeterminateError(PROVIDER, 'TForce Logistics answered for another number');
    }
    throw new NotFoundError(PROVIDER);
  }
  const header = content.find('.bg-info').toArray();
  const found = header.length === 1 ? FOUND.exec(clean($(header[0]).text(), 200)) : null;
  if (!found) invalid('TForce Logistics returned its tracking page without an answer');
  // The tracker matches the whole number; the header names it as asked.
  if (found[2]!.toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'TForce Logistics answered for another number');
  }
  // An order number or a reference can match several packages, and one alone is no answer for all.
  if (found[1] !== '1') throw new IndeterminateError(PROVIDER, 'TForce Logistics found several packages under the number');
  return content.find('.row.listable').toArray();
}

/**
 * The tracker's page `finalmiletrack/Track?trackingNumber={number}&brand=0` for one number. It
 * names how many packages it found in the last 120 days under the number, then for each its
 * origin and destination with their postal codes, pieces, weight and package id, and its
 * history, newest first: wording, time with its zone and place with its postal code. Companion
 * rows hold a value for the row above them in the time column. Only the count, the number asked
 * and the history are read; places lose their postal codes.
 */
export function parseTForce(html: string, raw: string, now: Date = new Date()): CarrierResult {
  const number = tforceNumber(raw);
  const $ = load(html);
  const events = historyOf($, rowsOf($, html, number), now);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current?.description ?? events[0]!.description ?? null,
    last_update: events[0]!.time ?? null,
    events,
  };
}
