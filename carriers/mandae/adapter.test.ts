import { describe, expect, it, vi } from 'vitest';
import jtHub from './fixtures/delivered-jt-hub.json' with { type: 'json' };
import totalExpress from './fixtures/delivered-total-express.json' with { type: 'json' };
import { adapter, MandaeTracker, mandaeApiUrl, mandaeTrackingUrl, parseMandae } from './adapter.js';
import { MANDAE_EVENTS, MANDAE_ORDER_STATES } from './status.js';
import { TrawlClient } from '../../core/transport/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import type { AdapterEnvironment } from '../../core/adapter/index.js';
import { parseTrackingInput } from '../../core/detection/parse.js';
import statuses from './statuses.json' with { type: 'json' };

// The fixtures are public samples' replies, which name their codes; the partner's code is the one
// the hand-over scan names. SYNTHETIC is a code no reply names.
const NUMBER = jtHub.codigoRastreamento;
const PARTNER = /com o código (\w+)/.exec(jtHub.historico.at(-1)!.complemento)![1]!;
const SYNTHETIC = 'ZZTEST00000001';
const api = mandaeApiUrl(NUMBER);
const capture = (overrides: Record<string, unknown> = {}) => ({ url: api, status: 200, headers: {}, body: JSON.stringify(jtHub), ...overrides });
const response = (captures = [capture()], overrides: Record<string, unknown> = {}) => ({ tier: 2, statusCode: 200,
  capturedResponses: captures, ...overrides });
const mock = (value = response()) => {
  const scrape = vi.fn().mockResolvedValue(value);
  return { scrape, tracker: new MandaeTracker({ trawl: { scrape } as unknown as TrawlClient }) };
};
const scans = jtHub.historico;

describe('Mandaê parser', () => {
  it('reads a delivered parcel with the offsets Rastreaê states and each title\'s stage', () => {
    const result = parseMandae(jtHub, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entrega realizada', last_update: '2026-10-27T15:25:57-03:00', expected_delivery: null });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result.events!.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit',
      'in_transit', 'in_transit', 'in_transit']);
    expect(result.events!.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00$/.test(event.time!) && !event.local_time)).toBe(true);
    expect(result.events!.at(-1)).toEqual({ time: '2026-10-20T19:02:27-03:00', description: 'Encomenda encaminhada', stage: 'in_transit',
      stage_source: 'carrier_map' });
  });

  it('reads an older parcel processed at the partner\'s unit', () => {
    const result = parseMandae(totalExpress, totalExpress.codigoRastreamento);
    expect(result.events).toHaveLength(6);
    expect(result.events!.map((event) => event.description).slice(-2)).toEqual(['Encomenda processada', 'Encomenda recebida na unidade da transportadora']);
    expect(result.events!.at(-1)!.time).toBe('2018-03-16T19:58:57-03:00');
  });

  it('answers the partner\'s code with Mandaê\'s record and its own code, and no other record', () => {
    const result = parseMandae(jtHub, PARTNER);
    expect(result).toMatchObject({ status: 'delivered', canonical_tracking_number: NUMBER });
    expect(result.events).toHaveLength(7);
    expect(() => parseMandae(jtHub, SYNTHETIC)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMandae(totalExpress, PARTNER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('lets a finished or troubled order state lead, and the scans otherwise', () => {
    expect(parseMandae({ ...jtHub, situacaoEncomenda: 'DevolvidaParaRemetente' }, NUMBER)).toMatchObject({ status: 'exception',
      current_stage: 'returned', current_stage_source: 'carrier_map', last_status_text: 'Devolvida para remetente' });
    const onTheWay = { ...jtHub, situacaoEncomenda: 'Enviada', historico: scans.slice(1) };
    expect(parseMandae(onTheWay, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Encomenda em rota final', expected_delivery: '2026-11-06' });
    // A state that says too little leaves the scans' stage, and an unknown one too.
    for (const state of ['EmProcessamento', 'Pendente', 'Expirada', 'NovoEstado']) {
      expect(parseMandae({ ...onTheWay, situacaoEncomenda: state }, NUMBER).current_stage, state).toBe('out_for_delivery');
    }
    const unknownOnly = { ...jtHub, situacaoEncomenda: 'Coletada', historico: [{ ...scans[0]!, descricao: 'Synthetic unknown handling' }] };
    expect(parseMandae(unknownOnly, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Coletada' });
  });

  it('never reads the sentences, the partner\'s name or the milestones', () => {
    const text = JSON.stringify(parseMandae(jtHub, NUMBER));
    for (const hidden of ['Muito bem', 'JT_HUB', PARTNER, 'Em separação']) expect(text).not.toContain(hidden);
  });

  it('keeps a repeated scan once and leaves an unknown title visible', () => {
    const result = parseMandae({ ...jtHub, historico: [scans[0], scans[0], { ...scans[0]!, descricao: 'Synthetic unknown handling' }] }, NUMBER);
    expect(result.events).toHaveLength(2);
    expect(result.events!.find((event) => !event.stage)).toEqual({ time: '2026-10-27T15:25:57-03:00', description: 'Synthetic unknown handling' });
  });

  it('treats a listed order without scans as no history and a changed reply as schema drift', () => {
    expect(() => parseMandae({ ...jtHub, situacaoEncomenda: 'Nova', historico: [] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    const scan = scans[0]!;
    for (const payload of [null, {}, { ...jtHub, historico: {} }, { ...jtHub, historico: [null] }, { ...jtHub, historico: [{ ...scan, descricao: '' }] },
      { ...jtHub, historico: [{ ...scan, descricao: 3 }] }, { ...jtHub, historico: [{ ...scan, dataHora: '2026-10-27T15:25:57' }] },
      { ...jtHub, historico: [{ ...scan, dataHora: '2026-02-30T15:25:57-03:00' }] }, { ...jtHub, historico: [{ ...scan, complemento: 4 }] },
      { ...jtHub, codigoRastreamento: undefined }, { ...jtHub, codigoRastreamento: 'X' }, { ...jtHub, situacaoEncomenda: 'Entregue!' },
      { ...jtHub, historico: Array.from({ length: 501 }, () => scan) }]) {
      expect(() => parseMandae(payload, NUMBER), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('documents every mapped title and order state', () => {
    const titles = new Map(statuses.entries.filter((entry) => !('code' in entry) || entry.code === 'encomenda_enviada')
      .map((entry) => [entry.wording, entry.stage]));
    expect(Object.entries(MANDAE_EVENTS).filter(([wording, stage]) => titles.get(wording) !== stage)).toEqual([]);
    expect(titles.size).toBe(Object.keys(MANDAE_EVENTS).length);
    const states = statuses.entries.filter((entry) => 'code' in entry && entry.code !== 'encomenda_enviada');
    expect(states).toHaveLength(16);
    expect(Object.fromEntries(states.filter((entry) => entry.stage).map((entry) => [entry.code, entry.stage]))).toEqual(MANDAE_ORDER_STATES);
  });
});

describe('Mandaê browser adapter', () => {
  it('requests only the exact public page and the code\'s call within the caller budget', async () => {
    const { scrape, tracker } = mock();
    expect((await tracker.fetch(NUMBER, { budgetMs: 40_000 })).events).toHaveLength(7);
    expect(scrape).toHaveBeenCalledOnce();
    const [request, options] = scrape.mock.calls[0]!;
    expect(request).toMatchObject({ url: `https://rastreae.com.br/resultado/${NUMBER}`, skipHttp: true, maxTier: 3,
      captureResponses: [`https://rastreae.api.mandae.com.br/v2/rastreamentos/${NUMBER}`] });
    expect(request.maxTimeout).toBeGreaterThan(24_000);
    expect(request.maxTimeout).toBeLessThanOrEqual(25_000);
    expect(request.settleTimeout).toBeLessThanOrEqual(20_000);
    expect(options).toMatchObject({ timeoutMs: request.maxTimeout, requireSolved: false });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(mandaeTrackingUrl(` ${SYNTHETIC.toLowerCase()} `)).toBe(`https://rastreae.com.br/resultado/${SYNTHETIC}`);
  });

  it('takes no other code\'s reply, and a page whose call was only challenged failed its check', async () => {
    for (const url of [mandaeApiUrl(SYNTHETIC), `${api}?perfil=DESTINATARIO`, `${api}#x`, api.replace('rastreae.api.mandae.com.br', 'example.invalid'),
      api.replace('https:', 'http:'), api.replace('/v2/', '/v3/'), 'not a url']) {
      await expect(mock(response([capture({ url })])).tracker.fetch(NUMBER), url).rejects.toMatchObject({ kind: 'challenge' });
    }
    await expect(mock(response([])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const challenged = capture({ status: 202, headers: { 'x-amzn-waf-action': 'challenge' }, body: '' });
    await expect(mock(response([challenged])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect((await mock(response([challenged, capture()])).tracker.fetch(NUMBER)).status).toBe('delivered');
    await expect(mock(response([capture()], { statusCode: 403 })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(mock(response([capture()], { tier: 1 })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(mock(response(Array.from({ length: 11 }, () => capture()))).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps upstream failures and the not-found apart from an answer', async () => {
    for (const [status, kind] of [[401, 'challenge'], [403, 'challenge'], [405, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'],
      [503, 'maintenance']] as const) {
      await expect(mock(response([capture({ status, headers: { 'retry-after': '2' }, body: '{}' })])).tracker.fetch(NUMBER), String(status))
        .rejects.toMatchObject({ kind });
    }
    await expect(mock(response([capture({ status: 429, headers: { 'retry-after': '2' } })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ retryAfterMs: 2_000 });
    const notFound = await mock(response([capture({ status: 404, body: '{"error":{"code":"404","message":"Not found"}}' })])).tracker.fetch(NUMBER)
      .catch((error: unknown) => error);
    expect(notFound).toBeInstanceOf(NoHistoryError);
    expect((notFound as NoHistoryError).reason).toBe('portal_not_found');
    for (const changed of [{ body: null }, { error: 'read failed' }, { truncated: true }, { base64Encoded: true }, { status: 301 }]) {
      await expect(mock(response([capture(changed)])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    }
    for (const body of ['{', 'x'.repeat(1_000_001), '[]']) {
      await expect(mock(response([capture({ body })])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('does not dispatch without a service, valid input, usable budget or active signal', async () => {
    await expect(new MandaeTracker({ trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const { tracker, scrape } = mock();
    for (const input of ['ab12', 'ZZ/TEST/0001', 'Z'.repeat(41), SYNTHETIC.repeat(5)]) {
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
    const tracker = new MandaeTracker({ trawl: new TrawlClient('http://browser.invalid', fetcher) });
    await expect(tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('caller cancelled');
    expect(sent).toMatchObject({ captureResponses: [api], url: mandaeTrackingUrl(NUMBER) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('registers the trawl step through the normal adapter contract', async () => {
    const { scrape } = mock(response([capture({ url: mandaeApiUrl(PARTNER) })]));
    const instance = adapter({ trawl: { scrape }, recorder: undefined } as unknown as AdapterEnvironment);
    expect(instance.id).toBe('mandae'); expect(instance.steps).toEqual(['trawl']);
    expect(await instance.track({ number: PARTNER })).toMatchObject({ status: 'delivered', canonical_tracking_number: NUMBER });
    expect(parseTrackingInput(mandaeTrackingUrl(SYNTHETIC))).toMatchObject({ carrier: 'mandae', trackingNumber: SYNTHETIC, source: 'link' });
  });
});

it('reports a missing tracking endpoint as a transport failure', async () => {
  for (const status of [404, 410]) {
    const fetcher = async () => Response.json({ html: '', tier: 2, statusCode: status, capturedResponses: [] });
    const tracker = new MandaeTracker({ trawl: new TrawlClient('http://browser.invalid', fetcher) });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  }
});
