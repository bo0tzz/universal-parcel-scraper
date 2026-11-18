import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CorreosBoliviaTracker, CORREOS_BOLIVIA_ENDPOINT } from './adapter.js';
import { normalizeCorreosBoliviaNumber, parseCorreosBolivia } from './parser.js';
import { correosBoliviaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
const NUMBER = 'ZZ000000014BO';
const UNKNOWN = 'ZZ000000028BO';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/public-events.json', import.meta.url), 'utf8'));
const absent = () => JSON.parse(readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8'));
const response = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('Correos de Bolivia mobile guest tracking', () => {
  it('orders scans at the same office by its local clock', () => {
    const result = parseCorreosBolivia(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage_source: 'carrier_map', service_name: 'ORDINARIAS',
      last_update: null, last_update_local: '2024-05-07T13:30:00' });
    expect(result.events).toHaveLength(3);
    expect(result.events!.map(e => e.local_time)).toEqual(['2024-05-07T13:30:00', '2024-05-07T09:59:00', '2024-05-07T08:59:00']);
    expect(result.events!.every(e => e.location === 'FRCDGA - France' && !e.time && !e.time_zone)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/2024-05-10|captura|user_id|aviso_pago_qr|sort_at/);
  });
  it('checks every identity and the unique, complete result', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.filtro.codigo = UNKNOWN; },
      (p: ReturnType<typeof fixture>) => { p.resultado[0].codigo = UNKNOWN; },
      (p: ReturnType<typeof fixture>) => { p.resultado[0].eventos[0].codigo = UNKNOWN; },
    ]) { const p = fixture(); mutate(p); expect(() => parseCorreosBolivia(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' })); }
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.resultado.push(p.resultado[0]); },
      (p: ReturnType<typeof fixture>) => { p.total_registros++; },
      (p: ReturnType<typeof fixture>) => { p.resultado[0].total_eventos++; },
      (p: ReturnType<typeof fixture>) => { p.resultado[0].eventos[0].created_at = '2024-02-31 09:59:00'; },
      (p: ReturnType<typeof fixture>) => { p.resultado[0].eventos[0].nombre_evento = ''; },
    ]) { const p = fixture(); mutate(p); expect(() => parseCorreosBolivia(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' })); }
  });
  it('accepts absence only when it explicitly names the same whole item', () => {
    expect(() => parseCorreosBolivia(absent(), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCorreosBolivia(absent(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const p = absent(); p.message = 'Temporalmente no disponible';
    expect(() => parseCorreosBolivia(p, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = fixture(); empty.total_registros = empty.resultado[0].total_eventos = 0; empty.resultado[0].eventos = [];
    expect(() => parseCorreosBolivia(empty, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });
  it('retains unmapped wording without inventing a stage and covers observed mappings', () => {
    for (const entry of statuses.entries) expect(correosBoliviaStage(entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
    const p = fixture(); p.resultado[0].eventos[2].nombre_evento = 'Aviso particular desconocido';
    expect(parseCorreosBolivia(p, NUMBER).events![0]).not.toHaveProperty('stage');
  });
  it('sends one supplied-transport guest query without tokens and refuses other input before traffic', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const tracker = new CorreosBoliviaTracker({ fetcher, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' zz 000 000 014 bo ')).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CORREOS_BOLIVIA_ENDPOINT}?codigo=${NUMBER}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    for (const raw of ['', '123456789', NUMBER + 'A', 'x'.repeat(100)]) expect(() => normalizeCorreosBoliviaNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s failure kind', async (status, kind) => {
    await expect(new CorreosBoliviaTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({}, status)) }).fetch(NUMBER)).rejects.toMatchObject({ kind });
  });
  it('distinguishes structured absence from removed endpoints, HTML challenges and malformed responses', async () => {
    for (const [body, status, kind] of [[absent(), 404, 'not_found'], ['<html>Not Found</html>', 404, 'transport'],
      ['<html>Verify</html>', 200, 'challenge'], ['{broken', 200, 'schema'], [fixture(), 404, 'schema']] as const) {
      await expect(new CorreosBoliviaTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, status)) }).fetch(status === 404 && body !== null && typeof body === 'object' && 'existe_paquete' in body && body.existe_paquete === false ? UNKNOWN : NUMBER)).rejects.toMatchObject({ kind });
    }
  });
  it('honors cancellation before and during requests and bounds a hanging request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const c = new AbortController(); c.abort();
    await expect(new CorreosBoliviaTracker({ fetcher }).fetch(NUMBER, { signal: c.signal })).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
    const active = new AbortController(); const pending = new CorreosBoliviaTracker({ fetcher }).fetch(NUMBER, { signal: active.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); active.abort(); await expect(pending).rejects.toBeDefined();
    await expect(new CorreosBoliviaTracker({ fetcher }).fetch(NUMBER, { budgetMs: 15 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:budget|transport)$/) });
  });
});

it('preserves source sequence across different office clocks', () => {
  const payload = fixture();
  payload.resultado[0].eventos[1].office = 'Another office';
  expect(parseCorreosBolivia(payload, NUMBER).last_update_local).toBe('2024-05-07T09:59:00');
});
