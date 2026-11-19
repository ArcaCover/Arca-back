import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createStorageClient } from '../src/repositories/supabase.js';
import { AdminGrantError, adminGrant, parseAdminGrantArgs } from '../src/webapp/admin-grant.js';
import { SupabaseWebappRepository } from '../src/webapp/supabase.js';

// npm run admin:grant -- <email> [--revoke] [--dry-run]   (DN-10 §4.6, DN-13 §4.5)
//
// Grants or revokes the ARCA platform role over the Supabase repository named by SUPABASE_URL and SUPABASE_SECRET_KEY (or the legacy
// SUPABASE_SERVICE_ROLE_KEY), read from the environment or from .env.local, as `npm run db:verify` does. The person must have signed
// in once. Run it locally against Arca-dev; against production only with the founder's approval and from the host (SSM), never by
// copying the production key to a laptop. Try it first with --dry-run: the target host is printed, never the key.
const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

async function main() {
  const args = parseAdminGrantArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new AdminGrantError('Set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)');
  console.log(`Supabase: ${new URL(url).host}${args.dryRun ? ' (dry run: nothing is written)' : ''}`);
  const outcome = await adminGrant(new SupabaseWebappRepository(createStorageClient(url, key)), args);
  const said = { granted: 'is now an ARCA platform admin', revoked: 'is no longer an ARCA platform admin',
    unchanged: outcome.action === 'grant' ? 'was already an ARCA platform admin' : 'was not an ARCA platform admin',
    would_grant: 'would become an ARCA platform admin', would_revoke: 'would stop being an ARCA platform admin' }[outcome.result];
  console.log(`${outcome.email} (${outcome.userId}) ${said}.`);
}

main().catch(error => {
  console.error(error instanceof AdminGrantError ? error.message : `admin:grant failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
