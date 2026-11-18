import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { TsbTracker } from './adapter.js';
import { normalizeTsbNumber, parseTsb, parseTsbReply, tsbUrl } from './parser.js';
import { statusMap, tsbSituation, tsbState, tsbStep } from './status.js';

const NUMBER = 'TSB0000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code: string; wording: string; stage: string; language: 'en' | 'es' | 'ca' }[] };
const MISSING = { error: 'tracking.notFound', num: NUMBER, expedicion: null };
const at = (clock: string) => Date.parse(clock);
// The shipment without a stated situation, as the public page reads it: by its rail alone.
const rail = (edit: (data: ReturnType<typeof fixture>) => void = () => {}) => changed(d => { delete d.expedicion.estadoExpedicion; edit(d); });

describe('TSB guest adapter', () => {
  it('asks for the whole number once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new TsbTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://www.tsbconnect.net/tracking/find?number=${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(init!.method).toBeUndefined();
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tsb-es', step: 'direct', outcome: 'ok' }));
    expect(tsbUrl('TSB_0000-1')).toBe('https://www.tsbconnect.net/tracking/find?number=TSB_0000-1');
  });

  it('reads the dated steps of the rail newest first, under the shipment\'s stated situation', () => {
    expect(parseTsb(fixture(), NUMBER)).toEqual({ status: languageStageStatus('out_for_delivery'), current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'REPARTO', provider_code: 'REPA', receiver_name: 'Synthetic Recipient', receiver_address: 'Synthetic Street 2\n00001 Synthetic City', last_update: '2026-03-03T07:30:00Z', expected_delivery: null,
      events: [
        { time: '2026-03-03T07:30:00Z', description: 'En Reparto', provider_code: 'reparto', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-03-03T05:40:00Z', description: 'Llegada en destino', provider_code: 'llegada', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T21:10:00Z', description: 'Salida de origen', provider_code: 'salida', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T18:20:00Z', description: 'Recepción', provider_code: 'recepcion', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-03-02T15:05:00Z', description: 'Creada', provider_code: 'alta', stage: 'registered', stage_source: 'carrier_map' },
      ] });
    expect(parseTsb(fixture(), NUMBER, 'en')).toMatchObject({ last_status_text: 'IN DELIVERY', events: expect.arrayContaining([expect.objectContaining({ description: 'On Delivery' }), expect.objectContaining({ description: 'Recorded' })]) });
    expect(parseTsb(fixture(), NUMBER, 'ca')).toMatchObject({ last_status_text: 'REPARTIMENT', events: expect.arrayContaining([expect.objectContaining({ description: 'Arribada Destí' })]) });
    // Without a stated situation the newest step says where the shipment stands.
    const plain = parseTsb(rail(), NUMBER);
    expect(plain).toMatchObject({ status: languageStageStatus('out_for_delivery'), current_stage: 'out_for_delivery', last_status_text: 'En Reparto', last_update: '2026-03-03T07:30:00Z' });
    expect(plain.provider_code).toBeUndefined();
    expect(parseTsb(rail(d => { d.expedicion.fechaReparto = null; d.expedicion.fechaLlegada = null; }), NUMBER)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Salida de origen', events: expect.objectContaining({ length: 3 }) });
    // Steps on one clock keep the rail's order.
    const tied = parseTsb(rail(d => { d.expedicion.fechaRecepcion = d.expedicion.fechaAlta; }), NUMBER);
    expect(tied.events!.slice(-2).map(event => event.provider_code)).toEqual(['recepcion', 'alta']);
  });

  it('reads the recipient\'s name and address, and never the sender, a reference, a remark or a position', () => {
    const data = changed(d => {
      Object.assign(d.expedicion, { nombreRemitente: 'PRIVATE SENDER', nombreDestinatario: 'PRIVATE RECIPIENT', referenciaCliente: 'PRIVATEREF', observaciones2: 'PRIVATE REMARK', fechaEntregaConcertada: 'PRIVATE DATE' });
      d.expedicion.direccionDestinatario = { direccion: 'PRIVATE STREET', pais: 'ES', codigoPostal: 'PRIVATEZIP', poblacion: 'PRIVATE TOWN' };
      d.expedicion.direccionRemitente.direccion = 'PRIVATE STREET';
      d.expedicion.imagenesPOD = [{ url: 'PRIVATE POD' }];
      d.expedicion.eventos = [{ tipoEvento: 'BBTR', fechaEvento: at('2026-03-03T09:00:00Z'), objeto1: 'PRIVATE LAT', objeto4: 'PRIVATE LON' },
        { tipoEvento: 'SACO', fechaEvento: at('2026-03-02T22:00:00Z'), objeto5: 'PRIVATE PARTNER NOTE' }];
      d.corresponsalOrigen.delegacionNombre = 'PRIVATE PLATFORM'; d.corresponsalDestino.razonSocial = 'PRIVATE COMPANY'; d.corresponsalDestino.email = 'PRIVATE@example.invalid';
    });
    const result = parseTsb(data, NUMBER);
    expect(result.events).toHaveLength(6);
    expect(result).toMatchObject({ receiver_name: 'PRIVATE RECIPIENT', receiver_address: 'PRIVATE STREET\nPRIVATEZIP PRIVATE TOWN' });
    expect(JSON.stringify({ ...result, receiver_name: null, receiver_address: null })).not.toMatch(/PRIVATE|example\.invalid/);
    // Only the parts the shipment gives are kept.
    expect(parseTsb(changed(d => { d.expedicion.direccionDestinatario = { poblacion: 'Synthetic City' }; delete d.expedicion.nombreDestinatario; }), NUMBER))
      .toMatchObject({ receiver_address: 'Synthetic City' });
    expect(parseTsb(changed(d => { d.expedicion.direccionDestinatario = null; d.expedicion.nombreDestinatario = null; }), NUMBER)).not.toHaveProperty('receiver_address');
  });

  it('adds an international departure and renames the arrival of such a shipment, as the page does', () => {
    const abroad = parseTsb(changed(d => { d.expedicion.eventos = [{ tipoEvento: 'ALTA', fechaEvento: 'unread' }, { tipoEvento: 'SACO', fechaEvento: at('2026-03-02T22:00:00Z'), objeto5: 'Synthetic note' }]; }), NUMBER, 'en');
    expect(abroad.events!.map(event => [event.provider_code, event.description, event.stage])).toEqual([
      ['reparto', 'On Delivery', 'out_for_delivery'], ['llegadaAlmacenInternacional', 'Arrival International', 'in_transit'], ['SACO', 'INTERNATIONAL DEPARTURE', 'in_transit'],
      ['salida', 'Departure', 'in_transit'], ['recepcion', 'Reception', 'accepted'], ['alta', 'Recorded', 'registered']]);
    expect(abroad.events![2]!.time).toBe('2026-03-02T22:00:00Z');
    expect(() => parseTsb(changed(d => { d.expedicion.eventos = [{ tipoEvento: 'SACO', fechaEvento: null }]; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(parseTsb(changed(d => { delete d.expedicion.eventos; }), NUMBER).events).toHaveLength(5);
  });

  it('dates a delivery and a failed round by their own steps', () => {
    const delivered = parseTsb(changed(d => { d.expedicion.fechaEntrega = at('2026-03-03T10:15:00Z'); d.expedicion.estadoExpedicion = 'estados.padua.situacion.ENTR'; }), NUMBER);
    expect(delivered).toMatchObject({ status: languageStageStatus('delivered'), current_stage: 'delivered', last_status_text: 'ENTREGADA', provider_code: 'ENTR',
      last_update: '2026-03-03T10:15:00Z', delivered_at: '2026-03-03T10:15:00Z' });
    expect(delivered.events![0]).toEqual({ time: '2026-03-03T10:15:00Z', description: 'Entregada', provider_code: 'entrega', stage: 'delivered', stage_source: 'carrier_map' });
    expect(parseTsb(rail(d => { d.expedicion.fechaEntrega = at('2026-03-03T10:15:00Z'); }), NUMBER, 'en')).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', delivered_at: '2026-03-03T10:15:00Z' });
    // A delivery the situation states without a dated step has no delivery moment.
    const undated = parseTsb(changed(d => { d.expedicion.estadoExpedicion = 'estados.padua.situacion.BBEN'; }), NUMBER, 'en');
    expect(undated).toMatchObject({ current_stage: 'delivered', last_status_text: 'DELIVERED', provider_code: 'BBEN', last_update: '2026-03-03T07:30:00Z' });
    expect(undated.delivered_at).toBeUndefined();
    const failed = parseTsb(rail(d => { d.expedicion.fechaRepartoFallida = at('2026-03-03T09:45:00Z'); }), NUMBER, 'en');
    expect(failed).toMatchObject({ status: languageStageStatus('failed_attempt'), current_stage: 'failed_attempt', last_status_text: 'FAILED DELIVERY', last_update: '2026-03-03T09:45:00Z' });
    expect(failed.events![0]).toEqual({ time: '2026-03-03T09:45:00Z', description: 'FAILED DELIVERY', provider_code: 'repartoFallida', stage: 'failed_attempt', stage_source: 'carrier_map' });
    // A stated situation outranks the rail: a shipment sent back after its round is a return.
    expect(parseTsb(changed(d => { d.expedicion.estadoExpedicion = 'estados.padua.situacion.DENT'; }), NUMBER, 'en'))
      .toMatchObject({ status: languageStageStatus('returned'), current_stage: 'returned', last_status_text: 'RETURNED', provider_code: 'DENT' });
    expect(parseTsb(changed(d => { d.expedicion.estadoExpedicion = 'estados.padua.situacion.ANUL'; }), NUMBER)).toMatchObject({ current_stage: 'exception', last_status_text: 'ANULADA' });
  });

  it('reads a state of the sender\'s system, a shipment without a dated step, and ignores a situation it does not know', () => {
    const none = (estadoExpedicion: unknown) => changed(d => { for (const key of Object.keys(d.expedicion)) if (key.startsWith('fecha')) d.expedicion[key] = null; d.expedicion.estadoExpedicion = estadoExpedicion; });
    expect(parseTsb(none('E2'), NUMBER)).toEqual({ status: languageStageStatus('registered'), current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'GRABADA', provider_code: 'grabacion', receiver_name: 'Synthetic Recipient', receiver_address: 'Synthetic Street 2\n00001 Synthetic City', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    expect(parseTsb(none('E1'), NUMBER, 'en')).toMatchObject({ current_stage: 'registered', last_status_text: 'COMMUNICATED', provider_code: 'comunicada', summary_only: true });
    expect(parseTsb(none('estados.padua.situacion.ALTA'), NUMBER, 'ca')).toMatchObject({ current_stage: 'registered', last_status_text: 'PENDENT', provider_code: 'ALTA' });
    for (const unread of ['estados.padua.situacion.SYNTH', 'estados.other.ENTR', 'entregada', 'e2', 'E 2', '', 4, null, {}]) {
      expect(parseTsb(changed(d => { d.expedicion.estadoExpedicion = unread; }), NUMBER)).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'En Reparto' });
      expect(() => parseTsb(none(unread), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(tsbState('estados.padua.situacion.REPA')).toMatchObject({ code: 'REPA' });
    // The script reads any state that starts with a capital E as the sender system's.
    expect(tsbState('ENTR')).toMatchObject({ code: 'comunicada' });
  });

  it('rejects a reply that names another shipment', () => {
    for (const own of ['TSB0000002', `${NUMBER}1`, `1${NUMBER}`, '', 42, {}, [NUMBER]]) {
      expect(() => parseTsb(changed(d => { d.num = own; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const own of [NUMBER, NUMBER.toLowerCase(), ' tsb 0000001 ', 'TSB-0000001', 'TSB_0000001']) expect(parseTsb(changed(d => { d.num = own; }), NUMBER).events).toHaveLength(5);
    expect(parseTsb(changed(d => { d.num = 1234567; d.expedicion.numeroExpedicion = d.num; }), '1234567').events).toHaveLength(5);
    expect(() => parseTsb(changed(d => { d.expedicion.numeroExpedicion = 'OTHER'; d.expedicion.referenciaCliente = 'UNRELATED'; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // Without the echo the shipment must carry the number as its own or as its reference.
    expect(parseTsb(changed(d => { delete d.num; }), NUMBER).events).toHaveLength(5);
    expect(parseTsb(changed(d => { delete d.num; d.expedicion.numeroExpedicion = '0000042'; d.expedicion.referenciaCliente = NUMBER; }), NUMBER).events).toHaveLength(5);
    expect(() => parseTsb(changed(d => { delete d.num; d.expedicion.numeroExpedicion = '0000042'; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTsb(changed(d => { delete d.num; delete d.expedicion.numeroExpedicion; delete d.expedicion.referenciaCliente; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a date that is not a moment in milliseconds, a malformed event list and an unexplained error', () => {
    for (const data of [changed(d => { d.expedicion.fechaAlta = '2026-03-02T15:05:00'; }), changed(d => { d.expedicion.fechaAlta = '1772463900000'; }),
      changed(d => { d.expedicion.fechaAlta = 1772463900; }), changed(d => { d.expedicion.fechaEntrega = 0; }), changed(d => { d.expedicion.fechaRepartoFallida = true; }),
      changed(d => { d.expedicion.fechaLlegada = 1e13; }), changed(d => { d.expedicion.fechaSalida = {}; }),
      changed(d => { d.expedicion.eventos = {}; }), changed(d => { d.expedicion.eventos = [null]; }), changed(d => { d.expedicion.eventos = ['SACO']; }),
      changed(d => { d.expedicion.eventos = Array(501).fill({ tipoEvento: 'ALTA' }); }),
      changed(d => { d.error = 'tracking.synthetic'; }), changed(d => { d.error = 'tracking.notFound'; }), changed(d => { d.error = true; }),
      changed(d => { d.expedicion = null; }), changed(d => { d.expedicion = []; }), changed(d => { d.expedicion = 'shipment'; }), changed(d => { delete d.expedicion; }),
      null, [], [fixture()], 'shipment', {}, { data: fixture() }]) {
      expect(() => parseTsb(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('tells a missing shipment from a moved service, a refusal and a page', () => {
    expect(() => parseTsbReply(200, JSON.stringify(MISSING), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTsbReply(200, JSON.stringify({ error: 'tracking.notFound', num: NUMBER }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    // A missing-shipment answer for another number is not this number's.
    expect(() => parseTsbReply(200, JSON.stringify({ ...MISSING, num: 'TSB0000002' }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTsbReply(200, JSON.stringify({ error: 'tracking.notFound', expedicion: null }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTsbReply(404, JSON.stringify(MISSING), NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTsbReply(404, '<!doctype html><title>404</title>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTsbReply(200, '<!doctype html><html><head><title>Seguimiento de expediciones</title></head><body><div id="root"></div></body></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTsbReply(200, '<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(parseTsbReply(200, JSON.stringify(fixture()), NUMBER, 'en').last_status_text).toBe('IN DELIVERY');
  });

  it('maps every step and situation of the script to its stage, in its three languages', () => {
    expect(statuses.entries).toHaveLength(93);
    for (const entry of statuses.entries) {
      const known = tsbStep(entry.code) ?? tsbSituation(entry.code) ?? tsbState(entry.code === 'grabacion' ? 'E2' : 'E1')!.status;
      expect(known[entry.language]).toBe(entry.wording);
      expect(known.stage).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
      expect(STAGES).toContain(entry.stage);
    }
    expect(new Set(statuses.entries.map(entry => entry.code)).size).toBe(31);
    expect(tsbStep('ENTR')).toBeUndefined();
    expect(tsbSituation('entrega')).toBeUndefined();
    expect(statusMap.stage(null, 'Entregada')).toBeUndefined();
    expect(statusMap.stage('SYNTH', 'Entregada')).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status, { 'retry-after': '60' }));
    await expect(new TsbTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports the service\'s own missing-shipment reply as not found, and a page as a changed service', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(response(MISSING));
    await expect(new TsbTracker({ fetcher: missing }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing).toHaveBeenCalledOnce();
    const page = vi.fn<typeof fetch>().mockResolvedValue(response('<!doctype html><title>Seguimiento de expediciones</title>', 200, { 'content-type': 'text/html' }));
    await expect(new TsbTracker({ fetcher: page }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new TsbTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new TsbTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection in the reader\'s language and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()));
    const tracker = createTracker({ fetcher, env: {}, providers: [] });
    const result = await tracker.track({ carrier: 'tsb-es', number: NUMBER });
    expect(result.source).toBe('tsb-es');
    expect(result.result.events).toHaveLength(5);
    expect(result.result.last_status_text).toBe('REPARTO');
    expect((await tracker.track({ carrier: 'tsb-es', number: NUMBER, language: 'en-GB' })).result.last_status_text).toBe('IN DELIVERY');
    expect((await tracker.track({ carrier: 'tsb-es', number: NUMBER, language: 'ca' })).result.last_status_text).toBe('REPARTIMENT');
    expect((await tracker.track({ carrier: 'tsb-es', number: NUMBER, language: 'fr' })).result.last_status_text).toBe('REPARTO');
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('tsb-es');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('tsb-es');
    for (const number of ['', 'TS1', '-TSB000001', 'TSB 000001', 'TSB/000001', 'TSB000001?', 'T'.repeat(41)]) expect(() => normalizeTsbNumber(number)).toThrow();
    for (const number of [NUMBER, 'tsb0000001', '1234', 'TSB_0000-1']) expect(normalizeTsbNumber(` ${number} `)).toBe(number);
  });
});
