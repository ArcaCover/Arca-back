import type { PGlite, Transaction } from '@electric-sql/pglite';

/**
 * A stand-in for Supabase's Data API (PostgREST) over PGlite, as a `fetch` for supabase-js, so SupabaseWebappRepository runs its
 * real requests against the real migrations in `npm test`, with no network (DN-13 §11). It covers only what the repository sends:
 * table reads with eq/neq/is/in/lt/lte/gt/gte filters, order and limit; inserts, upserts (on_conflict, merge or ignore duplicates),
 * updates and deletes with `Prefer: return=representation`; and RPC calls with named arguments. Each request is one transaction
 * under `service_role`, the back's role, so the grants of the migrations apply as they do on Supabase. Errors come back in
 * PostgREST's shape ({ code, message, details, hint }) with its status codes. It is not PostgREST: the conformance suite also runs
 * against a real Supabase (webapp-repository-supabase.test.ts).
 */
export function pglitePostgrest(db: PGlite): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' && init.body !== '' ? JSON.parse(init.body) as unknown : undefined;
    const path = url.pathname.replace(/^\/rest\/v1\//, '');
    try {
      return await db.transaction(async (tx) => {
        await tx.exec('set local role service_role');
        if (path.startsWith('rpc/')) return await rpc(tx, path.slice('rpc/'.length), (body ?? {}) as Record<string, unknown>);
        return await table(tx, method, path, url.searchParams, headers, body);
      });
    } catch (error) {
      return failure(error);
    }
  };
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string) => {
  if (!IDENTIFIER.test(name)) throw Object.assign(new Error(`Unsupported identifier: ${name}`), { code: 'PGRST100' });
  return `"${name}"`;
};
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
const OPERATORS: Readonly<Record<string, string>> = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };

function where(params: URLSearchParams, values: unknown[]): string {
  const clauses: string[] = [];
  for (const [column, filter] of params) {
    if (RESERVED.has(column)) continue;
    const dot = filter.indexOf('.');
    const [operator, value] = [filter.slice(0, dot), filter.slice(dot + 1)];
    if (operator === 'is') {
      if (!['null', 'true', 'false'].includes(value)) throw Object.assign(new Error(`Unsupported is.${value}`), { code: 'PGRST100' });
      clauses.push(`_t.${quote(column)} is ${value}`);
    } else if (operator === 'in') {
      const items = value.replace(/^\(|\)$/g, '').split(',').map((item) => item.replace(/^"|"$/g, ''));
      clauses.push(`_t.${quote(column)} in (${items.map((item) => { values.push(item); return `$${values.length}`; }).join(',')})`);
    } else if (OPERATORS[operator]) {
      values.push(value);
      clauses.push(`_t.${quote(column)} ${OPERATORS[operator]} $${values.length}`);
    } else {
      throw Object.assign(new Error(`Unsupported operator: ${operator}`), { code: 'PGRST100' });
    }
  }
  return clauses.length ? `where ${clauses.join(' and ')}` : '';
}

function orderBy(params: URLSearchParams): string {
  const order = params.get('order');
  if (!order) return '';
  return `order by ${order.split(',').map((term) => {
    const [column, ...modifiers] = term.split('.');
    const direction = modifiers.includes('desc') ? 'desc' : 'asc';
    const nulls = modifiers.includes('nullsfirst') ? ' nulls first' : modifiers.includes('nullslast') ? ' nulls last' : '';
    return `_t.${quote(column!)} ${direction}${nulls}`;
  }).join(', ')}`;
}

/** The selected columns of each row as JSON, as PostgREST prints them. */
function projection(params: URLSearchParams, alias: string): string {
  const select = (params.get('select') ?? '*').replaceAll(' ', '');
  if (select === '*') return `row_to_json(${alias})`;
  return `json_build_object(${select.split(',').map((column) => `'${column}', ${alias}.${quote(column)}`).join(', ')})`;
}

function preferences(headers: Headers): Set<string> {
  return new Set((headers.get('Prefer') ?? '').split(',').map((token) => token.trim()).filter(Boolean));
}

async function table(tx: Transaction, method: string, name: string, params: URLSearchParams, headers: Headers, body: unknown) {
  const relation = `public.${quote(name)}`;
  const values: unknown[] = [];
  const prefer = preferences(headers);
  const representation = prefer.has('return=representation');
  const agg = (statement: string) => `with _r as (${statement}) select coalesce(json_agg(${projection(params, '_r')}), '[]'::json) as body from _r`;

  if (method === 'GET') {
    const filter = where(params, values);
    const limit = params.get('limit') ? `limit ${Number.parseInt(params.get('limit')!, 10)}` : '';
    const rows = await tx.query<{ body: unknown[] }>(agg(`select _t.* from ${relation} _t ${filter} ${orderBy(params)} ${limit}`), values);
    const result = rows.rows[0]!.body;
    if ((headers.get('Accept') ?? '').includes('vnd.pgrst.object') && result.length !== 1) {
      return Response.json({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null },
        { status: 406 });
    }
    return Response.json(result);
  }
  if (method === 'POST') {
    const rows = Array.isArray(body) ? body : [body];
    const columns = (params.get('columns')?.split(',').map((column) => column.replace(/^"|"$/g, '')) ?? Object.keys(rows[0] as object)).map(quote);
    values.push(JSON.stringify(rows));
    let conflict = '';
    if (prefer.has('resolution=merge-duplicates') || prefer.has('resolution=ignore-duplicates')) {
      const target = (params.get('on_conflict') ?? '').split(',').map(quote).join(', ');
      conflict = prefer.has('resolution=ignore-duplicates') ? `on conflict (${target}) do nothing`
        : `on conflict (${target}) do update set ${columns.map((column) => `${column} = excluded.${column}`).join(', ')}`;
    }
    const insert = `insert into ${relation} as _t (${columns.join(', ')})
      select ${columns.join(', ')} from json_populate_recordset(null::${relation}, $1::json) ${conflict} returning _t.*`;
    const result = await tx.query<{ body: unknown[] }>(agg(insert), values);
    return representation ? Response.json(result.rows[0]!.body, { status: 201 }) : new Response(null, { status: 201 });
  }
  if (method === 'PATCH') {
    const patch = body as Record<string, unknown>;
    values.push(JSON.stringify(patch));
    const set = Object.keys(patch).map((column) => `${quote(column)} = _p.${quote(column)}`).join(', ');
    const update = `update ${relation} _t set ${set} from json_populate_record(null::${relation}, $1::json) _p ${where(params, values)} returning _t.*`;
    const result = await tx.query<{ body: unknown[] }>(agg(update), values);
    return representation ? Response.json(result.rows[0]!.body) : new Response(null, { status: 204 });
  }
  if (method === 'DELETE') {
    const result = await tx.query<{ body: unknown[] }>(agg(`delete from ${relation} _t ${where(params, values)} returning _t.*`), values);
    return representation ? Response.json(result.rows[0]!.body) : new Response(null, { status: 204 });
  }
  throw Object.assign(new Error(`Unsupported method: ${method}`), { code: 'PGRST100' });
}

async function rpc(tx: Transaction, fn: string, args: Record<string, unknown>) {
  const found = await tx.query<{ names: string[] | null; types: string[]; returns: string }>(`select p.proargnames as names,
    array(select format_type(t, null) from unnest(p.proargtypes) t) as types, format_type(p.prorettype, null) as returns
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [fn]);
  const signature = found.rows[0];
  const names = signature?.names ?? [];
  // PostgREST finds a function by its name and the set of argument names.
  if (found.rows.length !== 1 || names.length !== Object.keys(args).length || !Object.keys(args).every((name) => names.includes(name))) {
    return Response.json({ code: 'PGRST202', message: `Could not find the function public.${fn}(${Object.keys(args).sort().join(', ')})`,
      details: null, hint: null }, { status: 404 });
  }
  const values = names.map((name, index) => {
    const value = args[name];
    if (value === null || value === undefined) return null;
    return signature!.types[index] === 'jsonb' || signature!.types[index] === 'json' ? JSON.stringify(value) : String(value);
  });
  const call = `public.${quote(fn)}(${names.map((name, index) => `${quote(name)} => $${index + 1}::${signature!.types[index]}`).join(', ')})`;
  if (signature!.returns === 'void') {
    await tx.query(`select ${call}`, values);
    return new Response(null, { status: 204 });
  }
  const result = await tx.query<{ body: unknown }>(`select to_json(${call}) as body`, values);
  return Response.json(result.rows[0]!.body ?? null);
}

/** PostgREST's status for a database error, and its body. */
function failure(error: unknown): Response {
  const { code = '', message = String(error), detail = null, hint = null } = error as { code?: string; message?: string; detail?: string | null;
    hint?: string | null };
  const status = code === '23505' || code === '23503' ? 409 : code === '42501' ? 403 : code === '42883' ? 404 : code.startsWith('PGRST') ? 400 : 400;
  return Response.json({ code, message, details: detail, hint }, { status });
}
