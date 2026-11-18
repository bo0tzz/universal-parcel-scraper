import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEnvironment } from '../../core/adapter/index.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { TransportError } from '../../core/errors/index.js';
import { STAGES } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecord } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VehoTracker } from './adapter.js';
import { attestInBrowser } from './browser.js';
import { API, ATTESTATION, normalizeVehoNumber, PAGE, parseVeho, QUERY } from './parser.js';
import { statusMap, vehoEvent } from './status.js';

const NUMBER = 'VH0SYNTHETIC01';
const BARCODE = 'VEHOSYN000000001';
const TOKEN = `${'a'.repeat(20)}.${'b'.repeat(40)}.${'c'.repeat(30)}`;
const OTHER_TOKEN = `${'d'.repeat(20)}.${'e'.repeat(40)}.${'f'.repeat(30)}`;
const PROXY = 'http://user:PRIVATE@proxy.test:8000';
const ENDPOINT = 'ws://browser.test/PRIVATE';

vi.mock('./browser.js', () => ({ attestInBrowser: vi.fn() }));
afterEach(() => { vi.mocked(attestInBrowser).mockReset(); });
/** The private browser's answers to its successive reads. */
const privately = (...replies: (number | Error)[]) => {
  for (const reply of replies) {
    if (reply instanceof Error) vi.mocked(attestInBrowser).mockRejectedValueOnce(reply);
    else vi.mocked(attestInBrowser).mockResolvedValueOnce({ status: reply, truncated: false,
      body: reply === 200 ? JSON.stringify({ token: TOKEN, ttl: '3600s' }) : null });
  }
};
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/order.json', import.meta.url), 'utf8'));
const changed = (edit: (order: ReturnType<typeof fixture>['data']['order']) => void) => { const data = fixture(); edit(data.data.order); return data; };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as {
  entries: { code: string; wording: string; stage: string | null }[] };
const UNAUTHORIZED = { errors: [{ errorType: 'UnauthorizedException', message: 'You are not authorized to make this call.' }] };

const attestation = (status = 200, body: unknown = { token: TOKEN, ttl: '3600s' }) => ({ url: ATTESTATION, status, headers: {},
  body: status === 200 ? typeof body === 'string' ? body : JSON.stringify(body) : null, truncated: false, base64Encoded: false, error: null });
/** A browser service that answers each read with the next captures, and the requests it was sent. */
function browser(...reads: unknown[][]) {
  const requests: Record<string, unknown>[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    return json({ tier: 3, statusCode: 200, html: '', capturedResponses: reads[Math.min(requests.length, reads.length) - 1] });
  });
  return { trawl: new TrawlClient('http://browser.test', fetcher), requests };
}
function setup(options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; env?: Record<string, string>; now?: () => number } = {}) {
  const records: StepRecord[] = [];
  const fetcher = vi.fn<typeof fetch>(options.fetcher ?? (async () => json(fixture())));
  const environment: AdapterEnvironment = { env: options.env ?? {}, fetcher, trawl: options.trawl ?? null, browserExecutablePath: null,
    recorder: { ...NOOP_RECORDER, step: record => { records.push(record); } } };
  return { tracker: new VehoTracker(environment, options.now), fetcher, records, environment };
}

describe('Veho parser', () => {
  it('reads the package newest first with stated instants, labels, facilities and the sender', () => {
    const result = parseVeho(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-05T18:18:55.073Z', delivered_at: '2026-03-05T18:18:55.073Z',
      expected_delivery: null, sender_name: 'Synthetic Outfitters', timezone: 'America/New_York' });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.events!.map(event => [event.provider_code, event.stage])).toEqual([['delivered', 'delivered'],
      ['pickedUpFromVeho', 'out_for_delivery'], ['PackageHadDeliveryIssue', 'failed_attempt'], ['pickedUpFromVeho', 'out_for_delivery'],
      ['PackageArrivedAtFacility', 'in_transit'], ['PackageDepartedFromFacility', 'in_transit'], ['droppedOffAtVeho', 'in_transit'],
      ['pickedUpFromClient', 'accepted'], ['created', 'registered']]);
    expect(result.events![2]).toEqual({ time: '2026-03-04T22:10:00Z', description: 'Delivery issue: Driver could not access delivery address.',
      provider_code: 'PackageHadDeliveryIssue', stage: 'failed_attempt', stage_source: 'carrier_map' });
    expect(result.events![4]).toMatchObject({ description: 'At Veho facility', location: 'Synthville, GA' });
    expect(result.events![7]!.description).toBe('Departed Synthetic Outfitters facility');
    expect(parseVeho(changed(order => { order.clientDisplayName = ''; }), NUMBER).events![7]!.description).toBe("Departed the sender's facility");
    expect(parseVeho(changed(order => { order.clientDisplayName = ''; }), NUMBER).sender_name).toBeUndefined();
  });

  it('tells an unknown number from a refused and a failed query', () => {
    expect(() => parseVeho({ data: { order: null } }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const reply of [{ data: { order: null }, ...UNAUTHORIZED }, UNAUTHORIZED, { data: null, ...UNAUTHORIZED },
      { data: { order: null }, errors: [{ errorType: 'Unauthorized', message: 'Not Authorized to access order on type Query' }] }]) {
      expect(() => parseVeho(reply, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(() => parseVeho({ data: { order: null }, errors: [{ errorType: 'InternalFailure', message: 'synthetic' }] }, NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const reply of [null, [], 'order', {}, { data: {} }, { data: null }, { data: { order: 'x' } }, { data: { order: {} } },
      { data: { order: { packages: [] } } }, { errors: [{ message: 'Validation error' }] }]) {
      expect(() => parseVeho(reply, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseVeho(changed(order => { order.packages[0].eventLog = []; }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
  });

  it('binds a tracking id to its own package and a barcode to the only package of its order', () => {
    const second = { ...fixture().data.order.packages[0], trackingId: 'VH0SYNTHETIC02',
      eventLog: [{ operation: 'created', timestamp: '2026-03-01T10:00:00.000Z', message: null, facility: null }] };
    const two = changed(order => { order.packages.unshift(second); });
    expect(parseVeho(two, NUMBER).events).toHaveLength(9);
    expect(parseVeho(two, 'VH0SYNTHETIC02')).toMatchObject({ current_stage: 'registered', events: [{ provider_code: 'created' }] });
    expect(parseVeho(fixture(), NUMBER.toLowerCase()).events).toHaveLength(9);
    expect(() => parseVeho(fixture(), 'VH0SYNTHETIC09')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseVeho(changed(order => { order.packages.push(order.packages[0]); }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(parseVeho(fixture(), BARCODE)).toMatchObject({ canonical_tracking_number: NUMBER, current_stage: 'delivered' });
    expect(() => parseVeho(two, BARCODE)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const id of [null, '', 'VH 1', 'x'.repeat(41)]) {
      expect(() => parseVeho(changed(order => { order.packages[0].trackingId = id; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('gives the delivery window, else the estimated or expected day, and withdraws an estimate on a delay', () => {
    const open = (edit: (order: ReturnType<typeof fixture>['data']['order']) => void) => parseVeho(changed(order => {
      order.packages[0].eventLog.splice(0, 2); edit(order);
    }), NUMBER);
    expect(open(() => {})).toMatchObject({ current_stage: 'failed_attempt', status: 'exception', expected_delivery: '2026-03-06' });
    expect(open(order => { order.deliveryDateInfo.dateType = 'Estimated'; }).expected_delivery).toBe('2026-03-06');
    const window = open(order => { order.packages[0].deliveryTimeWindow = { startsAt: '2026-03-06T17:00:00.000Z', endsAt: '2026-03-06T21:00:00.000Z' }; });
    expect(window).toMatchObject({ expected_delivery_from: '2026-03-06T17:00:00Z', expected_delivery: '2026-03-06T21:00:00Z' });
    const delayed = open(order => { order.deliveryDateInfo.dateType = 'Delayed'; });
    expect(delayed).toMatchObject({ expected_delivery: null, expected_delivery_withdrawn: true });
    for (const edit of [(order: ReturnType<typeof fixture>['data']['order']) => { order.deliveryDateInfo = null; },
      (order: ReturnType<typeof fixture>['data']['order']) => { order.deliveryDateInfo.date = '06/03/2026'; },
      (order: ReturnType<typeof fixture>['data']['order']) => { order.deliveryDateInfo.dateType = 'Synthetic'; },
      (order: ReturnType<typeof fixture>['data']['order']) => { order.packages[0].deliveryTimeWindow = { startsAt: '2026-03-06T21:00:00.000Z', endsAt: '2026-03-06T17:00:00.000Z' }; order.deliveryDateInfo = null; }]) {
      const result = open(edit);
      expect(result.expected_delivery).toBeNull();
      expect(result.expected_delivery_from).toBeUndefined();
      expect(result.expected_delivery_withdrawn).toBeUndefined();
    }
    const done = parseVeho(changed(order => { order.deliveryDateInfo.dateType = 'Delayed'; }), NUMBER);
    expect(done.expected_delivery).toBeNull();
    expect(done.expected_delivery_withdrawn).toBeUndefined();
  });

  it('keeps an operation the tracker does not name without a stage, drops repeats and caps the history', () => {
    const row = (operation: string, timestamp: string) => ({ operation, timestamp, message: null, facility: null });
    const unnamed = parseVeho(changed(order => { order.packages[0].eventLog = [row('syntheticOperation', '2026-03-02T09:15:00.000Z')]; }), NUMBER);
    expect(unnamed).toMatchObject({ status: 'unknown', last_status_text: 'Update received' });
    expect(unnamed.current_stage).toBeUndefined();
    expect(unnamed.events![0]).toEqual({ time: '2026-03-02T09:15:00Z', description: 'Update received', provider_code: 'syntheticOperation' });
    const same = changed(order => { order.packages[0].eventLog = [row('PackageDepartedFromFacility', '2026-03-02T09:00:00.000Z'),
      row('PackageArrivedAtFacility', '2026-03-02T09:00:00.000Z'), row('PackageArrivedAtFacility', '2026-03-02T09:00:00.000Z'),
      row('created', '2026-03-01T09:00:00.000Z')]; });
    expect(parseVeho(same, NUMBER).events!.map(event => [event.provider_code, event.tie_order]))
      .toEqual([['PackageDepartedFromFacility', 1], ['PackageArrivedAtFacility', 0], ['created', undefined]]);
    const long = changed(order => { order.packages[0].eventLog = Array.from({ length: 120 }, (_, index) => row('PackageArrivedAtFacility',
      `2026-03-02T09:${String(index % 60).padStart(2, '0')}:${String(Math.floor(index / 60)).padStart(2, '0')}.000Z`)); });
    expect(parseVeho(long, NUMBER)).toMatchObject({ history_truncated: true, events: expect.objectContaining({ length: 100 }) });
  });

  it('rejects a clock without an offset, a malformed event and an oversized history', () => {
    for (const edit of [(log: Record<string, unknown>[]) => { log[0]!.timestamp = '2026-03-05T18:18:55'; },
      (log: Record<string, unknown>[]) => { log[0]!.timestamp = 1772435700; }, (log: Record<string, unknown>[]) => { log[0]!.timestamp = '2026-02-31T09:15:00Z'; },
      (log: Record<string, unknown>[]) => { log[0]!.operation = 'Not A Name'; }, (log: Record<string, unknown>[]) => { log[0]!.operation = null; },
      (log: Record<string, unknown>[]) => { (log as unknown[])[0] = null; }, (log: Record<string, unknown>[]) => { log.push(...Array(500).fill(log[0])); }]) {
      expect(() => parseVeho(changed(order => { edit(order.packages[0].eventLog); }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseVeho(changed(order => { order.packages[0].eventLog = {}; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('stages every operation of the catalogue as the map does, and an issue by the reason the driver met', () => {
    expect(statuses.entries).toHaveLength(34);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording))).toBe(entry.stage ?? undefined);
      if (entry.stage) expect(STAGES).toContain(entry.stage);
      if (!entry.wording.startsWith('Delivery issue:')) {
        expect(vehoEvent(entry.code, null, '')).toEqual({ wording: entry.wording, ...(entry.stage ? { stage: entry.stage } : {}) });
      }
    }
    expect(statuses.entries.filter(entry => !entry.stage).map(entry => entry.code)).toEqual(statusMap.gaps.map(gap => gap.code));
    expect(vehoEvent('PackageHadDeliveryIssue', 'CustomerRefused', '')).toEqual({ wording: 'Delivery issue: Driver reported delivery was refused', stage: 'failed_attempt' });
    expect(vehoEvent('PackageHadDeliveryIssue', 'ClosedLocation - Mailroom', '').stage).toBe('failed_attempt');
    expect(vehoEvent('PackageHadDeliveryIssue', 'Weather', '')).toEqual({ wording: 'Delivery issue: Unforeseen weather is impacting the speed of your delivery', stage: 'exception' });
    expect(vehoEvent('PackageHadDeliveryIssue', 'RanOutOfTime - RouteStartedLate', '')).toEqual({ wording: 'Delivery issue: Unforeseen issue during delivery route', stage: 'exception' });
    expect(vehoEvent('PackageHadDeliveryIssue', null, '')).toEqual({ wording: 'Delivery issue', stage: 'exception' });
    const issues = statuses.entries.filter(entry => entry.wording.startsWith('Delivery issue: '));
    expect(issues).toHaveLength(9);
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(statusMap.stage('syntheticOperation', 'delivered')).toBeUndefined();
  });

  it('accepts one token of letters and digits', () => {
    for (const number of ['', 'VH1', 'VH 0SYNTHETIC01', 'VH0/SYNTHETIC', 'A'.repeat(41), '../graphql']) expect(() => normalizeVehoNumber(number)).toThrow();
    expect(normalizeVehoNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    expect(normalizeVehoNumber(BARCODE)).toBe(BARCODE);
    expect(QUERY).not.toMatch(/street|zipCode|apartment|name\b|pin|location|instructions/);
  });
});

describe('Veho adapter', () => {
  it('without a browser service or an attestation, reports a challenge and asks nothing', async () => {
    const { tracker, fetcher, records } = setup();
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker.direct(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(records).toMatchObject([{ carrier: 'veho', step: 'direct', outcome: 'challenge' }]);
  });

  it('obtains the attestation on a page given no number, then asks the order service over HTTP', async () => {
    const { trawl, requests } = browser([attestation()]);
    const { tracker, fetcher, records } = setup({ trawl });
    const result = await tracker.fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 30_000 });
    expect(result.events).toHaveLength(9);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: PAGE, skipHttp: true, maxTier: 3, captureResponses: [ATTESTATION] });
    expect(requests[0]!.proxy).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain(NUMBER);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(API);
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal),
      headers: { Authorization: TOKEN, servicename: 'CWA', 'Content-Type': 'application/json', Origin: 'https://track.shipveho.com' } });
    expect(JSON.parse(String(init!.body))).toEqual({ operationName: 'getOrderByTrackingIdCWA', variables: { trackingId: NUMBER }, query: QUERY });
    expect(records).toMatchObject([{ step: 'trawl', outcome: 'ok', networkRoute: 'default', networkAttempt: 'initial', historyAvailable: true }]);
  });

  it('serves later lookups over HTTP alone until the attestation lapses', async () => {
    let clock = 1_000_000;
    const { trawl, requests } = browser([attestation()], [attestation(200, { token: OTHER_TOKEN, ttl: '3600s' })]);
    const { tracker, fetcher, records } = setup({ trawl, now: () => clock });
    await tracker.fetch(NUMBER);
    await tracker.fetch(BARCODE);
    expect((await tracker.direct(NUMBER)).events).toHaveLength(9);
    expect(requests).toHaveLength(1);
    expect(records.map(record => record.step)).toEqual(['trawl', 'direct']);
    expect(records[1]!.networkRoute).toBeUndefined();
    clock += 3_299_999;
    await tracker.fetch(NUMBER);
    expect(requests).toHaveLength(1);
    clock += 1;
    await tracker.fetch(NUMBER);
    expect(requests).toHaveLength(2);
    expect(new Headers(fetcher.mock.calls.at(-1)![1]!.headers).get('authorization')).toBe(OTHER_TOKEN);
  });

  it('drops an attestation the order service refuses and obtains another', async () => {
    const { trawl, requests } = browser([attestation()], [attestation(200, { token: OTHER_TOKEN, ttl: '3600s' })]);
    const replies = [json(fixture()), json(UNAUTHORIZED, 401), json(fixture()), json({ data: { order: null }, ...UNAUTHORIZED })];
    const { tracker, records } = setup({ trawl, fetcher: async () => replies.shift() ?? json({ data: { order: null } }) });
    await tracker.fetch(NUMBER);
    expect((await tracker.fetch(NUMBER)).events).toHaveLength(9);
    expect(requests).toHaveLength(2);
    expect(records.slice(1)).toMatchObject([{ step: 'direct', outcome: 'challenge' }, { step: 'trawl', outcome: 'ok', fallbackFrom: 'direct' }]);
    // A refusal inside an HTTP 200 reply drops the attestation too, and the lookup goes on with a new one.
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(requests).toHaveLength(3);
    expect(records.slice(3)).toMatchObject([{ step: 'direct', outcome: 'challenge' }, { step: 'trawl', outcome: 'not_found' }]);
  });

  it('asks through the fallback proxy when the service address is refused, and leaves that address alone for a while', async () => {
    let clock = 5_000_000;
    const { trawl, requests } = browser([attestation(403)], [attestation()], [attestation(200, { token: OTHER_TOKEN, ttl: '60s' })]);
    const { tracker, records } = setup({ trawl, env: { VEHO_FALLBACK_PROXY_URL: ` ${PROXY} ` }, now: () => clock });
    expect((await tracker.fetch(NUMBER)).events).toHaveLength(9);
    expect(requests.map(request => request.proxy)).toEqual([undefined, PROXY]);
    expect(records).toMatchObject([
      { step: 'trawl', outcome: 'challenge', networkRoute: 'default', networkAttempt: 'initial' },
      { step: 'trawl', outcome: 'ok', networkRoute: 'residential', networkAttempt: 'retry', historyAvailable: true, fallbackFrom: 'trawl' }]);
    expect(JSON.stringify(records)).not.toContain('PRIVATE');
    clock += 3_299_000;
    await tracker.fetch(NUMBER);
    expect(requests).toHaveLength(2);
    // Lapsed twenty-five minutes after the refusal: the refused address is not asked again.
    clock = 5_000_000 + 25 * 60_000;
    (tracker as unknown as { held: null }).held = null;
    await tracker.fetch(NUMBER);
    expect(requests.map(request => request.proxy)).toEqual([undefined, PROXY, PROXY]);
    clock += 31 * 60_000;
    await expect(tracker.fetch(NUMBER)).resolves.toBeTruthy();
    expect(requests[3]!.proxy).toBeUndefined();
  });

  it('never reads a refusal as a missing parcel, and rests a refused proxy too', async () => {
    const { trawl, requests } = browser([attestation(403)], [attestation(429)]);
    const { tracker, fetcher } = setup({ trawl, env: { VEHO_FALLBACK_PROXY_URL: PROXY } });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(requests).toHaveLength(2);
    expect(fetcher).not.toHaveBeenCalled();
    const alone = browser([attestation(403)]);
    const single = setup({ trawl: alone.trawl });
    await expect(single.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(alone.requests).toHaveLength(1);
    expect(() => setup({ env: { VEHO_FALLBACK_PROXY_URL: 'not a proxy PRIVATE' } })).toThrowError(expect.not.stringContaining('PRIVATE'));
  });

  it.each([[[], 'challenge'], [[attestation(503)], 'upstream_http'], [[{ ...attestation(), truncated: true }], 'transport'],
    [[{ ...attestation(), error: 'Veho attestation was not a token', body: null }], 'transport'],
    [[attestation(200, '<html>')], 'schema'], [[attestation(200, { token: 'short', ttl: '3600s' })], 'schema'],
    [[attestation(200, { token: TOKEN, ttl: '5s' })], 'schema'], [[attestation(200, { token: TOKEN })], 'schema'],
    [[{ ...attestation(), url: 'https://example.test/' }], 'challenge']] as const)('reports a page without a usable attestation (%#) as %s', async (captures, kind) => {
    const { trawl } = browser([...captures]);
    const { tracker, fetcher } = setup({ trawl });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject(kind === 'upstream_http' ? { status: 503 } : { kind });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('shares one browser read between lookups made together', async () => {
    const { trawl, requests } = browser([attestation()]);
    const { tracker, fetcher } = setup({ trawl });
    const results = await Promise.all([tracker.fetch(NUMBER), tracker.fetch(BARCODE), tracker.fetch(NUMBER)]);
    expect(results.map(result => result.events!.length)).toEqual([9, 9, 9]);
    expect(requests).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reports an unknown number as not found and keeps the order service\'s failures apart', async () => {
    const { trawl } = browser([attestation()]);
    const replies = [json({ data: { order: null } }), json({}, 500), json('<html>'), new Response('<html>', { status: 200 })];
    const { tracker } = setup({ trawl, fetcher: async () => replies.shift()! });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ status: 500 });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('honors cancellation before I/O and while the browser reads', async () => {
    const before = new AbortController(); before.abort();
    const idle = setup({ trawl: browser([attestation()]).trawl });
    expect(() => idle.tracker.fetch(NUMBER, { signal: before.signal })).toThrow();
    const during = new AbortController();
    const trawl = new TrawlClient('http://browser.test', async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    }));
    const { tracker, fetcher } = setup({ trawl });
    await expect(tracker.fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks the private browser first, over the browser service, and rests it long after a refusal', async () => {
    let clock = 9_000_000;
    privately(200, 403, 200);
    const { trawl, requests } = browser([attestation()]);
    const { tracker, fetcher, records } = setup({ trawl, env: { VEHO_BROWSER_WS_ENDPOINT: ` ${ENDPOINT} ` }, now: () => clock });
    expect((await tracker.fetch(NUMBER, { budgetMs: 30_000 })).events).toHaveLength(9);
    expect(attestInBrowser).toHaveBeenCalledExactlyOnceWith(ENDPOINT, expect.any(AbortSignal), expect.any(Number));
    // The private read leaves the browser service half of the lookup, and the query its own time.
    expect(vi.mocked(attestInBrowser).mock.calls[0]![2]).toBeLessThanOrEqual(11_000);
    expect(requests).toHaveLength(0);
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('authorization')).toBe(TOKEN);
    expect(records).toMatchObject([{ step: 'browser', outcome: 'ok', networkRoute: 'residential', historyAvailable: true }]);
    // Refused once the attestation lapses: the browser service answers, and the private browser rests six hours.
    clock += 3_300_000;
    expect((await tracker.fetch(NUMBER)).events).toHaveLength(9);
    expect(records.slice(1)).toMatchObject([{ step: 'browser', outcome: 'challenge', networkRoute: 'residential' },
      { step: 'trawl', outcome: 'ok', networkRoute: 'default', fallbackFrom: 'browser' }]);
    clock += 5 * 3_600_000;
    (tracker as unknown as { held: null }).held = null;
    await tracker.fetch(NUMBER);
    expect(attestInBrowser).toHaveBeenCalledTimes(2);
    expect(records.at(-2)).toMatchObject({ step: 'browser', outcome: 'challenge' });
    expect(requests).toHaveLength(2);
    clock += 3_600_000;
    expect((await tracker.fetch(NUMBER)).events).toHaveLength(9);
    expect(attestInBrowser).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(records)).not.toContain('PRIVATE');
  });

  it('leaves the browser service its turn when the private browser fails to attest, and spaces private reads', async () => {
    let clock = 9_000_000;
    privately(new TransportError('Veho', 'Veho browser service is unavailable'), new TransportError('Veho', 'Veho browser service is unavailable'));
    const { trawl, requests } = browser([attestation()]);
    const both = setup({ trawl, env: { VEHO_BROWSER_WS_ENDPOINT: ENDPOINT }, now: () => clock });
    expect((await both.tracker.fetch(NUMBER)).events).toHaveLength(9);
    expect(both.records).toMatchObject([{ step: 'browser', outcome: 'transport' }, { step: 'trawl', outcome: 'ok', fallbackFrom: 'browser' }]);
    expect(requests).toHaveLength(1);
    // With the private browser alone, a failed read is not repeated for ten minutes.
    const alone = setup({ env: { VEHO_BROWSER_WS_ENDPOINT: ENDPOINT }, now: () => clock });
    await expect(alone.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(alone.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(attestInBrowser).toHaveBeenCalledTimes(2);
    clock += 10 * 60_000;
    privately(200);
    expect((await alone.tracker.fetch(NUMBER)).events).toHaveLength(9);
    expect(attestInBrowser).toHaveBeenCalledTimes(3);
    expect(alone.records.map(record => record.step)).toEqual(['browser', 'browser', 'browser']);
  });

  it('keeps the order service\'s answer after a private attestation, and confirms through the private browser alone', async () => {
    privately(200);
    const { trawl, requests } = browser([attestation()]);
    const { tracker } = setup({ trawl, env: { VEHO_BROWSER_WS_ENDPOINT: ENDPOINT }, fetcher: async () => json({}, 500) });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ status: 500 });
    expect(requests).toHaveLength(0);
    privately(200);
    const carrier = adapter({ env: { VEHO_BROWSER_WS_ENDPOINT: ENDPOINT }, fetcher: async () => json(fixture()), trawl: null,
      browserExecutablePath: null, recorder: NOOP_RECORDER });
    expect(await carrier.recognizeWithBrowser!(NUMBER, { budgetMs: 20_000 })).toMatchObject({ known: true });
  });

  it('confirms a number through the browser check alone, with its dated history', async () => {
    const { trawl, requests } = browser([attestation()]);
    const replies = [json(fixture()), json({ data: { order: null } })];
    const carrier = adapter({ env: {}, fetcher: async () => replies.shift()!, trawl, browserExecutablePath: null, recorder: NOOP_RECORDER });
    expect(carrier.recognize).toBeUndefined();
    const known = await carrier.recognizeWithBrowser!(NUMBER, { budgetMs: 20_000 });
    expect(known).toMatchObject({ known: true, lastActivityAt: '2026-03-05T18:18:55.073Z', result: { current_stage: 'delivered' } });
    expect(await carrier.recognizeWithBrowser!('VH0SYNTHETIC09', { budgetMs: 20_000 })).toEqual({ known: false, lastActivityAt: null });
    expect(requests).toHaveLength(1);
    const none = adapter({ env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });
    await expect(none.recognizeWithBrowser!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('routes a selection and its own number shapes to the adapter', async () => {
    const { trawl } = browser([attestation()]);
    const fetcher = vi.fn<typeof fetch>(async url => String(url) === API ? json(fixture()) : json({ tier: 3, statusCode: 200, html: '', capturedResponses: [attestation()] }));
    const answer = await createTracker({ fetcher, env: {}, providers: [], trawlUrl: 'http://browser.test' }).track({ carrier: 'veho', number: NUMBER });
    expect(answer).toMatchObject({ carrier: 'veho', source: 'veho' });
    expect(answer.result.events).toHaveLength(9);
    expect(adapter({ env: {}, trawl, browserExecutablePath: null, recorder: NOOP_RECORDER })).toMatchObject({ id: 'veho', steps: ['direct', 'browser', 'trawl'] });
    for (const number of ['VH199999999980', 'VEHOATL000021976']) expect(detectCarrierMatch(number).candidates).toContain('veho');
  });
});

it('withdraws delivery after an unmapped movement', () => {
  const result = parseVeho(changed(order => { order.packages[0].eventLog.unshift({ operation: 'DeliveryRevoked', timestamp: '2030-01-01T09:00:00Z' }); }), NUMBER);
  expect(result.status).toBe('unknown');
  expect(result.delivered_at).toBeUndefined();
});
