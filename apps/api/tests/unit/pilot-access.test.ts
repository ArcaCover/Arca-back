import { describe, expect, it } from 'vitest';
import { PILOT_TOKEN_HEADER, createApp } from '../../src/http/app.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { mockSources } from '../../src/pipeline/mock-sources.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';

const TOKEN = 'p'.repeat(40);
function app(pilotAccessToken?: string) {
  const repository = new InMemoryRepository();
  return createApp({ repository, pipeline: new InProcessPipeline({ ...mockSources(), repository }),
    domainResolver: new PublicDomainResolver(async () => {}), sessionSecret: 's'.repeat(40),
    corsOrigins: ['https://pilot.arcacover.com'], clientIp: () => 'local', pilotAccessToken }).app;
}
const scan = (headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ email: 'owner@robust.arca.example', domain: 'robust.arca.example' }) });

describe('the pilot access token (DN-14 §5)', () => {
  it('refuses every request without the token, and lets one with it through', async () => {
    const pilot = app(TOKEN);
    expect((await pilot.request('/scan', scan())).status).toBe(401);
    expect((await pilot.request('/scan', scan({ [PILOT_TOKEN_HEADER]: 'wrong' }))).status).toBe(401);
    expect((await pilot.request('/scan', scan({ [PILOT_TOKEN_HEADER]: TOKEN }))).status).not.toBe(401);
  });
  it('keeps /health open for the container checks and lets the browser ask for the header', async () => {
    const pilot = app(TOKEN);
    expect((await pilot.request('/health')).status).toBe(200);
    const preflight = await pilot.request('/scan', { method: 'OPTIONS', headers: { Origin: 'https://pilot.arcacover.com',
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': PILOT_TOKEN_HEADER } });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain(PILOT_TOKEN_HEADER);
  });
  it('changes nothing where there is no token, as in production', async () => {
    expect((await app().request('/scan', scan())).status).not.toBe(401);
  });
});
