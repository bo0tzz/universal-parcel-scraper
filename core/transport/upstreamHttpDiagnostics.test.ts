// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { fetchBounded, UpstreamHttpError } from './boundedFetch.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function failed(response: Response) {
  return fetchBounded('https://carrier.example/tracking/TEST123', {}, {
    provider: 'La Poste tracking', fetcher: async () => response,
  }).catch((error: unknown) => {
    if (!(error instanceof UpstreamHttpError)) throw error;
    return error;
  }) as Promise<UpstreamHttpError>;
}

it('retains the actual 403 explanation and diagnostic IDs with every response header, credentials redacted', async () => {
  const body = '<h1>Access Denied</h1><p>Reference #18.abc.123</p><a href="https://errors.edgesuite.net/example">Details</a>';
  const error = await failed(new Response(body, { status: 403, headers: {
    'content-type': 'text/html; charset=utf-8', server: 'AkamaiGHost', 'x-request-id': 'request-example-123',
    'set-cookie': 'session=SECRET', authorization: 'Bearer SECRET',
  } }));
  expect(error).toMatchObject({ status: 403, message: 'La Poste tracking returned HTTP 403', diagnostics: {
    content_type: 'text/html', server: 'AkamaiGHost', request_ids: { 'x-request-id': 'request-example-123' },
    body_read: 'complete', body_excerpt: body, body_signals: ['akamai_error_page', 'access_denied'],
  } });
  expect(error.diagnostics?.headers).toMatchObject({ 'set-cookie': '[redacted]', authorization: '[redacted]', server: 'AkamaiGHost' });
});

it.each([
  ['<script>window._cf_chl_opt={}</script>', 'cloudflare_challenge'],
  ['<script src="https://geo.captcha-delivery.com/captcha/">', 'datadome_challenge'],
  ['<div id="px-captcha"></div>', 'perimeterx_challenge'],
])('records a recognized challenge signature without changing the HTTP classification', async (body, signal) => {
  const error = await failed(new Response(body, { status: 403 }));
  expect(error.status).toBe(403);
  expect(error.diagnostics?.body_signals).toContain(signal);
});

it('retains unknown JSON explanations while limiting searchable error codes to known values', async () => {
  for (const code of ['TOKEN_EXPIRED', 'PROVIDER_SPECIFIC_REASON']) {
    const body = JSON.stringify({ error: { code, message: 'Temporary refusal for TEST123' } });
    const error = await failed(new Response(body, { status: 403, headers: { 'content-type': 'application/json' } }));
    expect(error.diagnostics?.body_excerpt).toBe(body);
    expect(error.diagnostics?.error_code).toBe(code === 'TOKEN_EXPIRED' ? code : undefined);
  }
});

it('cancels an oversized chunk at 8 KiB and labels the excerpt as truncated', async () => {
  const cancel = vi.fn();
  const error = await failed(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(20_000) + 'Access Denied')); }, cancel,
  }), { status: 403, headers: { 'content-length': '1' } }));
  expect(error.diagnostics).toMatchObject({ bytes_inspected: 8192, body_read: 'truncated', body_signals: [] });
  expect(error.diagnostics?.body_excerpt).toHaveLength(8192);
  expect(cancel).toHaveBeenCalledOnce();
});

it('returns the original HTTP error after 200 ms even if reading and cancellation hang', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const result = failed(new Response(new ReadableStream({ cancel }), { status: 403 }));
  await vi.advanceTimersByTimeAsync(200);
  expect(await result).toMatchObject({ status: 403, diagnostics: { body_read: 'timed_out', bytes_inspected: 0 } });
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves partial diagnostics and the HTTP status when the body breaks', async () => {
  const error = await failed(new Response(new ReadableStream({
    start(controller) { controller.error(new Error('socket closed')); },
  }), { status: 429, headers: { 'retry-after': '90' } }));
  expect(error).toMatchObject({ status: 429, retryAfterMs: 90_000, diagnostics: { body_read: 'unreadable' } });
});

it('skips binary bodies and does not interpret a bare 403 as a known challenge', async () => {
  const cancel = vi.fn();
  const error = await failed(new Response(new ReadableStream({ cancel }), {
    status: 403, headers: { 'content-type': 'image/png' },
  }));
  expect(error.diagnostics).toMatchObject({ body_read: 'skipped', body_signals: [], bytes_inspected: 0 });
  expect(cancel).toHaveBeenCalledOnce();
  const empty = await failed(new Response(null, { status: 403 }));
  expect(empty.diagnostics).toMatchObject({ body_read: 'empty', body_signals: [] });
});

it('retains request details on HTTP and network failures, without session headers or credential values', async () => {
  const url = 'https://carrier.example/tracking?number=TEST123&token=fixture';
  const init = { method: 'POST', headers: { Cookie: 'session=fixture', Authorization: 'Bearer fixture', Accept: 'text/html' },
    body: 'number=TEST123&postcode=1234&api_key=fixture' };
  for (const fetcher of [
    async () => new Response('Refused TEST123', { status: 403 }),
    async () => { throw new Error('Connection reset'); },
  ]) {
    const error = await fetchBounded(url, init, { provider: 'Test carrier', timeoutMs: 8000, fetcher }).catch(error => error);
    expect(error.request).toEqual({ url: 'https://carrier.example/tracking?number=TEST123&token=[redacted]', method: 'POST',
      headers: { cookie: '[redacted]', authorization: '[redacted]', accept: 'text/html' },
      body: 'number=TEST123&postcode=1234&api_key=[redacted]', body_truncated: false, timeout_ms: 8000 });
  }
});

it('redacts the credentials of a JSON, cut JSON or XML request body and keeps the rest', async () => {
  const bodies: [string, string][] = [
    [JSON.stringify({ number: 'TEST123', auth: { apiKey: 'fixture' }, items: [{ token: 'fixture' }] }),
      '{"number":"TEST123","auth":"[redacted]","items":[{"token":"[redacted]"}]}'],
    ['{"number":"TEST123","accessToken":"fixture","postcode":"12', '[redacted]'],
    ['<req><number>TEST123</number><ns:ApiKey>fixture</ns:ApiKey></req>', '<req><number>TEST123</number><ns:ApiKey>[redacted]</ns:ApiKey></req>'],
  ];
  for (const [body, kept] of bodies) {
    const error = await fetchBounded('https://carrier.example/track', { method: 'POST', body }, {
      provider: 'Test carrier', timeoutMs: 8000, fetcher: async () => new Response('Refused', { status: 403 }),
    }).catch(error => error);
    expect(error.request.body).toBe(kept);
  }
});


it('redacts app guest auth and CAPTCHA headers without losing the actual HTTP refusal', async () => {
  const { fetchBounded } = await import('./boundedFetch.js');
  const error = await fetchBounded('https://carrier.example/tracking', { signal: AbortSignal.timeout(1000),
    headers: { auth: 'synthetic-guest-secret', 'x-recaptcha': 'synthetic-private-captcha', Accept: 'application/json' } },
  { provider: 'Synthetic', fetcher: async () => new Response('Upstream busy', { status: 503 }), timeoutMs: 1000 })
    .catch(error => error);
  expect(error).toMatchObject({ status: 503, request: { headers: { auth: '[redacted]', 'x-recaptcha': '[redacted]', accept: 'application/json' } } });
  expect(JSON.stringify(error)).not.toMatch(/synthetic-guest-secret|synthetic-private-captcha/);
});

it('removes proxy credentials from serialized nested and truncated requests', async () => {
  const proxy = 'socks5://fixture:sentinel-only@proxy.invalid';
  for (const body of [JSON.stringify({ proxy }), JSON.stringify({ routes: [proxy] }), '{"proxy":"' + proxy.split('@')[0]]) {
    const error = await fetchBounded('https://carrier.example', { method: 'POST', body }, {
      provider: 'Test', timeoutMs: 1000, fetcher: async () => new Response(null, { status: 503 }),
    }).catch(error => error);
    expect(error.status).toBe(503);
    expect(JSON.stringify(error)).not.toContain('sentinel-only');
  }
});
