import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';

// DN-13 §21: the catalog ids of a plan per Stripe mode (20261122000000_plan_catalog_modes.sql) on PGlite. One Supabase project serves
// local development (a test key) and production (a live key at launch), so a plan keeps its test ids where they are today
// (stripe_product_id, stripe_price_id) and gains a live pair beside them. Additive: nothing is dropped, renamed or rewritten.
const directory = new URL('../../../../supabase/migrations/', import.meta.url);
const migrations = async () => (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261122000000_plan_catalog_modes.sql';

async function roles(db: PGlite) {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
}

/** Every migration before this one, then the test ids `npm run stripe:catalog -- --apply` wrote with the rk_test_ key. */
async function earlierSchemaWithTestIds() {
  const db = new PGlite();
  await roles(db);
  const names = await migrations();
  const index = names.indexOf(MIGRATION);
  expect(index, 'the migration exists').toBeGreaterThan(0);
  for (const name of names.slice(0, index)) await db.exec(await readFile(new URL(name, directory), 'utf8'));
  await db.exec(`update public.plans set stripe_product_id='arca', stripe_price_id='price_1TestMonthly' where code='monthly';
    update public.plans set stripe_product_id='arca', stripe_price_id='price_1TestAnnual' where code='annual';`);
  return { db, rest: names.slice(index) };
}

const PLAN_IDS = 'select code, stripe_product_id, stripe_price_id, stripe_live_product_id, stripe_live_price_id from public.plans order by code';

describe('the plan catalog per Stripe mode (DN-13 §21)', () => {
  it('keeps the ids stored today as the test ones and adds an empty live pair', async () => {
    const { db, rest } = await earlierSchemaWithTestIds();
    try {
      for (const name of rest) await db.exec(await readFile(new URL(name, directory), 'utf8'));
      expect((await db.query(PLAN_IDS)).rows).toEqual([
        { code: 'annual', stripe_product_id: 'arca', stripe_price_id: 'price_1TestAnnual', stripe_live_product_id: null, stripe_live_price_id: null },
        { code: 'monthly', stripe_product_id: 'arca', stripe_price_id: 'price_1TestMonthly', stripe_live_product_id: null, stripe_live_price_id: null }]);
      // Nothing else of the plans moved.
      expect((await db.query('select code, amount_cents, currency, "interval", active from public.plans order by code')).rows).toEqual([
        { code: 'annual', amount_cents: 499000, currency: 'usd', interval: 'year', active: true },
        { code: 'monthly', amount_cents: 49900, currency: 'usd', interval: 'month', active: true }]);
    } finally {
      await db.close();
    }
  });

  it('lets the two modes coexist, one live price per plan, written by the service role only', async () => {
    const { db, rest } = await earlierSchemaWithTestIds();
    try {
      for (const name of rest) await db.exec(await readFile(new URL(name, directory), 'utf8'));
      await db.exec('set role service_role');
      await db.exec("update public.plans set stripe_live_product_id='arca', stripe_live_price_id='price_1LiveMonthly' where code='monthly'");
      expect((await db.query(`${PLAN_IDS.replace(' order by code', '')} where code='monthly'`)).rows).toEqual([{ code: 'monthly',
        stripe_product_id: 'arca', stripe_price_id: 'price_1TestMonthly', stripe_live_product_id: 'arca', stripe_live_price_id: 'price_1LiveMonthly' }]);
      // A catalog price belongs to one plan, in each mode.
      await expect(db.query("update public.plans set stripe_live_price_id='price_1LiveMonthly' where code='annual'"))
        .rejects.toThrow('plans_stripe_live_price_id_key');
      await expect(db.query("update public.plans set stripe_price_id='price_1TestMonthly' where code='annual'")).rejects.toThrow('plans_stripe_price_id_key');
      // Cleared with null, like the test pair.
      await db.query("update public.plans set stripe_live_price_id=null where code='monthly'");
      await db.exec('reset role');
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        try {
          await expect(db.query('select stripe_live_price_id from public.plans'), role).rejects.toThrow('permission denied');
        } finally {
          await db.exec('reset role');
        }
      }
    } finally {
      await db.close();
    }
  });

  it('touches the plans table alone: no scan, assessment or other webapp table', async () => {
    const sql = (await readFile(new URL(MIGRATION, directory), 'utf8')).replace(/--.*$/gm, '');
    const tables = new Set([...sql.matchAll(/public\.(\w+)/g)].map((match) => match[1]));
    expect([...tables]).toEqual(['plans']);
    expect(sql).not.toMatch(/\b(drop|rename|delete|truncate)\b/i);
    expect(sql).toMatch(/^\s*begin;/);
    expect(sql.trim()).toMatch(/commit;$/);
  });
});
