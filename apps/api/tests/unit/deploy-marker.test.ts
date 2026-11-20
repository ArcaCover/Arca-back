import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// deploy/production.env ships inside the image and is the only place the production API gets ARCA_DEPLOYMENT from.
// Without it, a debug .env copied to the server would open the debug modes instead of stopping the start (DN-09 4, 7).
const PRODUCTION_ENV = new URL('../../../../deploy/production.env', import.meta.url);

function keys(text: string): Map<string, string> {
  const entries = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line))
    .filter(match => match !== null).map(match => [match[1]!, match[2]!.trim()] as const);
  return new Map(entries);
}

describe('deploy/production.env', () => {
  const env = keys(readFileSync(PRODUCTION_ENV, 'utf8'));

  it('marks the image as deployed', () => {
    expect(env.get('ARCA_DEPLOYMENT')).toBe('aws');
  });

  it('leaves ARCA_MODE unset, so the deployment runs production', () => {
    expect(env.has('ARCA_MODE')).toBe(false);
  });

  it('runs the real webapp with Stripe in test mode, never on the simulated providers (DN-13 §7.6, founder decision 2026-11-20)', () => {
    expect(env.get('WEBAPP_ENABLED')).toBe('true');
    expect(env.get('STRIPE_ALLOW_TEST_MODE')).toBe('true');
    expect(env.get('APP_BASE_URL')).toBe('https://arcacover.com');
    expect(env.has('WEBAPP_PROVIDERS')).toBe(false);
    expect(env.has('STRIPE_SECRET_KEY') || env.has('STRIPE_WEBHOOK_SECRET')).toBe(false);
  });

  it('sends the webapp\'s invitations through Resend from the verified domain, with the key kept in SSM (DN-13 §9.1)', () => {
    expect(env.get('EMAIL_PROVIDER')).toBe('resend');
    expect(env.get('EMAIL_FROM')).toBe('ARCA <no-reply@arcacover.com>');
    expect(env.has('RESEND_API_KEY')).toBe(false);
  });

  it('is read as an env file, not as an empty one', () => {
    // A parser that found nothing would pass the ARCA_MODE check vacuously.
    expect(env.size).toBeGreaterThan(5);
    expect(env.get('STORAGE_BACKEND')).toBe('supabase');
  });
});
