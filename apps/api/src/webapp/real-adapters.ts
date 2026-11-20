import type { createStorageClient } from '../repositories/supabase.js';
import type { JwksFetcher } from './auth.js';
import { SupabaseAuthAdmin, type AuthAdmin } from './auth-admin.js';
import type { BillingProvider } from './billing.js';
import type { SesSendEmail } from './mailer.js';
import type { WebappRepository } from './types.js';
import { StripeBillingProvider } from './stripe.js';
import { SupabaseWebappRepository } from './supabase.js';

export type StorageClient = ReturnType<typeof createStorageClient>;

/**
 * The real adapters of the webapp (DN-13 §7.1), handed to `compose` as factories. Each one lands with its own task, and until
 * then `compose` refuses to start the real webapp rather than fall back to a simulated piece. Production with WEBAPP_ENABLED=false
 * and every debug mode on the simulated providers build none of them.
 */
export type RealWebappAdapters = {
  /** T4: `client => new SupabaseWebappRepository(client)`, on the same service-role client as the scans. */
  repository?: (client: StorageClient) => WebappRepository;
  /** T7: `client => new SupabaseAuthAdmin(client)`, the Auth admin API on the same service-role client (enroll, DELETE /me). */
  authAdmin?: (client: StorageClient) => AuthAdmin;
  /** T14: the Stripe provider. `mode` is what the key's prefix says; loadEnv already refused a key that does not fit the mode. */
  billing?: (config: { secretKey: string; webhookSecret: string; mode: 'live' | 'test'; appBaseUrl: string }) => BillingProvider;
  /** SES v2 SendEmail, needed only with EMAIL_PROVIDER=ses. See `SesMailer` for the wiring with `@aws-sdk/client-sesv2`. */
  sesSendEmail?: SesSendEmail;
  /** Where SupabaseJwtAuth reads the project's JWKS; the default reads it over HTTP. The tests inject one. */
  fetchJwks?: JwksFetcher;
};

/**
 * What ships today: the Supabase repository (T4), the Auth admin (T7) and the Stripe provider (T14). The SES sender is still
 * missing, so production with WEBAPP_ENABLED=true and EMAIL_PROVIDER=ses refuses to start; live-debug with WEBAPP_PROVIDERS=real
 * (memory email by default) starts.
 */
export const REAL_WEBAPP_ADAPTERS: Readonly<RealWebappAdapters> = Object.freeze({
  repository: client => new SupabaseWebappRepository(client),
  authAdmin: client => new SupabaseAuthAdmin(client),
  billing: config => new StripeBillingProvider(config),
});
