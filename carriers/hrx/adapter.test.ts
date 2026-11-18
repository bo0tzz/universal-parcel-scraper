import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { HrxTracker } from './adapter.js';
import { HRX_ENDPOINT, normalizeHrxNumber, parseHrx, parseHrxReply } from './parser.js';
import { hrxEvent, statusMap } from './status.js';

const NUMBER = 'TRK0000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/order.json', import.meta.url), 'utf8'));
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code: string; wording: string; stage?: string }[] };

describe('HRX guest adapter', () => {
  it('asks the order service once for the whole number, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new HrxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(8);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${HRX_ENDPOINT}${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(init!.method).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hrx', step: 'direct', outcome: 'ok' }));
  });

  it('reads events newest first with their stated offsets, places, country, weight and delivery address', () => {
    const result = parseHrx(fixture(), NUMBER);
    expect(result).toMatchObject({ status: languageStageStatus('ready_for_pickup'), current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Ready for pickup - customer notified', last_update: '2026-03-04T10:20:00+02:00',
      expected_delivery: null, destination_country: 'LV', weight_kg: 1.25, receiver_address: 'PRIVATE-ADDRESS 1\nPRIVATE-CITY' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map(event => event.provider_code)).toEqual(['notified', 'moved', 'delivered_to_partner', 'hrx_terminal_out',
      'hrx_terminal_in', 'hrx_picked_up', 'ready', 'created']);
    expect(result.events!.map(event => event.stage)).toEqual(['ready_for_pickup', 'in_transit', 'in_transit', 'in_transit', 'in_transit',
      'accepted', 'registered', 'registered']);
    expect(result.events![0]).toEqual({ time: '2026-03-04T10:20:00+02:00', description: 'Ready for pickup - customer notified',
      provider_code: 'notified', location: 'Synthetic Locker 12', stage: 'ready_for_pickup', stage_source: 'carrier_map' });
    expect(result.events![1]!.location).toBeUndefined();
    expect(result.events!.at(-1)!.location).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/30\.0|20\.0|10\.0|length|width|height/);
  });

  it('dates a delivery from its event and keeps a later unread event from hiding it', () => {
    const data = changed(d => {
      d.tracking_events.push({ event: 'delivered', location: 'Synthetic Locker 12', timestamp: '2026-03-05T08:00:00Z' },
        { event: 'other', location: null, timestamp: '2026-03-05T12:00:00+02:00' });
    });
    const result = parseHrx(data, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-05T08:00:00Z', last_status_text: 'Unparsed' });
    expect(result.events![0]).toEqual({ time: '2026-03-05T12:00:00+02:00', description: 'Unparsed', provider_code: 'other' });
  });

  it('keeps an event name the page does not list, without a stage', () => {
    const data = changed(d => { d.tracking_events = [{ event: 'synthetic_new_event', location: 'Synthetic Hub', timestamp: '2026-03-02T09:15:00+02:00' }]; });
    const result = parseHrx(data, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'synthetic new event' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ time: '2026-03-02T09:15:00+02:00', description: 'synthetic new event', provider_code: 'synthetic_new_event', location: 'Synthetic Hub' });
  });

  it('orders events on one clock by the reply, drops repeats and caps the history', () => {
    const same = changed(d => {
      d.tracking_events = [{ event: 'hrx_terminal_in', location: 'A', timestamp: '2026-03-02T09:00:00+02:00' },
        { event: 'hrx_terminal_out', location: 'A', timestamp: '2026-03-02T09:00:00+02:00' },
        { event: 'hrx_terminal_out', location: 'A', timestamp: '2026-03-02T09:00:00+02:00' }];
    });
    expect(parseHrx(same, NUMBER).events!.map(event => event.provider_code)).toEqual(['hrx_terminal_out', 'hrx_terminal_in']);
    const long = changed(d => {
      d.tracking_events = Array.from({ length: 120 }, (_, index) => ({ event: 'moved', location: `Synthetic ${index}`,
        timestamp: `2026-03-02T09:${String(index % 60).padStart(2, '0')}:00+02:00` }));
    });
    expect(parseHrx(long, NUMBER)).toMatchObject({ history_truncated: true, events: expect.objectContaining({ length: 100 }) });
  });

  it('leaves out a country, weight or place it cannot read', () => {
    for (const edit of [(d: ReturnType<typeof fixture>) => { d.delivery_location_country = 'Latvia'; d.weight_kg = '0.0'; },
      (d: ReturnType<typeof fixture>) => { d.delivery_location_country = null; d.weight_kg = 'n/a'; },
      (d: ReturnType<typeof fixture>) => { delete d.delivery_location_country; delete d.weight_kg; }]) {
      const result = parseHrx(changed(edit), NUMBER);
      expect(result.destination_country).toBeUndefined();
      expect(result.weight_kg).toBeUndefined();
      expect(result.events).toHaveLength(8);
    }
    expect(parseHrx(changed(d => { d.delivery_location_country = 'ee'; d.weight_kg = 2; }), NUMBER)).toMatchObject({ destination_country: 'EE', weight_kg: 2 });
  });

  it('rejects an order that does not name the requested number', () => {
    for (const data of [changed(d => { d.tracking_number = 'TRK0000000002'; }), changed(d => { delete d.tracking_number; }),
      changed(d => { d.tracking_number = `${NUMBER}1`; }), changed(d => { d.tracking_number = null; })]) {
      expect(() => parseHrx(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const own of [NUMBER.toLowerCase(), 'TRK-0000000001', ' trk 0000000001 ']) expect(parseHrx(changed(d => { d.tracking_number = own; }), NUMBER).events).toHaveLength(8);
  });

  it('rejects a clock without an offset, a malformed event and an oversized history', () => {
    for (const data of [changed(d => { d.tracking_events[0].timestamp = '2026-03-02T09:15:00'; }),
      changed(d => { d.tracking_events[0].timestamp = '2026-02-31T09:15:00+02:00'; }),
      changed(d => { d.tracking_events[0].timestamp = 1772435700; }),
      changed(d => { d.tracking_events[0].event = 'Not A Name'; }), changed(d => { d.tracking_events[0] = null; }),
      changed(d => { d.tracking_events = {}; }), changed(d => { delete d.tracking_events; }),
      changed(d => { d.tracking_events = Array(501).fill(d.tracking_events[0]); }), null, [], 'order']) {
      expect(() => parseHrx(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('tells a missing order from an empty one, a refusal and a page', () => {
    expect(() => parseHrxReply(404, '{"error":"not_found"}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHrxReply(404, '{"error":"gone"}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseHrxReply(404, '{}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseHrxReply(200, '{"error":"not_found"}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHrx(changed(d => { d.error = 'synthetic failure'; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHrx(changed(d => { d.tracking_events = []; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
    for (const status of [200, 404]) {
      expect(() => parseHrxReply(status, '<!doctype html><html><head><title>HRX WOP</title></head><body><div id="root"></div></body></html>', NUMBER))
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
      expect(() => parseHrxReply(status, '<html><head><title>Just a moment...</title></head></html>', NUMBER))
        .toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('maps every listed event name to its stage and leaves the unread one without', () => {
    expect(statuses.entries).toHaveLength(16);
    for (const entry of statuses.entries) {
      expect(hrxEvent(entry.code)).toEqual({ wording: entry.wording, ...(entry.stage ? { stage: entry.stage } : {}) });
      expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
      if (entry.stage) expect(STAGES).toContain(entry.stage);
    }
    expect(statuses.entries.filter(entry => !entry.stage).map(entry => entry.code)).toEqual(['other']);
    expect(statusMap.stage(null, 'Delivered')).toBeUndefined();
    expect(statusMap.stage('synthetic_new_event', 'Delivered')).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status, { 'retry-after': '60' }));
    await expect(new HrxTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports the service\'s own missing-order reply as not found, and its application page as a changed service', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'not_found' }, 404));
    await expect(new HrxTracker({ fetcher: missing }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing).toHaveBeenCalledOnce();
    const page = vi.fn<typeof fetch>().mockResolvedValue(response('<!doctype html><title>HRX WOP</title>', 200, { 'content-type': 'text/html' }));
    await expect(new HrxTracker({ fetcher: page }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new HrxTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new HrxTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const result = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'hrx', number: NUMBER });
    expect(result.source).toBe('hrx');
    expect(result.result.events).toHaveLength(8);
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('hrx');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('hrx');
    for (const number of ['', 'ABCD', 'AB CD 1234', 'ABC/12345', '-ABC12345', 'A'.repeat(51), '../orders']) expect(() => normalizeHrxNumber(number)).toThrow();
    for (const number of ['ABC12345', 'abc-123_45', '1234567890123']) expect(normalizeHrxNumber(` ${number} `)).toBe(number);
  });
});

it('completes a return only at the returned scan', () => {
  expect(hrxEvent('customer_returned')?.stage).toBe('exception');
  expect(hrxEvent('returned')?.stage).toBe('returned');
});
