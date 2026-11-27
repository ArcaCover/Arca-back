import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// deploy/render-env.py (DN-13 §9.1): with the webapp switched on, a deploy without the Stripe secrets in /arca/prod is refused on
// the host, naming them, instead of leaving an API that will not start. Runs the script itself, with the host's Python 3.
const SCRIPT = fileURLToPath(new URL('../../../../deploy/render-env.py', import.meta.url));
const python = ['python3', 'python'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
const directory = mkdtempSync(join(tmpdir(), 'arca-render-env-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const HASH = `$2a$14$${'a'.repeat(53)}`;
const BASE = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x', SESSION_TOKEN_SECRET: 's'.repeat(40),
  APIFY_API_TOKEN: 'apify_x', DOCS_AUTH_HASH: HASH, OPENAI_API_KEY: 'sk-proj-x' };
const STRIPE = { STRIPE_SECRET_KEY: 'rk_live_x$y', STRIPE_WEBHOOK_SECRET: 'whsec_x' };

function render(productionEnv: string, secrets: Record<string, string>) {
  const file = join(directory, `production-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(file, productionEnv);
  const parameters = { Parameters: Object.entries(secrets).map(([key, value]) => ({ Name: `/arca/prod/${key}`, Value: value })) };
  return spawnSync(python!, ['-I', SCRIPT, file, 'image:tag'], { input: JSON.stringify(parameters), encoding: 'utf8' });
}

describe.skipIf(!python)('deploy/render-env.py', () => {
  it('renders pilot from /arca/pilot with its own secrets, and refuses a short access token (DN-14 §5)', () => {
    const pilot = { SUPABASE_SECRET_KEY: 'jwt', SESSION_TOKEN_SECRET: 's'.repeat(40), APIFY_API_TOKEN: 'apify_x', OPENAI_API_KEY: 'sk-x',
      PILOT_ACCESS_TOKEN: 't'.repeat(36), POSTGRES_PASSWORD: 'p', AUTHENTICATOR_PASSWORD: 'a', PGRST_JWT_SECRET: 'j'.repeat(64) };
    const env = ['ARCA_DEPLOYMENT=aws-pilot', 'ARCA_MODE=live-debug', ''].join('\n');
    const ok = render(env, pilot);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('PILOT_ACCESS_TOKEN=');
    const missing = render(env, { ...pilot, PGRST_JWT_SECRET: '' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('/arca/pilot');
    expect(render(env, { ...pilot, PILOT_ACCESS_TOKEN: 'short' }).stderr).toContain('at least 32');
  });
  it('needs no Stripe secret while the webapp is off', () => {
    for (const env of ['ARCA_DEPLOYMENT=aws\n', 'ARCA_DEPLOYMENT=aws\nWEBAPP_ENABLED=false\n']) {
      const result = render(env, BASE);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('STRIPE_');
    }
  });

  it('refuses a deploy with the webapp on and a Stripe secret missing, naming each one', () => {
    const env = 'ARCA_DEPLOYMENT=aws\nWEBAPP_ENABLED=true\n';
    const none = render(env, BASE);
    expect(none.status).toBe(4);
    expect(none.stderr).toContain('Missing parameters under /arca/prod: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET');
    const half = render(env, { ...BASE, STRIPE_SECRET_KEY: STRIPE.STRIPE_SECRET_KEY });
    expect(half.status).toBe(4);
    expect(half.stderr).toContain('STRIPE_WEBHOOK_SECRET');
    expect(half.stderr).not.toContain('rk_live');
  });

  it('renders them, escaped for Compose, once both are there', () => {
    const result = render('ARCA_DEPLOYMENT=aws\nWEBAPP_ENABLED=true\n', { ...BASE, ...STRIPE });
    expect(result.status, result.stderr).toBe(0);
    // Python on Windows writes CRLF; the host writes LF.
    const lines = result.stdout.split(/\r?\n/);
    expect(lines).toContain('STRIPE_SECRET_KEY=rk_live_x$$y');
    expect(lines).toContain('STRIPE_WEBHOOK_SECRET=whsec_x');
    expect(lines).toContain('WEBAPP_ENABLED=true');
  });

  it('needs the Resend key only when the webapp is on and sends through Resend', () => {
    // Off, Resend's key is not asked for, whatever the provider.
    expect(render('ARCA_DEPLOYMENT=aws\nWEBAPP_ENABLED=false\nEMAIL_PROVIDER=resend\n', BASE).status).toBe(0);
    // On with SES (or no provider: SES is the default), there is no key to ask for.
    for (const provider of ['', 'EMAIL_PROVIDER=ses\n']) {
      const result = render(`ARCA_DEPLOYMENT=aws\nWEBAPP_ENABLED=true\n${provider}`, { ...BASE, ...STRIPE });
      expect(result.status, result.stderr).toBe(0);
    }
    const resend = 'ARCA_DEPLOYMENT=aws\nWEBAPP_ENABLED=true\nEMAIL_PROVIDER=resend\nEMAIL_FROM=ARCA <no-reply@arcacover.com>\n';
    const missing = render(resend, { ...BASE, ...STRIPE });
    expect(missing.status).toBe(4);
    expect(missing.stderr).toContain('Missing parameters under /arca/prod: RESEND_API_KEY');
    const none = render(resend, BASE);
    expect(none.stderr).toContain('STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY');
    const result = render(resend, { ...BASE, ...STRIPE, RESEND_API_KEY: 're_x_y' });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split(/\r?\n/);
    expect(lines).toContain('RESEND_API_KEY=re_x_y');
    expect(lines).toContain('EMAIL_FROM=ARCA <no-reply@arcacover.com>');
  });
});
