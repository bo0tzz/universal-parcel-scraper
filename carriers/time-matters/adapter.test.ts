import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { TimeMattersTracker } from './adapter.js';
import { normalizeTimeMattersNumber, parseTimeMatters, parseTimeMattersReply, timeMattersUrl } from './parser.js';
import { statusMap, timeMattersPoint, timeMattersStatus } from './status.js';

const NUMBER = 'S0000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/order.json', import.meta.url), 'utf8'));
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code: string; wording: string; stage: string; language: 'en' | 'de' | 'fr' }[] };
const MISSING = { id: '00000000-0000-4000-8000-000000000000', status: 404, title: 'no such order found' };
// The order at its door: the courier's arrival at the delivery address, after the flight's and the station's steps.
const arrived = (edit: (data: ReturnType<typeof fixture>) => void = () => {}) => changed(d => {
  d.status = 'FINISHED';
  d.routing[4].trackingPoints[0].actual = '2026-03-02T11:50:00+00:00';
  d.routing[4].trackingPoints[1].actual = '2026-03-02T12:20:00+00:00';
  d.routing[6].trackingPoints[0].actual = '2026-03-02T14:10:00+00:00';
  edit(d);
});
// The same order ending at its destination airport.
const toStation = (edit: (data: ReturnType<typeof fixture>) => void = () => {}) => changed(d => {
  d.transportType = 'DOOR_TO_STATION';
  d.routing.length = 5;
  edit(d);
});

describe('time:matters guest adapter', () => {
  it('asks for the whole number once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new TimeMattersTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://booking.time-matters.com/services/css-orders/orders/${NUMBER}/status/basic`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(init!.method).toBeUndefined();
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'time-matters', step: 'direct', outcome: 'ok' }));
    expect(timeMattersUrl('S0000001-2')).toBe('https://booking.time-matters.com/services/css-orders/orders/S0000001-2/status/basic');
  });

  it('reads the steps that happened newest first, with their stops, the order status and the delivery time', () => {
    const result = parseTimeMatters(fixture(), NUMBER);
    expect(result).toEqual({ status: languageStageStatus('in_transit'), current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In transport', provider_code: 'IN_TRANSPORT', last_update: '2026-03-02T11:10:00+01:00', expected_delivery: '2026-03-02T14:20:00Z',
      events: [
        { time: '2026-03-02T11:10:00+01:00', description: 'Departure', location: 'Synthetic Origin (XXA)', provider_code: 'Departure', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T09:40:00+01:00', description: 'Acceptance', location: 'Synthetic Origin (XXA)', provider_code: 'Acceptance', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-03-02T08:05:00+01:00', description: 'Pickup courier informed', provider_code: 'PickupCourierInformed', stage: 'registered', stage_source: 'carrier_map' },
      ] });
    expect(parseTimeMatters(fixture(), NUMBER, 'de')).toMatchObject({ last_status_text: 'Im Transport', events: expect.arrayContaining([expect.objectContaining({ description: 'Abgang' })]) });
    expect(parseTimeMatters(fixture(), NUMBER, 'fr')).toMatchObject({ last_status_text: 'Transport en cours', events: expect.arrayContaining([expect.objectContaining({ description: 'Départ' })]) });
    // The scheduled arrival stands in for a missing estimate, and a wall clock without an offset stays one.
    expect(parseTimeMatters(changed(d => { d.routing[6].trackingPoints[0].estimated = null; }), NUMBER).expected_delivery).toBe('2026-03-02T14:00:00Z');
    expect(parseTimeMatters(changed(d => { d.routing[6].trackingPoints[0].estimated = '2026-03-02T14:20:00'; }), NUMBER).expected_delivery).toBe('2026-03-02 14:20');
    expect(parseTimeMatters(changed(d => { d.routing[6].trackingPoints[0].estimated = 'soon'; }), NUMBER).expected_delivery).toBeNull();
    expect(parseTimeMatters(changed(d => { d.routing[6].trackingPoints = []; }), NUMBER).expected_delivery).toBeNull();
  });

  it('names an airport by its town and code and a station by its name, and never reads an address', () => {
    const data = changed(d => {
      Object.assign(d.routing[0], { name: 'PRIVATE SENDER', address: { street: 'PRIVATE STREET', zipCode: 'PRIVATEZIP', city: 'PRIVATE CITY', formattedAddress: 'PRIVATE ADDRESS' } });
      Object.assign(d.routing[6], { name: 'PRIVATE CONSIGNEE', address: { street: 'PRIVATE STREET', zipCode: 'PRIVATEZIP', city: 'PRIVATE CITY' } });
      d.routing[2].address.street = 'PRIVATE AIRPORT STREET';
      d.routing[2].trackingPoints[0].handover = 'PRIVATE NAME';
      Object.assign(d, { customerReference: 'PRIVATE REF', customerAddress: { name: 'PRIVATE CUSTOMER' }, totalPrice: [{ amountIncludingVat: 4242, currency: 'EUR' }] });
    });
    const result = parseTimeMatters(data, NUMBER);
    expect(result.events).toHaveLength(3);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|4242|EUR/);
    const station = changed(d => { Object.assign(d.routing[2], { entityType: 'TRAIN_STATION', name: 'Synthetic Hbf', iataCode: null }); });
    expect(parseTimeMatters(station, NUMBER).events![0]!.location).toBe('Synthetic Hbf');
    expect(parseTimeMatters(changed(d => { delete d.routing[2].address; }), NUMBER).events![0]!.location).toBe('XXA');
    expect(parseTimeMatters(changed(d => { d.routing[2].iataCode = 'xxa1'; }), NUMBER).events![0]!.location).toBe('Synthetic Origin');
    expect(parseTimeMatters(changed(d => { d.routing[2].iataCode = null; delete d.routing[2].address; }), NUMBER).events![0]!.location).toBe('Synthetic Origin Airport');
    expect(parseTimeMatters(changed(d => { d.routing[2].entityType = 'HANDLING'; }), NUMBER).events![0]!.location).toBeUndefined();
  });

  it('dates a delivery by the arrival at the delivery address or the hand-over at the last stop', () => {
    const door = parseTimeMatters(arrived(), NUMBER);
    expect(door).toMatchObject({ status: languageStageStatus('delivered'), current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-03-02T14:10:00Z', delivered_at: '2026-03-02T14:10:00Z', expected_delivery: null });
    expect(door.provider_code).toBeUndefined();
    expect(door.events!.slice(0, 3)).toEqual([
      { time: '2026-03-02T14:10:00Z', description: 'Delivered', provider_code: 'FINISHED', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-03-02T14:10:00Z', description: 'Arrival', provider_code: 'Arrival', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-02T12:20:00Z', description: 'Available', location: 'Synthetic Destination (XXB)', provider_code: 'Available', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(door.events).toHaveLength(7);
    // A hand-over is the delivery wherever the order ends; its name is not read.
    const handed = toStation(d => {
      d.status = 'FINISHED';
      d.routing[4].trackingPoints[0].actual = '2026-03-02T11:50:00+00:00';
      d.routing[4].trackingPoints.push({ type: 'Release', planned: null, estimated: null, actual: '2026-03-02T13:05:00+00:00', handover: 'PRIVATE NAME' });
    });
    const collected = parseTimeMatters(handed, NUMBER, 'de');
    expect(collected).toMatchObject({ current_stage: 'delivered', last_status_text: 'Zugestellt', delivered_at: '2026-03-02T13:05:00Z' });
    expect(collected.events!.slice(0, 2).map(event => [event.provider_code, event.description])).toEqual([['FINISHED', 'Zugestellt'], ['Release', 'Übernahme']]);
    expect(JSON.stringify(collected)).not.toContain('PRIVATE');
    // An order that ends at a station without a hand-over is delivered on its status alone.
    const undated = parseTimeMatters(toStation(d => { d.status = 'FINISHED'; d.routing[4].trackingPoints[0].actual = '2026-03-02T11:50:00+00:00'; }), NUMBER);
    expect(undated).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', provider_code: 'FINISHED', last_update: '2026-03-02T11:50:00Z' });
    expect(undated.delivered_at).toBeUndefined();
    expect(parseTimeMatters(arrived(d => { d.routing[6].trackingPoints[0].actual = null; }), NUMBER).delivered_at).toBeUndefined();
  });

  it('reads a shipment waiting at its last station as ready to collect only when the order ends there', () => {
    const waiting = (data: ReturnType<typeof fixture>) => { data.status = 'PACKAGE_CLAIM'; data.routing[4].trackingPoints[1].actual = '2026-03-02T12:20:00+00:00'; };
    expect(parseTimeMatters(toStation(waiting), NUMBER)).toMatchObject({ status: languageStageStatus('ready_for_pickup'), current_stage: 'ready_for_pickup',
      last_status_text: 'Available', provider_code: 'PACKAGE_CLAIM', expected_delivery: null });
    expect(parseTimeMatters(changed(waiting), NUMBER)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Available', expected_delivery: '2026-03-02T14:20:00Z' });
    // The order's own type decides for a reply without a routing.
    expect(parseTimeMatters({ status: 'PACKAGE_CLAIM', transportType: 'STATION_TO_DOOR' }, NUMBER).current_stage).toBe('in_transit');
    expect(parseTimeMatters({ status: 'PACKAGE_CLAIM', transportType: 'STATION_TO_STATION' }, NUMBER).current_stage).toBe('ready_for_pickup');
  });

  it('reads a cancellation that went through, and leaves a requested one to the order status', () => {
    const cancelled = parseTimeMatters(changed(d => { d.cancellationStatus = 'PROCESSED'; d.cancellationProcessTime = '2026-03-02T12:00:00.123'; }), NUMBER);
    expect(cancelled).toMatchObject({ status: languageStageStatus('exception'), current_stage: 'exception', last_status_text: 'Canceled', last_update: '2026-03-02T12:00:00.123Z', expected_delivery: null });
    expect(cancelled.provider_code).toBeUndefined();
    expect(cancelled.events![0]).toEqual({ time: '2026-03-02T12:00:00.123Z', description: 'Canceled', provider_code: 'CANCELLED', stage: 'exception', stage_source: 'carrier_map' });
    const undated = parseTimeMatters(changed(d => { d.cancellationStatus = 'PROCESSED'; d.cancellationProcessTime = '2026-03-02 12:00'; }), NUMBER);
    expect(undated).toMatchObject({ current_stage: 'exception', provider_code: 'CANCELLED', events: expect.objectContaining({ length: 3 }) });
    expect(parseTimeMatters(changed(d => { d.cancellationStatus = 'REQUESTED'; d.cancellationRequestTime = '2026-03-02T12:00:00'; }), NUMBER))
      .toMatchObject({ current_stage: 'in_transit', events: expect.objectContaining({ length: 3 }) });
    expect(parseTimeMatters(changed(d => { delete d.cancellationStatus; }), NUMBER).current_stage).toBe('in_transit');
    expect(parseTimeMatters(changed(d => { d.status = 'REJECTED'; d.cancellationStatus = 'REJECTED'; }), NUMBER))
      .toMatchObject({ current_stage: 'exception', last_status_text: 'Rejected by time:matters', expected_delivery: null });
    expect(parseTimeMatters(changed(d => { d.status = 'CANCELLED'; }), NUMBER)).toMatchObject({ current_stage: 'exception', last_status_text: 'Canceled' });
  });

  it('answers an order without a dated step from its status alone', () => {
    expect(parseTimeMatters({ status: 'REQUEST', cancellationStatus: 'NONE', transportType: 'DOOR_TO_DOOR', routing: [] }, NUMBER)).toEqual({
      status: languageStageStatus('registered'), current_stage: 'registered', current_stage_source: 'carrier_map', last_status_text: 'Requested',
      provider_code: 'REQUEST', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    expect(parseTimeMatters({ status: 'PREADVICE' }, NUMBER, 'de')).toMatchObject({ current_stage: 'registered', last_status_text: 'Bestätigt', summary_only: true });
    expect(parseTimeMatters({ status: 'OPEN', routing: null }, NUMBER, 'fr')).toMatchObject({ current_stage: 'registered', last_status_text: 'Ouvert' });
    // The page prefers the order's `basicStatus` where a reply carries both.
    expect(parseTimeMatters({ status: 'PREADVICE', basicStatus: 'IN_TRANSPORT' }, NUMBER).current_stage).toBe('in_transit');
    const planned = changed(d => { for (const stop of d.routing) for (const point of stop.trackingPoints ?? []) point.actual = null; d.status = 'PREADVICE'; });
    expect(parseTimeMatters(planned, NUMBER)).toMatchObject({ summary_only: true, events: [], expected_delivery: '2026-03-02T14:20:00Z' });
  });

  it('keeps a tracking point type the script does not list, without a stage, and orders steps on one clock by the route', () => {
    const data = changed(d => {
      d.routing[2].trackingPoints = [{ type: 'Acceptance', actual: '2026-03-02T09:40:00+01:00' }, { type: 'SyntheticNewStep2', actual: '2026-03-02T09:40:00+01:00' }];
    });
    expect(parseTimeMatters(data, NUMBER).events!.slice(0, 2)).toEqual([
      { time: '2026-03-02T09:40:00+01:00', description: 'Synthetic New Step2', location: 'Synthetic Origin (XXA)', provider_code: 'SyntheticNewStep2' },
      { time: '2026-03-02T09:40:00+01:00', description: 'Acceptance', location: 'Synthetic Origin (XXA)', provider_code: 'Acceptance', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    const long = changed(d => {
      d.routing = Array.from({ length: 3 }, () => ({ entityType: 'HANDLING', trackingPoints: Array.from({ length: 40 }, (_, index) => ({ type: 'Arrival',
        actual: `2026-03-02T09:${String(index).padStart(2, '0')}:00+01:00` })) }));
    });
    expect(parseTimeMatters(long, NUMBER)).toMatchObject({ history_truncated: true, events: expect.objectContaining({ length: 100 }) });
  });

  it('rejects a reply that names another order', () => {
    for (const own of ['S0000002', `${NUMBER}1`, `1${NUMBER}`, '', 42, {}]) {
      expect(() => parseTimeMatters(changed(d => { d.orderNumber = own; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const own of [NUMBER, NUMBER.toLowerCase(), ' s 0000001 ']) expect(parseTimeMatters(changed(d => { d.orderNumber = own; }), NUMBER).events).toHaveLength(3);
    expect(parseTimeMatters(changed(d => { d.orderNumber = 12345678; }), '12345678').events).toHaveLength(3);
    // A rebooked order is distinct from the undashed spelling.
    expect(() => parseTimeMatters(changed(d => { d.orderNumber = NUMBER + '-2'; }), NUMBER + '2')).toThrow();
    expect(parseTimeMatters(changed(d => { d.orderNumber = null; }), NUMBER).events).toHaveLength(3);
  });

  it('rejects an unknown status, a clock without an offset and a malformed routing', () => {
    for (const data of [changed(d => { d.status = 'SYNTHETIC_NEW'; }), changed(d => { delete d.status; }), changed(d => { d.status = 404; }),
      changed(d => { d.status = 'DELIVERY'; }), changed(d => { d.status = 'in_transport'; }),
      changed(d => { d.cancellationStatus = 'SYNTHETIC_NEW'; }), changed(d => { d.cancellationStatus = true; }),
      changed(d => { d.routing[2].trackingPoints[0].actual = '2026-03-02T09:40:00'; }),
      changed(d => { d.routing[2].trackingPoints[0].actual = '2026-02-31T09:40:00+01:00'; }),
      changed(d => { d.routing[2].trackingPoints[0].actual = 1772440800; }),
      changed(d => { d.routing[2].trackingPoints[0] = null; }), changed(d => { d.routing[2].trackingPoints = {}; }),
      changed(d => { delete d.routing[2].trackingPoints[0].type; }), changed(d => { d.routing[2].trackingPoints[0].type = 'Not A Type'; }),
      changed(d => { d.routing[2].trackingPoints = Array(61).fill(d.routing[2].trackingPoints[0]); }),
      changed(d => { d.routing = {}; }), changed(d => { d.routing[0] = null; }), changed(d => { d.routing = Array(61).fill(d.routing[0]); }),
      null, [], [fixture()], 'order', MISSING, { data: fixture() }]) {
      expect(() => parseTimeMatters(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    // A delivery moment the reply does not date with an offset is no event.
    expect(() => parseTimeMatters(arrived(d => { d.routing[6].trackingPoints[0].actual = '2026-03-02T14:10:00'; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('tells a missing order from a moved service, a refusal and a page', () => {
    expect(() => parseTimeMattersReply(404, JSON.stringify(MISSING), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTimeMattersReply(404, '{"status":404,"title":"Not Found"}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTimeMattersReply(404, '{}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTimeMattersReply(200, JSON.stringify(MISSING), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const status of [200, 404]) {
      expect(() => parseTimeMattersReply(status, '<!doctype html><html><head><title>time:matters</title></head><body><app-root></app-root></body></html>', NUMBER))
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
      expect(() => parseTimeMattersReply(status, '<html><head><title>Just a moment...</title></head></html>', NUMBER))
        .toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(parseTimeMattersReply(200, JSON.stringify(fixture()), NUMBER, 'de').last_status_text).toBe('Im Transport');
  });

  it('maps every status and tracking point type of the script to its stage, in its three languages', () => {
    expect(statuses.entries).toHaveLength(63);
    for (const entry of statuses.entries) {
      const known = (timeMattersStatus(entry.code) ?? timeMattersPoint(entry.code))!;
      expect(known[entry.language]).toBe(entry.wording);
      expect(known.stage).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
      expect(STAGES).toContain(entry.stage);
    }
    expect(new Set(statuses.entries.map(entry => entry.code)).size).toBe(21);
    expect(timeMattersStatus('Arrival')).toBeUndefined();
    expect(timeMattersPoint('FINISHED')).toBeUndefined();
    expect(statusMap.stage(null, 'Delivered')).toBeUndefined();
    expect(statusMap.stage('SYNTHETIC_NEW', 'Delivered')).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status, { 'retry-after': '60' }));
    await expect(new TimeMattersTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports the service\'s own missing-order reply as not found, and a page as a changed service', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(response(MISSING, 404));
    await expect(new TimeMattersTracker({ fetcher: missing }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing).toHaveBeenCalledOnce();
    const page = vi.fn<typeof fetch>().mockResolvedValue(response('<!doctype html><title>time:matters</title>', 200, { 'content-type': 'text/html' }));
    await expect(new TimeMattersTracker({ fetcher: page }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new TimeMattersTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new TimeMattersTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection in the reader\'s language and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()));
    const tracker = createTracker({ fetcher, env: {}, providers: [] });
    const result = await tracker.track({ carrier: 'time-matters', number: NUMBER });
    expect(result.source).toBe('time-matters');
    expect(result.result.events).toHaveLength(3);
    expect((await tracker.track({ carrier: 'time-matters', number: NUMBER, language: 'de-AT' })).result.last_status_text).toBe('Im Transport');
    expect((await tracker.track({ carrier: 'time-matters', number: NUMBER, language: 'fr' })).result.last_status_text).toBe('Transport en cours');
    expect((await tracker.track({ carrier: 'time-matters', number: NUMBER, language: 'es' })).result.last_status_text).toBe('In transport');
    for (const number of [NUMBER, '12345678']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('time-matters');
      expect(recognitionCandidates(number).map(candidate => candidate.carrier)).not.toContain('time-matters');
    }
    for (const number of ['', 'S1', '1234567', 'A12345678', 'S12345/1', 'S1234 5', '1234567890123', `S${'1'.repeat(21)}`, 'S12345-1234']) expect(() => normalizeTimeMattersNumber(number)).toThrow();
    for (const [number, read] of [['s123', 'S123'], ['S12345-2', 'S12345-2'], ['12345678', '12345678'], ['123456789-1', '123456789-1'], ['1234567891', '1234567891']] as const) {
      expect(normalizeTimeMattersNumber(` ${number} `)).toBe(read);
    }
  });
});

it('sends the rebooking suffix through the facade', async () => {
  const number = NUMBER + '-1';
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(changed(d => { d.orderNumber = number; })));
  await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'time-matters', number });
  expect(String(fetcher.mock.calls[0]![0])).toBe(timeMattersUrl(number));
});
