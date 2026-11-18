/**
 * What transport errors keep of a request and of the reply that refused it. Errors
 * reach step recorders and whatever serializes them, such as a host's logs and error
 * reports, so they keep what explains a failure, the tracking number and postcode in a
 * query or body included, and no credential: credential header values, an address's user
 * info and fragment, and query parameters and body fields named after a key, token, secret,
 * session or signature read `[redacted]`. A reply's body is kept for adapters to read by
 * name, but is not enumerable.
 */
import type { UpstreamHttpDiagnostics } from '../transport/upstreamHttpDiagnostics.js';
import type { UpstreamRequestDiagnostics } from './index.js';

const REDACTED = '[redacted]';

/** Authorization, cookies, and headers named after a key, token, secret, session or signature. */
const CREDENTIAL_HEADER = /^(?:proxy-)?authorization$|^(?:set-)?cookie2?$|^x-auth|token|captcha|secret|passw|key$|session|signature|csrf|xsrf|^auth$/i;

// A caller's malformed details must not make the error itself throw.
function redactedHeaders(headers: Record<string, string>): Record<string, string> {
  return headers && typeof headers === 'object'
    ? Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, CREDENTIAL_HEADER.test(name) ? REDACTED : value]))
    : headers;
}

/** Query parameters and body fields named after a key, token, secret, password, session, signature or authorization. */
const CREDENTIAL_NAME = /captcha|turnstile|token|secret|passw|key$|^key|api[-_]?key|session|sig(?:nature)?$|^sig|auth|credential|csrf|xsrf|^x-amz-|^code_verifier$/i;

/** `name=value` pairs, as a query or a form body writes them, with the credentials' values redacted. */
function redactedPairs(pairs: string): string {
  return pairs.split('&').map((part) => {
    const equals = part.indexOf('=');
    if (equals < 0) return part;
    let name = part.slice(0, equals);
    try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* A malformed escape keeps its raw name. */ }
    return CREDENTIAL_NAME.test(name) ? `${part.slice(0, equals)}=${REDACTED}` : part;
  }).join('&');
}

/** The address with its user info, fragment and credential parameters' values redacted. */
function redactedAddress(address: string): string {
  if (typeof address !== 'string') return address;
  const hash = address.indexOf('#');
  const beforeHash = hash < 0 ? address : address.slice(0, hash);
  const question = beforeHash.indexOf('?');
  const base = (question < 0 ? beforeHash : beforeHash.slice(0, question)).replace(/^([a-z][a-z\d+.-]*:\/\/)[^/]*@/i, `$1${REDACTED}@`);
  const query = question < 0 ? '' : `?${redactedPairs(beforeHash.slice(question + 1))}`;
  return base + query + (hash < 0 ? '' : `#${REDACTED}`);
}

/** A JSON value with the credential fields' values redacted, at any depth. */
function redactedJson(value: unknown): unknown {
  if (typeof value === 'string' && /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return redactedAddress(value);
  if (Array.isArray(value)) return value.map(redactedJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, name.toLowerCase() === 'proxy' || CREDENTIAL_NAME.test(name) ? REDACTED : redactedJson(item)]));
}

/** A request body as sent, with the credential fields of a JSON or form body redacted. */
function redactedBody(body: unknown): unknown {
  if (typeof body !== 'string') return body === undefined ? body : REDACTED;
  const trimmed = body.trim();
  if (/^[[{]/.test(trimmed)) {
    try { return JSON.stringify(redactedJson(JSON.parse(trimmed))); } catch {
      // Truncation can remove the delimiter that identifies a URL's user info.
      return REDACTED;
    }
  }
  if (/^[^\s=&]+=[^\s]*$/.test(trimmed)) return redactedPairs(trimmed);
  // Text or XML: a credential's quoted JSON value or element text.
  return body
    .replace(/("([^"\\]{1,80})"\s*:\s*)"(?:[^"\\]|\\.)*"?/g, (whole, before: string, name: string) => CREDENTIAL_NAME.test(name) ? `${before}"${REDACTED}"` : whole)
    .replace(/<([\w:.-]{1,80})>[^<]*<\/\1>/g, (whole, name: string) => CREDENTIAL_NAME.test(name.replace(/^.*:/, '')) ? `<${name}>${REDACTED}</${name}>` : whole);
}

export function redactedRequest(request: UpstreamRequestDiagnostics): UpstreamRequestDiagnostics {
  return {
    ...request, url: redactedAddress(request.url), headers: redactedHeaders(request.headers),
    ...(request.body === undefined ? {} : { body: redactedBody(request.body) as string }),
  };
}

/** Defines `value` as a property that serializers skip and adapters still read by name. */
export function defineHidden(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
}

export function redactedReply(diagnostics: UpstreamHttpDiagnostics): UpstreamHttpDiagnostics {
  const { body_excerpt: excerpt, ...rest } = diagnostics;
  const copy: UpstreamHttpDiagnostics = {
    ...rest, headers: redactedHeaders(rest.headers), response_url: redactedAddress(rest.response_url),
  };
  if ('body_excerpt' in diagnostics) defineHidden(copy, 'body_excerpt', excerpt);
  return copy;
}
