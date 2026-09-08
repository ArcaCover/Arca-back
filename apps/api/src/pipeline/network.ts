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
export type PublicResponse = { status: number; headers: Record<string, string>; body: Buffer };
export async function fetchPublicResponse(raw: string, signal: AbortSignal, method = 'GET', body?: Buffer | null): Promise<PublicResponse> {
  const addresses = await publicAddresses(raw);
  signal.throwIfAborted();
  const url = new URL(raw);
  // Pin the validated lookup result to the socket; never resolve the hostname again after validation.
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, signal, headers: { 'User-Agent': 'ArcaBot/1.0', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family),
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 5_000_000) { response.destroy(new Error('Response too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 502,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value!])), body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}
export async function fetchPublicText(url: string, signal: AbortSignal): Promise<{ status: number; text: string }> {
  let next = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const response = await fetchPublicResponse(next, signal);
    if (response.status >= 300 && response.status < 400 && response.headers['location']) {
      next = new URL(response.headers['location'], next).href;
      continue;
    }
    if (response.body.byteLength > 1_000_000) throw new Error('Response too large');
    return { status: response.status, text: response.body.toString('utf8') };
  }
  throw new Error('Too many redirects');
}
