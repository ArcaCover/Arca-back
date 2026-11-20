import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// deploy/Caddyfile (DN-13 §9.2, T17). Stripe's webhook gets its own body limit of 1 MB, so a large event is never a 413 that Stripe
// retries for days; every other request keeps 32 KB. No Caddy binary runs here (`caddy validate` needs the image), so the test
// reads the structure: which block holds which directive.
const CADDYFILE = readFileSync(new URL('../../../../deploy/Caddyfile', import.meta.url), 'utf8');

type Block = { head: string; lines: string[]; children: Block[] };

/** The Caddyfile as nested blocks, comments dropped. */
function parse(text: string): Block {
  const root: Block = { head: '', lines: [], children: [] };
  const stack = [root];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    if (line === '}') { stack.pop(); continue; }
    if (line.endsWith('{')) {
      const block: Block = { head: line.slice(0, -1).trim(), lines: [], children: [] };
      stack.at(-1)!.children.push(block);
      stack.push(block);
      continue;
    }
    stack.at(-1)!.lines.push(line);
  }
  expect(stack, 'every block is closed').toHaveLength(1);
  return root;
}
const child = (block: Block, head: string) => block.children.find(candidate => candidate.head === head);
const maxSize = (block: Block | undefined) => block && child(block, 'request_body')?.lines.find(line => line.startsWith('max_size'));
/** Every line of a block and of its children, with the snippets it imports expanded. */
function flat(block: Block, snippets: Map<string, Block>): string[] {
  return block.lines.flatMap(line => {
    const snippet = /^import\s+(\S+)$/.exec(line)?.[1];
    return snippet && snippets.has(snippet) ? flat(snippets.get(snippet)!, snippets) : [line];
  }).concat(block.children.flatMap(nested => [nested.head, ...flat(nested, snippets)]));
}

describe('deploy/Caddyfile', () => {
  const root = parse(CADDYFILE);
  const snippets = new Map(root.children.filter(block => /^\(\w+\)$/.test(block.head)).map(block => [block.head.slice(1, -1), block]));
  const site = child(root, '{$DEMO_HOSTNAME}')!;

  it('serves the API host', () => {
    expect(site).toBeDefined();
  });

  it('gives /billing/webhook its own 1 MB body limit, proxied to the API', () => {
    const webhook = child(site, 'handle /billing/webhook');
    expect(webhook).toBeDefined();
    expect(maxSize(webhook)).toBe('max_size 1MB');
    expect(flat(webhook!, snippets).some(line => line.startsWith('reverse_proxy api:8080'))).toBe(true);
  });

  it('keeps 32 KB for every other request, and no limit outside the two handles that would cap the webhook first', () => {
    const rest = child(site, 'handle');
    expect(maxSize(rest)).toBe('max_size 32KB');
    expect(flat(rest!, snippets).some(line => line.startsWith('reverse_proxy api:8080'))).toBe(true);
    expect(child(site, 'request_body')).toBeUndefined();
    expect(site.children.filter(block => block.head.startsWith('handle')).map(block => block.head)).toEqual(['handle /billing/webhook', 'handle']);
  });

  it('keeps the health checks of the proxy, the security headers and the password on the documentation', () => {
    for (const handle of ['handle /billing/webhook', 'handle']) {
      const lines = flat(child(site, handle)!, snippets);
      expect(lines, handle).toEqual(expect.arrayContaining(['health_uri /health', 'health_interval 15s', 'health_timeout 3s']));
    }
    expect(child(site, 'header')?.lines).toEqual(expect.arrayContaining(['Strict-Transport-Security "max-age=31536000; includeSubDomains"',
      'X-Content-Type-Options "nosniff"', 'Referrer-Policy "no-referrer"', '-Server']));
    expect(site.lines).toContain('@documentation path /docs /docs/* /openapi.json');
    expect(child(site, 'basic_auth @documentation')?.lines).toEqual(['{$DOCS_AUTH_USER} {$DOCS_AUTH_HASH}']);
    expect(site.lines).toContain('encode zstd gzip');
  });
});
