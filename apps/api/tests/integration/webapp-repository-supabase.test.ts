import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { SupabaseWebappRepository } from '../../src/webapp/supabase.js';
import { describeWebappRepository } from '../conformance/webapp-repository.js';

/**
 * The repository conformance suite against a real Supabase (DN-13 §11, end of phase 1). Skipped unless both variables are set, so
 * `npm test` never touches the network.
 *
 * Run it against Supabase local (needs Docker and the Supabase CLI), from the repository root, in PowerShell:
 *
 *   supabase start                     # once; or reuse a running stack
 *   supabase db reset                  # local only: wipes the local database and applies every migration in supabase/migrations
 *   $status = supabase status -o env | ConvertFrom-StringData
 *   $env:ARCA_CONFORMANCE_SUPABASE_URL = $status.API_URL.Trim('"')
 *   $env:ARCA_CONFORMANCE_SUPABASE_KEY = $status.SERVICE_ROLE_KEY.Trim('"')
 *   npx vitest run apps/api/tests/integration/webapp-repository-supabase.test.ts
 *   Remove-Item Env:ARCA_CONFORMANCE_SUPABASE_URL, Env:ARCA_CONFORMANCE_SUPABASE_KEY
 *
 * The key is the local service role key (`SERVICE_ROLE_KEY`, or `SECRET_KEY` on newer CLIs); never print it. The suite leaves its
 * rows behind (the audit log is append-only): `supabase db reset` clears them. It refuses any host but the local one unless
 * ARCA_CONFORMANCE_SUPABASE_ALLOW_REMOTE=1, which is only for Arca-dev after its migrations were applied, and never for production.
 */
const url = process.env.ARCA_CONFORMANCE_SUPABASE_URL;
const key = process.env.ARCA_CONFORMANCE_SUPABASE_KEY;
const configured = Boolean(url && key);

describeWebappRepository('Supabase', async () => {
  const host = new URL(url!).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.ARCA_CONFORMANCE_SUPABASE_ALLOW_REMOTE !== '1') {
    throw new Error(`Refusing to run the conformance suite against ${host}: only Supabase local, or Arca-dev with ARCA_CONFORMANCE_SUPABASE_ALLOW_REMOTE=1`);
  }
  const client = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    repository: new SupabaseWebappRepository(client),
    async scan() {
      const scanId = `sc_conformance${randomBytes(8).toString('hex')}`;
      const { error } = await client.from('scans').insert({ scan_id: scanId, email: 'conformance@firm.example', canonical_domain: 'firm.example',
        domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.example' }, status: 'COMPLETED', result: {} });
      if (error) throw new Error('Unable to create a conformance scan', { cause: error });
      return scanId;
    },
  };
}, { skip: !configured });
