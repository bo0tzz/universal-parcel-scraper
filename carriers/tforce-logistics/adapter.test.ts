import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TFORCE_TRACK, tforceLookupUrl, TForceTracker } from './adapter.js';
import { parseTForce, tforceNumber } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
/** The number a fixture's header or notice names. */
const named = (html: string) => /(?:for Package|Tracking Number)\s*<span[^>]*>\s*(\S+)\s*<\/span>/.exec(html)![1]!;
const RETURNED = fixture('returned');
const NOT_FOUND = fixture('not-found');
const NUMBER = named(RETURNED);
const NOW = new Date('2026-11-16T10:00:00Z');
const reply = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html;charset=utf-8', ...init.headers } });
const answering = (respond: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => respond());
const tracker = (fetcher: typeof fetch) => new TForceTracker({ fetcher, now: () => NOW });
const rows = (result: ReturnType<typeof parseTForce>) => result.events!.map((event) =>
  [event.time, event.description, event.location ?? null, event.stage ?? null]);
/** The returned package's page with its rows' times and the header's count changed. */
const withTime = (html: string, from: string, to: string) => html.replace(`>${from}<`, `>${to}<`);

describe('TForce Logistics final mile tracker', () => {
  it('asks for the whole number, piece suffix included, through the supplied transport', async () => {
    const fetcher = answering(() => reply(RETURNED));
    await expect(tracker(fetcher).fetch(` ${NUMBER.toLowerCase()} `)).resolves.toMatchObject({ status: 'exception' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(tforceLookupUrl(NUMBER));
    expect(String(url)).toBe(`${TFORCE_TRACK}?trackingNumber=${NUMBER}&brand=0`);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), redirect: 'manual', headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
    expect(tforceNumber('cd1234567-1')).toBe('CD1234567-1');
    for (const input of ['TF1', 'TF 1234<5678>', '-TF12345', 'X'.repeat(41)]) expect(() => tforceNumber(input), input).toThrow();
  });

  it('reads each row on the offset its zone names, without postal codes or companion rows', () => {
    const result = parseTForce(RETURNED, NUMBER, NOW);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Return to Sender', last_update: '2026-08-20T09:53:00-06:00' });
    expect(rows(result)).toEqual([
      ['2026-08-20T09:53:00-06:00', 'Return to Sender', 'Grande Prairie, AB', 'returned'],
      ['2026-07-28T07:38:00-06:00', 'Received At Delivery Facility', 'Edmonton, AB', 'in_transit'],
      ['2026-07-24T21:35:00-04:00', 'Received At Sort Facility', null, 'in_transit'],
      ['2026-07-23T10:37:00-06:00', 'Manifested By Shipper', null, 'registered'],
    ]);
    const json = JSON.stringify(result);
    for (const hidden of ['T8V', 'T6B', 'T5V', 'Not Performed', 'Lbs', 'stopId']) expect(json).not.toContain(hidden);
  });

  it('dates scans in the year that puts them before the lookup, across the new year', () => {
    const december = withTime(RETURNED, 'Aug 20 - 9:53 AM MDT', 'Dec 30 - 11:05 PM PST');
    const result = parseTForce(december, NUMBER, new Date('2027-01-04T12:00:00Z'));
    expect(result.events![0]!.time).toBe('2026-12-30T23:05:00-08:00');
    expect(result.events![1]!.time).toBe('2026-07-28T07:38:00-06:00');
    // A scan a few hours ahead of the lookup's clock stays in its year.
    expect(parseTForce(withTime(RETURNED, 'Aug 20 - 9:53 AM MDT', 'Nov 16 - 11:30 PM HST'), NUMBER, NOW).events![0]!.time)
      .toBe('2026-11-16T23:30:00-10:00');
  });

  it('answers an unknown number with not found and keeps other answers and changed pages apart', async () => {
    const missing = named(NOT_FOUND);
    await expect(tracker(answering(() => reply(NOT_FOUND))).fetch(missing)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(tracker(answering(() => reply(NOT_FOUND))).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    const blank = NOT_FOUND.replace(/<div style="padding:4px;">[\s\S]*?<\/div>/, '');
    await expect(tracker(answering(() => reply(blank))).fetch(missing)).rejects.toMatchObject({ kind: 'indeterminate' });
    const several = RETURNED.replace(/(<span class="badge[^>]*>)\s*1\s*</, '$12<');
    expect(() => parseTForce(several, NUMBER, NOW)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTForce(RETURNED, `${NUMBER}-1`, NOW)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const changed of [withTime(RETURNED, 'Jul 28 - 7:38 AM MDT', 'Jul 28 - 7:38 AM CEST'),
      withTime(RETURNED, 'Jul 28 - 7:38 AM MDT', '2026-07-28 07:38'), '<html><title>Final Mile Track</title><body>Down</body></html>']) {
      expect(() => parseTForce(changed, NUMBER, NOW)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps the firewall’s country block, other blocks and broken replies distinct from a missing package', async () => {
    const geo = () => reply('<html><title>Sucuri WebSite Firewall - Access Denied</title></html>', { status: 403, headers: { 'x-sucuri-block': 'GEO02' } });
    await expect(tracker(answering(geo)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', message: expect.stringContaining('country') });
    await expect(tracker(answering(() => reply('<html><title>Access Denied</title></html>'))).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker(answering(() => reply(' '))).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(tracker(answering(() => reply('gone', { status: 404 }))).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(tracker(answering(() => reply(null, { status: 429 }))).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('sends a lookup that failed to reach the tracker once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(RETURNED));
    const provider = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(provider.track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'returned' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stages the tracker’s wordings whole', () => {
    expect(statusMapAnswer({ carrier: 'tforce-logistics', providerCode: null, description: 'Received At Delivery Facility' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'tforce-logistics', providerCode: null, description: 'Status' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});

it('sends the piece suffix through the facade and requires it in the reply', async () => {
  const number = 'TF' + '0'.repeat(8) + '-1';
  const html = RETURNED.replaceAll(NUMBER, number);
  const fetcher = answering(() => reply(html));
  await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'tforce-logistics', number });
  expect(String(fetcher.mock.calls[0]![0])).toBe(tforceLookupUrl(number));
  expect(() => parseTForce(html.replaceAll(number, number.replace('-', '')), number, NOW)).toThrow();
});
