import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const image = `arca-api-smoke:${randomUUID()}`;
const container = `arca-api-smoke-${randomUUID()}`;
const docker = (args, options = {}) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout?.trim() ?? '';
};

const waitForHealth = async port => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Container did not become healthy within 60 seconds');
};

try {
  docker(['build', '--build-arg', 'VCS_REF=smoke', '--build-arg', `BUILD_DATE=${new Date().toISOString()}`, '-t', image, '.']);
  docker(['run', '--detach', '--name', container, '--publish', '127.0.0.1::8080', '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--shm-size', '512m', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--env', 'NODE_ENV=production', '--env', 'PORT=8080', '--env', 'SOURCE_MODE=mock',
    '--env', 'STORAGE_BACKEND=memory', '--env', 'WEBSITE_EVIDENCE_PROVIDER=rules',
    '--env', 'SESSION_TOKEN_SECRET=container-smoke-secret-at-least-32-characters',
    '--env', 'CORS_ALLOWED_ORIGINS=http://localhost:3000', image]);
  const mapping = docker(['port', container, '8080/tcp'], { capture: true });
  const port = Number(mapping.match(/:(\d+)$/)?.[1]);
  if (!Number.isInteger(port)) throw new Error(`Could not determine published port from ${mapping}`);
  await waitForHealth(port);
  const openapi = await fetch(`http://127.0.0.1:${port}/openapi.json`);
  if (!openapi.ok || (await openapi.json()).openapi !== '3.1.0') throw new Error('OpenAPI smoke check failed');
  const invalid = await fetch(`http://127.0.0.1:${port}/scan`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (invalid.status !== 400) throw new Error(`Expected invalid scan to return 400, got ${invalid.status}`);
  docker(['exec', container, 'node', '--input-type=module', '--eval',
    "import { chromium } from 'playwright'; const browser = await chromium.launch({headless:true}); const page = await browser.newPage(); await page.setContent('<p>ok</p>'); if (await page.textContent('p') !== 'ok') process.exit(1); await browser.close();"]);
  console.log('Container smoke test passed: health, OpenAPI, request validation and Chromium.');
} finally {
  spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
  spawnSync('docker', ['image', 'rm', '--force', image], { stdio: 'ignore' });
}
