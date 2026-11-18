import { describe, expect, it, vi } from 'vitest';
import publicHistory from './fixtures/public-history.json' with { type: 'json' };
import { adapter, JumppointInternationalTracker, JUMPPOINT_INTERNATIONAL_API as API, jumppointInternationalUrl, normalizeJumppointInternationalNumber, parseJumppointInternational } from './adapter.js';
import { JUMPPOINT_INTERNATIONAL_STAGES, statusMap } from './status.js';
import { TrawlClient } from '../../core/transport/index.js';
import type { AdapterEnvironment } from '../../core/adapter/index.js';
const NUMBER = 'JPMY0000000001';
const payload = (fields: Record<string, unknown> = {}) => ({ success: true, data: { trackings: [{ trackingNumber: NUMBER,
  status: { en: 'Successful Delivery' }, statusLogs: [
    { eventDate: '2026-11-01T10:00:00+08:00', statusCode: { en: 'Shipment picked up' } },
    { eventDate: '2026-11-02T15:00:00+08:00', statusCode: { en: 'Successful Delivery' }, recipient: 'PRIVATE' },
  ], recipient: 'PRIVATE', ...fields }] } });
const url = jumppointInternationalUrl(NUMBER);
const capture = (fields: Record<string, unknown> = {}) => ({ url: API + '?' + new URLSearchParams({ 'trackingNumbers[]': NUMBER, captchaToken: 'synthetic-token', locale: 'en' }).toString(), status: 200, headers: {}, body: JSON.stringify(payload()), ...fields });
const response = (rows = [capture()]) => ({ url, tier: 3, statusCode: 200, capturedResponses: rows });
const mock = (value = response()) => { const scrape = vi.fn().mockResolvedValue(value); return { scrape,
  tracker: new JumppointInternationalTracker({ trawl: { scrape } as unknown as TrawlClient }) }; };

describe('Jumppoint International guest parser', () => {
  it('keeps whole identity, explicit clocks, translated stages and no contacts', () => {
    const r = parseJumppointInternational(payload(), NUMBER);
    expect(r.status).toBe('delivered'); expect(r.events).toHaveLength(2);
    expect(Date.parse(r.events![0]!.time!)).toBe(Date.parse('2026-11-02T15:00:00+08:00'));
    expect(r.events![0]!.stage).toBe('delivered'); expect(JSON.stringify(r)).not.toContain('PRIVATE');
  });
  it('rejects an unconfirmed offset-less clock without inventing a country-wide zone', () => {
    expect(() => parseJumppointInternational(payload({ statusLogs: [{ eventDate: '2026-11-02 15:00:00', statusCode: { zh: '已送達' } }] }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it.each([payload({ trackingNumber: 'JPMY0000000002' }), { success: true, data: { trackings: [] } },
    { success: true, data: { trackings: [payload().data.trackings[0], payload().data.trackings[0]] } },
    payload({ statusLogs: [{ eventDate: '2026-02-30T10:00:00', statusCode: { en: 'Delivered' } }] })])('rejects identity and schema drift', value => {
    expect(() => parseJumppointInternational(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('keeps an empty echoed synthetic number inconclusive', () => {
    expect(() => parseJumppointInternational(payload({ status: null, statusLogs: [] }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'empty_history' }));
  });
  it.each(['RESPONSE_TOKEN_MISSING', 'RECAPTHA_VERIFICATION_FAIL', 'RECAPTCHA_VERIFICIATION_PROCESS_ERROR'])('keeps %s as verification', code => {
    expect(() => parseJumppointInternational({ success: false, error: { user_message: code } }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });
  it('keeps international and domestic identifiers separate', () => {
    expect(normalizeJumppointInternationalNumber('jpmy 0000000001')).toBe(NUMBER);
    expect(() => normalizeJumppointInternationalNumber('JP000000000001')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('Jumppoint International browser boundary', () => {
  it('uses the supplied service, whole q and original lookup budget', async () => {
    const { tracker, scrape } = mock(); await tracker.fetch(NUMBER);
    expect(scrape.mock.calls[0]![0]).toMatchObject({ url, skipHttp: true, captureResponses: [API] });
    expect(scrape.mock.calls[0]![0].maxTimeout).toBeLessThanOrEqual(30000);
  });
  it.each([[429, 'rate_limited'], [403, 'challenge'], [500, 'indeterminate'], [404, 'transport']] as const)('keeps HTTP%s distinct', async (status, kind) => {
    await expect(mock(response([capture({ status })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind, status });
  });
  it('uses the final bound capture and rejects unrelated whole queries', async () => {
    await expect(mock(response([capture(), capture({ status: 403 })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(mock(response([capture({ url: API + '?trackingNumbers[]=' + NUMBER + '2' })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(mock(response([capture({ url: capture().url + '&trackingNumbers[1]=OTHER' })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(mock(response([capture({ body: '<html>challenge</html>' })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
  it('does not start a browser without budget, after cancellation or without a service', async () => {
    const { tracker, scrape } = mock();
    await expect(tracker.fetch(NUMBER, { budgetMs: 1 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(tracker.fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeDefined(); expect(scrape).not.toHaveBeenCalled();
    await expect(new JumppointInternationalTracker({ trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });
  it('offers browser recognition only and reuses confirmed history', async () => {
    const scrape = vi.fn().mockResolvedValue(response());
    const instance = adapter({ trawl: { scrape } } as unknown as AdapterEnvironment);
    expect(instance.recognize).toBeUndefined();
    expect(await instance.recognizeWithBrowser!(NUMBER)).toMatchObject({ known: true });
  });
});

 it('maps all observed international labels consistently for parser and review', () => {
   for (const [wording, stage] of Object.entries(JUMPPOINT_INTERNATIONAL_STAGES)) {
     expect(statusMap.stage('', wording)).toBe(stage);
     const result = parseJumppointInternational(payload({ status: { en: wording }, statusLogs: [{ eventDate: '2026-11-02T10:00:00Z', statusCode: { en: wording } }] }), NUMBER);
     expect(result.current_stage).toBe(stage); expect(result.events![0]!.stage).toBe(stage);
   }
 });

it('reads the public corpus reply with all dated international scans', () => {
  const row = publicHistory.data.trackings[0]!;
  const result = parseJumppointInternational(publicHistory, row.trackingNumber);
  expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Successful Delivery' });
  expect(result.events).toHaveLength(13);
  expect(Date.parse(result.events![0]!.time!)).toBe(Date.parse(row.statusLogs[0]!.eventDate));
  expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered', 'registered']);
});

it('reports a missing tracking endpoint as a transport failure', async () => {
  for (const status of [404, 410]) {
    const fetcher = async () => Response.json({ html: '', tier: 2, statusCode: status, capturedResponses: [] });
    const tracker = new JumppointInternationalTracker({ trawl: new TrawlClient('http://browser.invalid', fetcher) });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  }
});
