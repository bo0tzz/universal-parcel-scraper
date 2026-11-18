import { describe, expect, it, vi } from 'vitest';
import failedAttempt from './fixtures/inbound-failed-attempt.json' with { type: 'json' };
import customs from './fixtures/inbound-customs.json' with { type: 'json' };
import { adapter, parsePostaMoldovei, PostaMoldoveiTracker, postaMoldoveiApiUrl, postaMoldoveiTrackingUrl } from './adapter.js';
import { POSTA_MOLDOVEI_EVENTS } from './status.js';
import { TrawlClient } from '../../core/transport/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import type { AdapterEnvironment } from '../../core/adapter/index.js';
import { parseTrackingInput } from '../../core/detection/parse.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic numbers: an S10 code with a valid check digit and the domestic layout.
const NUMBER = 'RB123456785DE';
const DOMESTIC = 'DS0000000000AS';
const api = postaMoldoveiApiUrl(NUMBER);
const capture = (overrides: Record<string, unknown> = {}) => ({ url: api, status: 200, headers: {},
  body: JSON.stringify(failedAttempt), ...overrides });
const response = (captures = [capture()], overrides: Record<string, unknown> = {}) => ({ tier: 2, statusCode: 200,
  capturedResponses: captures, ...overrides });
const mock = (value = response()) => {
  const scrape = vi.fn().mockResolvedValue(value);
  return { scrape, tracker: new PostaMoldoveiTracker({ trawl: { scrape } as unknown as TrawlClient }) };
};

describe('Poșta Moldovei parser', () => {
  it('reads mail from abroad with each office\'s wall clock and the wording\'s stage', () => {
    const result = parsePostaMoldovei(failedAttempt, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Receive item at delivery office (Inb)', last_update: null, last_update_local: '2026-07-07T11:23:26',
      expected_delivery: null });
    expect(result.events).toHaveLength(9);
    // The attempt dated by day reads 22:00Z the evening before; its wall clock is midnight.
    expect(result.events![1]).toMatchObject({ local_time: '2026-07-07T00:00:00', stage: 'failed_attempt',
      description: 'Unsuccessful item delivery attempt (Inb)' });
    expect(result.events!.every((event) => !event.time && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(event.local_time!))).toBe(true);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-06-29T05:39:00', stage: 'accepted', description: 'Posting/collection' });
    // Scans at the same second keep the reply's order.
    expect(result.events!.slice(5, 7).map((event) => event.description)).toEqual(['Arrival at outward Office of Exchange', 'Insert item into bag']);
  });

  it('reads Romanian wordings, customs and an office postcode', () => {
    const result = parsePostaMoldovei(customs, NUMBER);
    expect(result.events).toHaveLength(9);
    expect(result.events!.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'customs', 'customs', 'in_transit',
      'in_transit', 'in_transit', 'in_transit', 'accepted']);
    expect(result.events![0]).toMatchObject({ local_time: '2024-08-16T07:44:38', location: 'MD2006' });
  });

  it('never reads the names or the weight', () => {
    const named = { ...customs, sender_name: 'Synthetic Sender', receiver_name: 'Synthetic Receiver', total_weight: 1.5 };
    const text = JSON.stringify(parsePostaMoldovei(named, NUMBER));
    expect(text).not.toContain('Synthetic');
    expect(text).not.toContain('1.5');
  });

  it('keeps a repeated scan once and leaves an unknown wording visible', () => {
    const log = failedAttempt.shipping_logs[0]!;
    const result = parsePostaMoldovei({ shipping_logs: [log, log, { ...log, id: 0, description: 'Synthetic unknown handling' }] }, NUMBER);
    expect(result.events).toHaveLength(2);
    expect(result.events![1]).toEqual({ local_time: '2026-07-07T11:23:26', location: log.additional_description,
      description: 'Synthetic unknown handling' });
  });

  it('reads a delivery from its wording', () => {
    const log = failedAttempt.shipping_logs[0]!;
    const result = parsePostaMoldovei({ shipping_logs: [{ ...log, created_at: '2026-07-08T19:09:08Z', description: 'Deliver item (Inb)' },
      ...failedAttempt.shipping_logs] }, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-07-08T21:09:08' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('treats an empty history as no history and a changed reply as schema drift', () => {
    expect(() => parsePostaMoldovei({ shipping_logs: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    const log = failedAttempt.shipping_logs[0]!;
    for (const payload of [null, {}, { shipping_logs: {} }, { shipping_logs: [null] }, { shipping_logs: [{ ...log, description: '' }] },
      { shipping_logs: [{ ...log, description: 3 }] }, { shipping_logs: [{ ...log, created_at: '2026-07-07 09:23:26' }] },
      { shipping_logs: [{ ...log, created_at: '2026-02-30T09:23:26Z' }] }, { shipping_logs: [{ ...log, created_at: '2026-07-07T09:23:26+03:00' }] },
      { shipping_logs: Array.from({ length: 501 }, () => log) }]) {
      expect(() => parsePostaMoldovei(payload, NUMBER), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('documents every mapped wording', () => {
    const documented = new Map(statuses.entries.map((entry) => [entry.wording, entry.stage]));
    expect(Object.entries(POSTA_MOLDOVEI_EVENTS).filter(([wording, stage]) => documented.get(wording) !== stage)).toEqual([]);
    expect(documented.size).toBe(Object.keys(POSTA_MOLDOVEI_EVENTS).length);
  });
});

describe('Poșta Moldovei browser adapter', () => {
  it('requests only the exact public page and the item\'s call within the caller budget', async () => {
    const { scrape, tracker } = mock();
    expect((await tracker.fetch(NUMBER, { budgetMs: 40_000 })).events).toHaveLength(9);
    expect(scrape).toHaveBeenCalledOnce();
    const [request, options] = scrape.mock.calls[0]!;
    expect(request).toMatchObject({ url: `https://posta.md/en/track-trace/mailing/${NUMBER}`, skipHttp: true, maxTier: 3,
      captureResponses: [`https://trimiteri-api.posta.md/public/track/${NUMBER}`] });
    expect(request.maxTimeout).toBeGreaterThan(24_000);
    expect(request.maxTimeout).toBeLessThanOrEqual(25_000);
    expect(request.settleTimeout).toBeLessThanOrEqual(20_000);
    expect(options).toMatchObject({ timeoutMs: request.maxTimeout, requireSolved: false });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(postaMoldoveiTrackingUrl(` ${DOMESTIC.toLowerCase()} `)).toBe(`https://posta.md/en/track-trace/mailing/${DOMESTIC}`);
  });

  it('takes no other item\'s reply, and a page that sent no call failed its check', async () => {
    for (const url of [api.replace(NUMBER, 'RB123456794DE'), `${api}?lang=en`, `${api}#x`, api.replace('trimiteri-api.posta.md', 'example.invalid'),
      api.replace('https:', 'http:'), api.replace('public/track', 'public/tracks'), 'not a url']) {
      await expect(mock(response([capture({ url })])).tracker.fetch(NUMBER), url).rejects.toMatchObject({ kind: 'challenge' });
    }
    await expect(mock(response([])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(mock(response([capture({ status: 204 })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(mock(response([capture()], { statusCode: 403 })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(mock(response([capture()], { tier: 1 })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(mock(response(Array.from({ length: 11 }, () => capture()))).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps the latest capture when the page asked again', async () => {
    const result = await mock(response([capture({ status: 404, body: '{"message":"Not found."}' }), capture({ body: JSON.stringify(customs) })]))
      .tracker.fetch(NUMBER);
    expect(result.last_status_text).toBe('Sosirea la oficiul de livrare');
  });

  it('keeps upstream failures and the ambiguous not-found apart from an answer', async () => {
    for (const [status, kind] of [[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate']] as const) {
      await expect(mock(response([capture({ status, headers: { 'retry-after': '2' }, body: '{}' })])).tracker.fetch(NUMBER), String(status))
        .rejects.toMatchObject({ kind });
    }
    await expect(mock(response([capture({ status: 429, headers: { 'retry-after': '2' } })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ retryAfterMs: 2_000 });
    const notFound = await mock(response([capture({ status: 404, body: '{"message":"Not found."}' })])).tracker.fetch(NUMBER).catch((error: unknown) => error);
    expect(notFound).toBeInstanceOf(NoHistoryError);
    expect((notFound as NoHistoryError).reason).toBeUndefined();
    for (const changed of [{ body: null }, { error: 'read failed' }, { truncated: true }, { base64Encoded: true }, { status: 301 }]) {
      await expect(mock(response([capture(changed)])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    }
    for (const body of ['{', 'x'.repeat(1_000_001), '[]']) {
      await expect(mock(response([capture({ body })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('does not dispatch without a service, valid input, usable budget or active signal', async () => {
    await expect(new PostaMoldoveiTracker({ trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const { tracker, scrape } = mock();
    for (const input of ['invalid', 'RB123456784DE', 'DS0000000000XX', 'RB123456785DE'.repeat(5)]) {
      await expect(tracker.fetch(input), input).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(tracker.fetch(NUMBER, { budgetMs: 15_000 })).rejects.toMatchObject({ kind: 'budget' });
    for (const budgetMs of [Infinity, 0, 60_001]) await expect(tracker.fetch(NUMBER, { budgetMs })).rejects.toBeInstanceOf(TypeError);
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(scrape).not.toHaveBeenCalled();
  });

  it('cancels in-flight browser work through the client transport', async () => {
    const controller = new AbortController();
    let sent: Record<string, unknown> | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        controller.abort(new Error('caller cancelled'));
      });
    });
    const tracker = new PostaMoldoveiTracker({ trawl: new TrawlClient('http://browser.invalid', fetcher) });
    await expect(tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('caller cancelled');
    expect(sent).toMatchObject({ captureResponses: [api], url: postaMoldoveiTrackingUrl(NUMBER) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('registers the trawl step through the normal adapter contract', async () => {
    const { scrape } = mock(response([capture({ url: postaMoldoveiApiUrl(DOMESTIC) })]));
    const instance = adapter({ trawl: { scrape }, recorder: undefined } as unknown as AdapterEnvironment);
    expect(instance.id).toBe('posta-moldovei'); expect(instance.steps).toEqual(['trawl']);
    expect((await instance.track({ number: DOMESTIC })).status).toBe('in_transit');
    expect(parseTrackingInput(postaMoldoveiTrackingUrl(DOMESTIC))).toMatchObject({ carrier: 'posta-moldovei', trackingNumber: DOMESTIC, source: 'link' });
  });

  it('takes over mail another post reports bound for Moldova', () => {
    expect(deliveryHandoff('dhl', NUMBER, { status: 'in_transit', destination_country: 'MD' }))
      .toEqual({ carrier: 'posta-moldovei', number: NUMBER, basis: 'destination' });
  });
});

it('preserves the feed order across foreign local clocks', () => {
  const log = customs.shipping_logs[0]!;
  const result = parsePostaMoldovei({ shipping_logs: [
    { ...log, created_at: '2026-03-03T09:00:00Z', description: 'Customs inspection', additional_description: 'US' },
    { ...log, created_at: '2026-03-03T11:00:00Z', description: 'Dispatch', additional_description: 'China' },
  ] }, NUMBER);
  expect(result.last_status_text).toBe('Customs inspection');
  expect(result.events![0]!.location).toBe('US');
});
