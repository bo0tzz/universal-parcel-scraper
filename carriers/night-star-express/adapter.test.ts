import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { NightStarExpressTracker } from './adapter.js';
import { NIGHT_STAR_ENDPOINT, normalizeNightStarNumber, parseNightStar, parseNightStarReply } from './parser.js';
import { nightStarStatus, statusMap } from './status.js';

const NUMBER = 'NSE0000000001';
const PACKAGE = 'NSEKOLLI0000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/orders.json', import.meta.url), 'utf8'));
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code: string; wording: string; stage: string; language: 'en' | 'de' }[] };
const second = (edit: (item: ReturnType<typeof fixture>) => void = () => {}) => changed(d => {
  const item = structuredClone(d[0].colis[0]);
  item.barcode = 'NSEKOLLI0000002'; item.alternateBarcode = null;
  edit(item);
  d[0].colis.push(item);
});

describe('Night Star Express guest adapter', () => {
  it('posts the whole number once, without a postcode, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new NightStarExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(NIGHT_STAR_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Accept-Language': 'en', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(JSON.parse(init!.body as string)).toEqual({ searches: [{ search: NUMBER }] });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'night-star-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads a package newest first with stated offsets, remarks, the status names and the service level', () => {
    const result = parseNightStar(fixture(), NUMBER);
    expect(result).toMatchObject({ status: languageStageStatus('out_for_delivery'), current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Out for delivery', last_update: '2026-03-03T04:30:00+01:00', expected_delivery: null, service_name: 'Synthetic Night' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events).toEqual([
      { time: '2026-03-03T04:30:00+01:00', description: 'Out for delivery', provider_code: 'IN_DELIVERY', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-03-02T22:10:00+01:00', description: 'Synthetic hub scan: Synthetic remark', provider_code: 'IN_TRANSIT', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-02T17:40:00Z', description: 'Synthetic goods picked up', provider_code: 'PICKED_UP', stage: 'accepted', stage_source: 'carrier_map' },
      { time: '2026-03-02T15:05:00Z', description: 'Synthetic order registered', provider_code: 'ORDER_REGISTERED', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(parseNightStar(fixture(), NUMBER, 'de').events![0]!.description).toBe('In Auslieferung');
  });

  it('never reads what the page shows only after the postcode check', () => {
    const data = changed(d => {
      Object.assign(d[0].colis[0], { verified: true, receiverAddress: { name1: 'PRIVATE NAME', street: 'PRIVATE STREET', zip: 'PRIVATEZIP', city: 'PRIVATE CITY' },
        senderAddress: { name1: 'PRIVATE SENDER' }, coliAttributes: { weight: 12.5, length: 30, width: 20, height: 10 },
        coliReference: { customerRef: 'PRIVATE REF', efagNumber: ['PRIVATE EFAG'] }, pins: [{ lat: 51.5, lon: 7.6 }] });
      Object.assign(d[0].colis[0].events[3], { geo: { lat: 51.5, lon: 7.6 }, receiverName: 'PRIVATE SIGNATORY', images: ['PRIVATE IMAGE'], receipt: true });
    });
    const result = parseNightStar(data, NUMBER);
    expect(result.events).toHaveLength(4);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|51\.5|12\.5|weight|signat/i);
  });

  it('dates a delivery from its event and lets the package status decide the stage', () => {
    const delivered = changed(d => {
      d[0].colis[0].status = 'DELIVERED';
      d[0].colis[0].events.push({ id: 'e5', status: 'DELIVERED', description: 'Synthetic delivered', remarkDescription: 'Synthetic delivered', timestamp: '2026-03-03T05:12:00+01:00' });
    });
    expect(parseNightStar(delivered, NUMBER)).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-03T05:12:00+01:00', last_status_text: 'Synthetic delivered' });
    const cancelled = changed(d => { d[0].colis[0].status = 'CANCELLED'; });
    expect(parseNightStar(cancelled, NUMBER)).toMatchObject({ current_stage: 'exception', last_status_text: 'Canceled' });
    const unlisted = changed(d => { d[0].colis[0].status = 'SYNTHETIC_NEW'; });
    expect(parseNightStar(unlisted, NUMBER)).toMatchObject({ current_stage: 'out_for_delivery' });
  });

  it('keeps a status name the script does not list, without a stage', () => {
    const data = changed(d => {
      d[0].colis[0].status = 'SYNTHETIC_NEW';
      d[0].colis[0].events = [{ id: 'e1', status: 'SYNTHETIC_NEW', description: '', remarkDescription: null, timestamp: '2026-03-02T09:15:00+01:00' },
        { id: 'e2', status: 'SYNTHETIC_OTHER', description: 'Synthetic wording', remarkDescription: null, timestamp: '2026-03-02T09:20:00+01:00' }];
    });
    const result = parseNightStar(data, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic wording' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events).toEqual([{ time: '2026-03-02T09:20:00+01:00', description: 'Synthetic wording', provider_code: 'SYNTHETIC_OTHER' },
      { time: '2026-03-02T09:15:00+01:00', description: 'synthetic new', provider_code: 'SYNTHETIC_NEW' }]);
  });

  it('reads one package by its barcode and the whole shipment by its number', () => {
    const data = second(item => {
      item.status = 'DELIVERED';
      item.events.push({ id: 'e5', status: 'DELIVERED', description: 'Synthetic delivered', remarkDescription: null, timestamp: '2026-03-03T05:12:00+01:00' });
    });
    expect(parseNightStar(data, 'NSEKOLLI0000002')).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-03T05:12:00+01:00', events: expect.objectContaining({ length: 5 }) });
    expect(parseNightStar(data, PACKAGE)).toMatchObject({ current_stage: 'out_for_delivery', events: expect.objectContaining({ length: 4 }) });
    expect(parseNightStar(data, 'ALT0000000001')).toMatchObject({ current_stage: 'out_for_delivery', events: expect.objectContaining({ length: 4 }) });
    // One package still on its way keeps the shipment undelivered; shared scans are listed once.
    const whole = parseNightStar(data, NUMBER);
    expect(whole).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Out for delivery', service_name: 'Synthetic Night' });
    expect(whole.delivered_at).toBeUndefined();
    expect(whole.events).toHaveLength(5);
    const both = second(item => { item.status = 'DELIVERED'; });
    both[0].colis[0].status = 'DELIVERED';
    for (const item of both[0].colis) item.events.push({ id: 'e5', status: 'DELIVERED', description: 'Synthetic delivered', remarkDescription: null, timestamp: '2026-03-03T05:12:00+01:00' });
    expect(parseNightStar(both, NUMBER)).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-03T05:12:00+01:00' });
    expect(parseNightStar(second(item => { item.sla = { name: 'Synthetic Day' }; }), NUMBER).service_name).toBeUndefined();
  });

  it('answers a package without events from its status alone', () => {
    const data = changed(d => { d[0].colis[0].events = []; d[0].colis[0].status = 'ORDER_REGISTERED'; });
    expect(parseNightStar(data, NUMBER)).toEqual({ status: languageStageStatus('registered'), current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Registered', last_update: null, expected_delivery: null, service_name: 'Synthetic Night', summary_only: true, events: [] });
    expect(parseNightStar(data, NUMBER, 'de').last_status_text).toBe('Erfasst');
    expect(() => parseNightStar(changed(d => { d[0].colis[0].events = []; d[0].colis[0].status = 'SYNTHETIC_NEW'; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('orders events on one clock by the reply and caps the history', () => {
    const same = changed(d => {
      d[0].colis[0].events = [{ id: 'a', status: 'PICKED_UP', description: 'A', timestamp: '2026-03-02T09:00:00+01:00' },
        { id: 'b', status: 'IN_TRANSIT', description: 'B', timestamp: '2026-03-02T09:00:00+01:00' }];
    });
    expect(parseNightStar(same, NUMBER).events!.map(event => event.provider_code)).toEqual(['IN_TRANSIT', 'PICKED_UP']);
    const long = changed(d => {
      d[0].colis[0].events = Array.from({ length: 120 }, (_, index) => ({ id: `e${index}`, status: 'IN_TRANSIT', description: `Synthetic ${index}`,
        timestamp: `2026-03-02T09:${String(index % 60).padStart(2, '0')}:00+01:00` }));
    });
    expect(parseNightStar(long, NUMBER)).toMatchObject({ history_truncated: true, events: expect.objectContaining({ length: 100 }) });
  });

  it('rejects a reply that does not name the requested number', () => {
    for (const data of [changed(d => { d[0].id = 'NSE0000000002'; d[0].colis[0].barcode = 'NSEKOLLI0000009'; d[0].colis[0].alternateBarcode = null; }),
      changed(d => { delete d[0].id; delete d[0].colis[0].barcode; delete d[0].colis[0].alternateBarcode; }),
      changed(d => { d[0].id = `${NUMBER}1`; d[0].colis[0].barcode = `${NUMBER}1`; d[0].colis[0].alternateBarcode = `1${NUMBER}`; }),
      changed(d => { d.push(structuredClone(d[0])); d[0].colis[0].barcode = 'X0000001'; d[1].colis[0].barcode = 'X0000002'; d[0].colis[0].alternateBarcode = d[1].colis[0].alternateBarcode = null; }),
      changed(d => { d[0].colis = []; })]) {
      expect(() => parseNightStar(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const own of [NUMBER.toLowerCase(), 'NSE-0000000001', ' nse 0000000001 ']) expect(parseNightStar(changed(d => { d[0].id = own; }), NUMBER).events).toHaveLength(4);
    expect(parseNightStar(changed(d => { d[0].id = 4200000001; }), '4200000001').events).toHaveLength(4);
  });

  it('rejects a clock without an offset, a malformed event or package and an oversized reply', () => {
    for (const data of [changed(d => { d[0].colis[0].events[0].timestamp = '2026-03-02T09:15:00'; }),
      changed(d => { d[0].colis[0].events[0].timestamp = '2026-02-31T09:15:00+01:00'; }),
      changed(d => { d[0].colis[0].events[0].timestamp = 1772435700; }),
      changed(d => { d[0].colis[0].events[0] = null; }),
      changed(d => { d[0].colis[0].events[0].status = 'Not A Name'; d[0].colis[0].events[0].description = ''; }),
      changed(d => { d[0].colis[0].events = {}; }), changed(d => { delete d[0].colis[0].events; }),
      changed(d => { d[0].colis[0].events = Array(501).fill(d[0].colis[0].events[0]); }),
      changed(d => { delete d[0].colis[0].status; }), changed(d => { d[0].colis[0].status = 'in delivery'; }),
      changed(d => { d[0].colis = {}; }), changed(d => { d[0].colis[0] = null; }), changed(d => { delete d[0].colis; }),
      Array(51).fill(fixture()[0]), null, {}, { data: fixture() }, 'orders', [null]]) {
      expect(() => parseNightStar(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('tells a missing reference from a moved service, a refusal and a page', () => {
    expect(() => parseNightStarReply(404, '{"message":"Not found"}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseNightStarReply(200, '[]', NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseNightStarReply(404, '{"message":"The route api/orders could not be found."}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseNightStarReply(404, '{}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseNightStarReply(200, '{"message":"Not found"}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const status of [200, 404]) {
      expect(() => parseNightStarReply(status, '<!doctype html><html><head><title>Tracking</title></head><body><div id="root"></div></body></html>', NUMBER))
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
      expect(() => parseNightStarReply(status, '<html><head><title>Just a moment...</title></head></html>', NUMBER))
        .toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('maps every status name of the script to its stage, in both of its languages', () => {
    expect(statuses.entries).toHaveLength(22);
    for (const entry of statuses.entries) {
      const known = nightStarStatus(entry.code)!;
      expect(known[entry.language]).toBe(entry.wording);
      expect(known.stage).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
      expect(STAGES).toContain(entry.stage);
    }
    expect(new Set(statuses.entries.map(entry => entry.code)).size).toBe(11);
    expect(statusMap.stage(null, 'Delivered')).toBeUndefined();
    expect(statusMap.stage('SYNTHETIC_NEW', 'Delivered')).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status, { 'retry-after': '60' }));
    await expect(new NightStarExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports the service\'s own missing-reference reply as not found, and a page as a changed service', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(response({ message: 'Not found' }, 404));
    await expect(new NightStarExpressTracker({ fetcher: missing }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing).toHaveBeenCalledOnce();
    const page = vi.fn<typeof fetch>().mockResolvedValue(response('<!doctype html><title>Tracking</title>', 200, { 'content-type': 'text/html' }));
    await expect(new NightStarExpressTracker({ fetcher: page }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new NightStarExpressTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new NightStarExpressTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection in the reader\'s language and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()));
    const tracker = createTracker({ fetcher, env: {}, providers: [] });
    const result = await tracker.track({ carrier: 'night-star-express', number: NUMBER });
    expect(result.source).toBe('night-star-express');
    expect(result.result.events).toHaveLength(4);
    const german = await tracker.track({ carrier: 'night-star-express', number: NUMBER, language: 'de-AT' });
    expect(german.result.last_status_text).toBe('In Auslieferung');
    expect(new Headers(fetcher.mock.calls[1]![1]!.headers).get('accept-language')).toBe('de');
    await tracker.track({ carrier: 'night-star-express', number: NUMBER, language: 'fr' });
    expect(new Headers(fetcher.mock.calls[2]![1]!.headers).get('accept-language')).toBe('en');
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('night-star-express');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('night-star-express');
    for (const number of ['', 'ABCDE', 'AB CD 1234', 'ABC/12345', '-ABC12345', 'A'.repeat(51), 'ABC123,DEF456']) expect(() => normalizeNightStarNumber(number)).toThrow();
    for (const number of ['ABC123', 'abc-123_45', '1234567890123']) expect(normalizeNightStarNumber(` ${number} `)).toBe(number);
  });
});
