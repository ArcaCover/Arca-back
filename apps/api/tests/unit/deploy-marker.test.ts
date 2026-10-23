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

  it('is read as an env file, not as an empty one', () => {
    // A parser that found nothing would pass the ARCA_MODE check vacuously.
    expect(env.size).toBeGreaterThan(5);
    expect(env.get('STORAGE_BACKEND')).toBe('supabase');
  });
});
