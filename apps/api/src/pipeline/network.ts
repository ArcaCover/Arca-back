import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
async function publicAddresses(raw: string) {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
    (url.port && url.port !== '80' && url.port !== '443')) throw new Error('Unsafe URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')) {
    throw new Error('Non-public network target');
  }
  return addresses;
}
export async function assertPublicUrl(raw: string): Promise<void> { await publicAddresses(raw); }
/** The one identity this service uses on the wire. robots.txt rules are matched against the same token (see robots.ts). */
export const USER_AGENT = 'ArcaBot/1.0';
export type PublicResponse = { status: number; headers: Record<string, string>; body: Buffer };
export type BodyLimit = { maxBytes: number; truncate?: boolean };
type BodyStream = { on(event: string, listener: (...args: never[]) => void): unknown; destroy(error?: Error): unknown };
/** Reads a body up to the limit. Past it the read fails, or with `truncate` keeps what fits and stops downloading. */
export function collectBody(stream: BodyStream, limit: BodyLimit): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, done = false;
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      if (bytes + chunk.length > limit.maxBytes) {
        done = true;
        if (!limit.truncate) { stream.destroy(new Error('Response too large')); return; }
        chunks.push(chunk.subarray(0, limit.maxBytes - bytes));
        resolve(Buffer.concat(chunks));
        stream.destroy();
        return;
      }
      bytes += chunk.length; chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
  });
}
export async function fetchPublicResponse(raw: string, signal: AbortSignal, method = 'GET', body?: Buffer | null,
  limit: BodyLimit = { maxBytes: 5_000_000 }): Promise<PublicResponse> {
  const addresses = await publicAddresses(raw);
  signal.throwIfAborted();
  const url = new URL(raw);
  // Pin the validated lookup result to the socket; never resolve the hostname again after validation.
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, signal, headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family),
    }, response => {
      collectBody(response, limit).then(collected => resolve({ status: response.statusCode ?? 502,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value!])), body: collected }), reject);
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}
export type TextFetchOptions = { maxBytes?: number; truncate?: boolean; fetchResponse?: typeof fetchPublicResponse };
export async function fetchPublicText(url: string, signal: AbortSignal, options: TextFetchOptions = {}): Promise<{ status: number; text: string }> {
  const maxBytes = options.maxBytes ?? 1_000_000, fetchResponse = options.fetchResponse ?? fetchPublicResponse;
  let next = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const response = await fetchResponse(next, signal, 'GET', null, options.truncate ? { maxBytes, truncate: true } : undefined);
    if (response.status >= 300 && response.status < 400 && response.headers['location']) {
      next = new URL(response.headers['location'], next).href;
      continue;
    }
    if (response.body.byteLength > maxBytes) throw new Error('Response too large');
    return { status: response.status, text: response.body.toString('utf8') };
  }
  throw new Error('Too many redirects');
}
