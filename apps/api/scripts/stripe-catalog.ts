import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { stripeKeyMode } from '../src/config/env.js';
import { createStorageClient } from '../src/repositories/supabase.js';
import { DEFAULT_PLANS } from '../src/webapp/plans.js';
import { CatalogError, parseCatalogArgs, syncStripeCatalog } from '../src/webapp/stripe-catalog.js';
import { stripeClient } from '../src/webapp/stripe.js';
import { SupabaseWebappRepository } from '../src/webapp/supabase.js';

// npm run stripe:catalog [-- --apply] [--allow-live]   (DN-13 §6.1, T13)
//
// Makes sure the Stripe catalog has the Product `arca` and one monthly and one annual Price with the amounts of the plans table
// (lookup keys arca_monthly and arca_annual), and writes their ids into that table. A dry run unless --apply. Reads STRIPE_SECRET_KEY,
// SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) from the environment or from .env.local, like admin:grant. A
// live key is refused unless --allow-live (the live catalog is T23, the founder's). Prints the Stripe mode, the Supabase host and
// the ids; never a key. Run it against Arca-dev with a test key (the restricted key needs write on Products and Prices).
const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

async function main() {
  const args = parseCatalogArgs(process.argv.slice(2));
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new CatalogError('Set STRIPE_SECRET_KEY (a test key, sk_test_ or rk_test_)');
  let mode: 'live' | 'test';
  try { mode = stripeKeyMode(key); } catch (error) { throw new CatalogError((error as Error).message); }
  const url = process.env.SUPABASE_URL?.trim();
  const secret = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const repository = url && secret ? new SupabaseWebappRepository(createStorageClient(url, secret)) : null;
  console.log(repository ? `Supabase: ${new URL(url!).host}` : 'Supabase: not configured, so the amounts are those of plans.ts and nothing is written');
  await syncStripeCatalog({ stripe: stripeClient(key), mode, plans: DEFAULT_PLANS, repository, apply: args.apply, allowLive: args.allowLive,
    log: line => console.log(line) });
}

// Stripe's own messages may quote a masked key ("Invalid API Key provided: rk_test_****1234"): not even that is printed.
const redacted = (message: string) => message.replace(/\b(?:sk|rk|pk)_(?:live|test)_\S*/g, '[key]').replace(/\bwhsec_\S*/g, '[secret]');

main().catch(error => {
  console.error(error instanceof CatalogError ? error.message
    : `stripe:catalog failed: ${redacted(error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error')}`);
  process.exitCode = 1;
});
