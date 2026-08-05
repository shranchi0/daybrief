# Supabase Reference (verified against live docs, 2026-08-05)

Sources: `https://supabase.com/llms.txt` index, `https://supabase.com/llms/js.txt` (full JS reference),
guide pages fetched as `.md` (`/docs/guides/...md`), and `@supabase/postgrest-js` / `@supabase/storage-js`
2.112.1 source on jsDelivr. Anything not confirmed from those is marked **UNVERIFIED**.

Current package versions (checked via `npm view`, 2026-08-05):

- `@supabase/supabase-js` **2.112.1** (the supabase-js repo is now a monorepo; `@supabase/postgrest-js`
  and `@supabase/storage-js` are version-aligned at 2.112.1)
- Related server packages: `@supabase/ssr` (cookie sessions in Next.js/SvelteKit),
  `@supabase/server` (new: stateless header-auth wrapper for Edge Functions/Workers/API routes).
  Both wrap `supabase-js`; neither replaces it. For a CLI, plain `supabase-js` is correct.

---

## 0. API keys (IMPORTANT — this changed)

From `https://supabase.com/docs/guides/api/api-keys.md`:

| Type            | Format               | Privileges | Notes |
| --------------- | -------------------- | ---------- | ----- |
| Publishable key | `sb_publishable_...` | Low (`anon` role) | Safe to ship in clients/CLIs. |
| Secret key      | `sb_secret_...`      | Elevated (`service_role` role, BYPASSRLS) | Server only. |
| `anon`          | long-lived JWT       | Low        | **Legacy** version of publishable key. |
| `service_role`  | long-lived JWT       | Elevated   | **Legacy** version of secret key. |

- Legacy JWT keys still work alongside new keys, but **"they will be deprecated by the end of 2026"** —
  use `sb_publishable_...` / `sb_secret_...` for a new project.
- Keys live in Dashboard → **Settings > API Keys** (`/dashboard/project/_/settings/api-keys/`).
  New keys: "API Keys" tab (click **Create new API Keys** if none exist). Legacy: "Legacy API Keys" tab.
- Secret keys are rejected with **HTTP 401** when used from a browser (matched on `User-Agent`).
- New keys are NOT JWTs. Compatibility caveats (verbatim from docs):
  - "You cannot send a publishable or secret key in the `Authorization: Bearer ...` header, except if
    the value exactly equals the `apikey` header." (supabase-js handles this for you — just pass the key.)
  - Edge Functions only verify JWTs from legacy keys; with new keys deploy with `--no-verify-jwt` and
    do your own `apikey` check inside the function.
  - Public Realtime connections are limited to 24h unless upgraded with user-level auth.

Raw REST call headers (PostgREST base URL `https://<project_ref>.supabase.co/rest/v1/`):

```
apikey: sb_secret_...            (or sb_publishable_... / legacy JWT)
Authorization: Bearer sb_secret_...   (must equal apikey when using new keys;
                                       with legacy keys this is the JWT; with a logged-in
                                       user it's the user's access token JWT)
Content-Type: application/json
Prefer: return=representation    (to get inserted/updated rows back)
```

Storage REST example (from storage docs):

```
POST https://<project_ref>.supabase.co/storage/v1/object/{bucket}/{path}
apikey: <key>
Authorization: Bearer <jwt-or-key>
--data-binary @file
```

### Data API access must be granted (new-ish default)

From the JS reference "Enable Data API access": expose tables in Dashboard → Integrations →
Data API settings (optionally enable "Default privileges for new entities"), or via SQL:

```sql
alter table public.your_table enable row level security;
grant select on public.your_table to anon;
grant select, insert, update, delete on public.your_table to authenticated;
grant all on public.your_table to service_role;
grant execute on function public.your_function to authenticated, service_role;
```

---

## 1. supabase-js v2 server-side usage

### Install & create a service-role (admin) client

```bash
npm install @supabase/supabase-js
```

```ts
import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

// Server-side admin client (docs-recommended options for server use)
const supabase = createClient<Database>(
  process.env.SUPABASE_URL!,          // https://<project_ref>.supabase.co
  process.env.SUPABASE_SECRET_KEY!,   // sb_secret_... (or legacy service_role JWT)
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
)
// supabase.auth.admin.* (createUser, listUsers, generateLink, ...) requires a secret key.
```

Notes:

- The secret key maps to the `service_role` Postgres role → **bypasses RLS entirely**.
- Without `persistSession: false` you get a harmless "No storage option exists to persist the
  session" warning on servers.
- `db: { schema: 'other' }` in options, or `.schema('other')` per query, for non-public schemas
  (schema must be in the exposed list).

### Generating TypeScript types (no local stack needed)

```bash
supabase gen types typescript --project-id <project_ref> > database.types.ts
# or generate from the Dashboard: /dashboard/project/_/api?page=tables-intro
```

Generated shape per table: `Database['public']['Tables']['t']: { Row, Insert, Update }`.
Helpers exported from the generated file / supabase-js:

```ts
import { Database, Tables, Enums } from './database.types'
let movie: Tables<'movies'>                      // Row type shorthand
import { QueryData, QueryError } from '@supabase/supabase-js'
const q = supabase.from('countries').select('id, name, cities(id, name)')
type CountriesWithCities = QueryData<typeof q>   // result type incl. joins
// .overrideTypes<Array<{ id: string }>>() to patch inference; { merge: false } to replace
```

### Insert / select / update

```ts
// INSERT (returns nothing by default; chain .select() to get rows back)
const { data, error } = await supabase
  .from('machines')
  .insert({ name: 'press-01', meta: { site: 'A' } })   // Insert type enforced
  .select()          // returns inserted row(s) as Row[]
  .single()          // exactly one row -> Row (errors if 0 or >1)

// Bulk insert
await supabase.from('machines').insert([{ name: 'a' }, { name: 'b' }])

// upsert (primary key must be in values, or use onConflict column)
await supabase.from('machines').upsert({ id: 1, name: 'x' }, { onConflict: 'name' }).select()

// SELECT
const { data, error, count } = await supabase
  .from('machines')
  .select('id, name, runs(count)', { count: 'exact' })  // count of matching rows
  .eq('status', 'active')
  .ilike('name', '%press%')
  .order('created_at', { ascending: false })
  .range(0, 49)                       // pagination (count is TOTAL matching, not page size)
// default server-side max rows per request: 1000 (project API settings)

// UPDATE (always with filters)
const { data: updated, error: uerr } = await supabase
  .from('machines')
  .update({ status: 'retired' })
  .eq('id', 1)
  .select()

// DELETE
await supabase.from('machines').delete().eq('id', 1)

// RPC (Postgres function)
const { data: rows } = await supabase.rpc('match_documents', { query_embedding, match_count: 10 })
```

Useful modifiers: `.single()`, `.maybeSingle()` (0 or 1 rows), `.limit(n)`, `.range(from,to)`,
`.order(col, { ascending })`, `.csv()`, `.abortSignal(AbortSignal.timeout(1000))`, `.throwOnError()`,
`.explain()`.

### Response & error shape (verified from postgrest-js 2.112.1 source)

Every query resolves (never rejects, unless `.throwOnError()`) to:

```ts
// success
{ success: true,  data: T,    error: null,           count: number | null, status: number, statusText: string }
// failure
{ success: false, data: null, error: PostgrestError, count: null,          status: number, statusText: string }
```

- `statusText` may be an empty string over HTTP/2/3 — branch on `status`.
- `count` is populated only when you pass `{ count: 'exact' | 'planned' | 'estimated' }`.

`PostgrestError extends Error`:

```ts
{ name: 'PostgrestError', message: string, details: string, hint: string, code: string }
```

- `code` is a PostgREST code (e.g. `PGRST301`) or a Postgres SQLSTATE (e.g. `42501` permission
  denied, `23505` unique_violation — standard Postgres codes).
- Docs emphasize: log the WHOLE error object; for `42501` the `hint` contains the literal
  `GRANT ...` SQL fix. Branch on `code`, not on `message` text.
- `.throwOnError()` makes the promise reject with the error instead.

Idiomatic handling:

```ts
const { data, error } = await supabase.from('machines').select().eq('id', id).maybeSingle()
if (error) {
  console.error(error)          // full object: message, code, details, hint
  throw error                   // PostgrestError extends Error, safe to throw
}
if (!data) { /* not found */ }
```

---

## 2. Schema management for a hosted project (no local stack)

Verified from `https://supabase.com/docs/guides/deployment/database-migrations.md` and the CLI
reference (`https://supabase.com/llms/cli.txt`):

**Yes — you can simply run SQL in the Dashboard SQL editor** (`/dashboard/project/_/sql/new`).
Supabase's own docs tell you to run setup snippets there. Nothing else is required for a fresh
hosted project. The Table Editor works too.

If you use the CLI migration workflow instead:

- `supabase migration new <name>` — purely local; creates `supabase/migrations/<timestamp>_<name>.sql`.
  No login, no Docker, no link needed. (`supabase init` first to create `supabase/config.toml`.)
- `supabase db push` — applies unapplied local migration files to the **remote** DB in timestamp
  order; tracks state in `supabase_migrations.schema_migrations`. Requires: `supabase login`
  (personal access token; or `SUPABASE_ACCESS_TOKEN` env) and `supabase link --project-ref <ref>`
  (asks for the database password; or `SUPABASE_DB_PASSWORD` env). `--dry-run` to preview.
  Docker is NOT listed as a requirement for push. UNVERIFIED nuance: some subcommands shell out to
  containers; push itself is documented as a direct remote apply.
- Commands that DO require the local Docker stack (`supabase start`, ≥7GB RAM recommended):
  `supabase db reset`, `supabase db diff` (against local), `supabase db lint`, local Studio.
  `db diff --linked` / `db pull` run against the remote instead (docs still run migra/pg-delta
  "in a container" for diffing — so Docker is needed for diff even when remote. UNVERIFIED for
  newest CLI builds).
- **The golden rule (verbatim from docs)**: once you adopt `db push`, "never change the remote
  database directly" — SQL-editor/Table-editor changes on the remote bypass migration history and
  make `db push` fail with sync errors. Recovery: `supabase db pull` (captures remote schema into
  a migration) and/or `supabase migration repair --status applied|reverted <timestamp>`.

**Recommendation for a solo builder (machineint):**
Keep a `migrations/` folder of numbered `.sql` files in your repo, and paste/run each one in the
Dashboard SQL editor (or run them with any Postgres client against the connection string). Don't
adopt the CLI migration tracking until you need branches/CI. This is fully supported, zero local
infra, and you keep history in git. If you later adopt the CLI: `supabase login && supabase link`,
then `supabase db pull` to snapshot the current remote schema as migration #1, and from then on
only change schema via `db push`.

---

## 3. pgvector

From `guides/ai/vector-columns.md`, `guides/database/extensions/pgvector.md`,
`guides/ai/vector-indexes/hnsw-indexes.md`, `guides/ai/vector-indexes/ivf-indexes.md`.

### Enable + declare column (run in SQL editor)

```sql
create extension vector with schema extensions;   -- extension is named "vector"

create table documents (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  embedding extensions.vector(384)   -- dimension must match your embedding model
);
```

(Docs qualify the type as `extensions.vector(n)` because the extension is installed into the
`extensions` schema; plain `vector(n)` works if `extensions` is on your search_path.)

### Insert embeddings from JS

A plain `number[]` is accepted by supabase-js/PostgREST (verified doc example):

```ts
const embedding: number[] = Array.from(output.data)   // e.g. from an embeddings API
const { error } = await supabase.from('documents').insert({ title, body, embedding })
```

In raw SQL the vector literal is a bracketed string: `'[0.1, 0.2, 0.3]'::vector`
(standard pgvector syntax; e.g. `... order by embedding <-> '[3,1,2]' limit 5` appears in the
Supabase pgvector guide).

### Similarity query (distance operators)

| Operator | Meaning                | Index opclass        |
| -------- | ---------------------- | -------------------- |
| `<->`    | Euclidean (L2)         | `vector_l2_ops`      |
| `<#>`    | negative inner product | `vector_ip_ops`      |
| `<=>`    | cosine distance        | `vector_cosine_ops`  |

**PostgREST does not support these operators**, so wrap the query in a SQL function and call it
via `.rpc()` (this is the documented pattern):

```sql
create or replace function match_documents (
  query_embedding extensions.vector(384),
  match_threshold float,
  match_count int
)
returns table (id bigint, title text, body text, similarity float)
language sql stable
as $$
  select
    documents.id, documents.title, documents.body,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where 1 - (documents.embedding <=> query_embedding) > match_threshold
  order by (documents.embedding <=> query_embedding) asc   -- order by DISTANCE, not the alias,
  limit match_count;                                       -- or the index gets ignored
$$;
```

```ts
const { data: documents, error } = await supabase.rpc('match_documents', {
  query_embedding: embedding,   // number[]
  match_threshold: 0.78,
  match_count: 10,
})
```

### Indexes

HNSW — recommended default; safe to create immediately (unaffected by data growth):

```sql
create index on documents using hnsw (embedding vector_cosine_ops);
-- also: vector_l2_ops / vector_ip_ops variants
```

IVFFlat — only build after the table has representative data; rebuild if distribution shifts:

```sql
create index on documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);
set ivfflat.probes = 10;   -- per session; more probes = better recall, slower
```

Limits & extras (pgvector ≥ 0.7): index `vector` up to 2,000 dims, `halfvec` up to 4,000
(`create index on documents using hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);`).
Filtered ANN queries can return fewer rows than LIMIT; pgvector ≥ 0.8 supports iterative scans:
`set hnsw.iterative_scan = 'strict_order' | 'relaxed_order'` (default `off`),
bounded by `hnsw.max_scan_tuples` (default 20,000).

---

## 4. Postgres full-text search

From `https://supabase.com/docs/guides/database/full-text-search.md`.

### Generated tsvector column + GIN index (documented pattern)

```sql
alter table books
add column fts tsvector
generated always as (to_tsvector('english', description || ' ' || title)) stored;

create index books_fts on books using gin (fts);
```

Weighted variant (title matches outrank description matches):

```sql
alter table books
add column fts_weighted tsvector
generated always as (
  setweight(to_tsvector('english', title), 'A') ||
  setweight(to_tsvector('english', description), 'B')
) stored;
create index books_fts_weighted on books using gin (fts_weighted);
```

For **jsonb** content: Postgres's `to_tsvector` has a `(regconfig, jsonb)` overload (concatenates
all string values), and `jsonb_to_tsvector('english', col, '["string"]')` gives finer control —
so `generated always as (to_tsvector('english', payload)) stored` works for a jsonb `payload`
column. NOTE: standard Postgres, but the jsonb variant specifically is **not shown in the Supabase
guide** (guide covers text columns) — verify against Postgres docs when you use it. Watch out:
`generated` columns require IMMUTABLE expressions; always pass the config (`'english'`) explicitly,
the one-argument form is not immutable. For concatenating nullable text columns use
`coalesce(col, '')` (a null makes the whole `||` chain null).

### Querying from JS

```ts
// query string syntax is tsquery: 'fat' & 'cat', 'fat' | 'cat', !'cat', 'big' <-> 'dreams', 'Lit:*'
const { data, error } = await supabase
  .from('books')
  .select()
  .textSearch('fts', `'little' & 'big'`, { config: 'english' })

// friendlier user-facing syntax (quotes, or, -negation):
await supabase.from('books').select()
  .textSearch('fts', '"green eggs" or ham -vegetables', { type: 'websearch', config: 'english' })
// other types: 'plain' (plainto_tsquery), 'phrase' (phraseto_tsquery); default = raw to_tsquery
```

Ranked search must go through an RPC (ranking is computed server-side):

```sql
create or replace function search_books(search_query text)
returns table(id int, title text, description text, rank real) as $$
begin
  return query
  select b.id, b.title, b.description,
         ts_rank(b.fts, websearch_to_tsquery('english', search_query)) as rank
  from books b
  where b.fts @@ websearch_to_tsquery('english', search_query)
  order by rank desc;
end;
$$ language plpgsql;
```

```ts
const { data, error } = await supabase.rpc('search_books', { search_query: 'big dreams' })
```

Multi-column search without a stored column: create an immutable computed-column function
(`create function title_description(books) returns text ...`) and `.textSearch('title_description', ...)`.

---

## 5. Storage (server-side)

Verified from js.txt + storage-js 2.112.1 source.

```ts
// Upload (bucket must already exist; create via Dashboard or supabase.storage.createBucket)
// Body can be Blob/File/ArrayBuffer/etc. In Node, Buffer/ArrayBuffer/ReadableStream work;
// pass contentType explicitly when not uploading a File.
const { data, error } = await supabase.storage
  .from('reports')
  .upload('2026/08/report.pdf', fileBuffer, {
    contentType: 'application/pdf',
    cacheControl: '3600',
    upsert: false,          // default; true overwrites (needs select+insert+update RLS perms)
  })
// success: data = { id: string, path: string, fullPath: string }
//   e.g. { id: '...', path: '2026/08/report.pdf', fullPath: 'reports/2026/08/report.pdf' }
// duplicate path without upsert -> 400 "Asset Already Exists" / statusCode 'Duplicate'

// Signed URL (time-limited read access; needs objects SELECT permission — trivially true
// with a secret-key client)
const { data: signed, error: serr } = await supabase.storage
  .from('reports')
  .createSignedUrl('2026/08/report.pdf', 60 * 60, { download: true })  // expiresIn seconds
// success: signed = { signedUrl: string }
// batch: createSignedUrls([paths], expiresIn) ; upload-side: createSignedUploadUrl(path)
// public buckets: supabase.storage.from('b').getPublicUrl('path') (no request, always succeeds)
```

`StorageError extends Error` shape (source-verified):

```ts
{ name: 'StorageError', message: string, status?: number, statusCode?: string }
// API errors are StorageApiError with status (HTTP), statusCode, and code — a service error
// name such as 'NoSuchKey', 'AccessDenied', 'ResourceAlreadyExists'.
// isStorageError(err) type guard is exported.
```

Standard uploads are fine to 5GB but docs recommend TUS resumable uploads above ~6MB.
Raw REST: `POST /storage/v1/object/{bucket}/{path}` with `apikey` + `Authorization: Bearer` +
binary body; `x-upsert: true` header to overwrite.

---

## 6. Realtime: postgres_changes (brief)

From `guides/realtime/postgres-changes.md` + js.txt.

Setup (SQL editor):

```sql
-- add table to the realtime publication
alter publication supabase_realtime add table public.machines;
-- optional: receive OLD record on UPDATE/DELETE
alter table public.machines replica identity full;
```

Client (works with publishable key; changes are authorized per-subscriber via RLS —
subscribers need SELECT visibility on the rows):

```ts
const channel = supabase
  .channel('machines-changes')      // any name except 'realtime'
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'machines', filter: 'status=eq.active' },
    (payload) => console.log(payload)   // { eventType, new, old, schema, table, commit_timestamp, errors }
  )                                     // (payload field names UNVERIFIED beyond docs' examples)
  .subscribe((status, err) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.error(status, err)
  })
// events: 'INSERT' | 'UPDATE' | 'DELETE' | '*' ; cleanup: supabase.removeChannel(channel)
```

Scaling note from docs: every change is authorized per subscriber (100 subscribers = 100 checks
per change) — above ~3,000 concurrent subscribers use Broadcast-from-database instead. With RLS +
`replica identity full`, DELETE `old` records contain only primary keys.

---

## 7. Auth: Google OAuth with hosted-domain restriction (brief)

From `guides/auth/social-login/auth-google.md`, `guides/auth/auth-hooks/before-user-created-hook.md`,
and community-verified `hd` usage.

Setup: Google Cloud OAuth client (Web application), authorized redirect URI =
`https://<project_ref>.supabase.co/auth/v1/callback`; put Client ID/Secret in Dashboard →
Auth → Providers → Google. Scopes: `openid`, `userinfo.email`, `userinfo.profile`.

```ts
const { data, error } = await supabase.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: 'https://yourapp.com/auth/callback',
    queryParams: {
      hd: 'categoryvc.com',        // Google account-picker filter to that Workspace domain
      access_type: 'offline',      // only if you need provider_refresh_token
      prompt: 'consent',
    },
  },
})
```

**`hd` alone is NOT a security boundary** (it only pre-filters Google's account chooser; the
`queryParams` mechanism is documented, the `hd` key itself is a Google OAuth parameter —
community-verified pattern, not shown verbatim in Supabase docs). Enforce server-side with one of:

1. **Google-side**: set the OAuth app's Audience to "Internal" in Google Auth Platform console
   (restricts sign-in to your Workspace org — docs: "Audience: configuring which Google users are
   allowed to sign in").
2. **Supabase-side (documented)**: a **Before User Created** auth hook (Dashboard → Auth → Hooks)
   backed by a Postgres function; returning an error object rejects the signup. Minimal version
   (adapted from the docs' allow-by-domain example — the docs' own snippet has a `$1` bug):

```sql
create or replace function public.hook_restrict_signup_domain(event jsonb)
returns jsonb language plpgsql as $$
declare
  signup_domain text := split_part(event->'user'->>'email', '@', 2);
begin
  if lower(signup_domain) = 'categoryvc.com' then
    return '{}'::jsonb;   -- allow
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'message', 'Signups are restricted to categoryvc.com accounts.',
    'http_code', 403));
end;
$$;
grant execute on function public.hook_restrict_signup_domain to supabase_auth_admin;
revoke execute on function public.hook_restrict_signup_domain from authenticated, anon, public;
```

Hook input payload: `{ metadata: { uuid, time, name: 'before-user-created', ip_address }, user: { id, email, app_metadata: { provider, providers }, ... } }`.
(For One Tap / `signInWithIdToken` flows, additionally validate the `hd` claim in the Google ID
token yourself — UNVERIFIED in Supabase docs, standard Google guidance.)

For the later Next.js app use `@supabase/ssr` (`createServerClient` with cookie getAll/setAll) and
PKCE `exchangeCodeForSession(code)` in the callback route.

---

## Gotchas recap

- New API keys (`sb_publishable_`/`sb_secret_`) replace `anon`/`service_role` JWTs; legacy keys
  deprecated end of 2026. New keys can't go in `Authorization: Bearer` unless identical to `apikey`.
- Fresh projects: tables aren't reachable through the Data API until exposed/granted (Dashboard
  Data API settings or explicit `grant` SQL).
- Query responses never throw by default — always destructure `{ data, error }` (or `.throwOnError()`).
  Response now also carries `success`, `status`, `statusText`; `statusText` can be `''` on HTTP/2.
- `.select()` after `insert/update/delete` is required to get rows back; default select cap 1000 rows.
- pgvector similarity must go through `rpc()`; order by the raw distance expression, not an alias.
- HNSW: create anytime; IVFFlat: only after data exists. Index cap 2,000 dims (`halfvec` to 4,000).
- Dashboard SQL editor is fully supported for schema work; but once you adopt CLI `db push`, never
  edit remote schema via the Dashboard again (breaks migration-history sync; fix with `db pull`/`migration repair`).
- Realtime postgres_changes requires the table added to the `supabase_realtime` publication.
- Storage duplicate upload → 400 `Duplicate` unless `upsert: true` / `x-upsert` header.
- `hd` queryParam is cosmetic; enforce domain restriction with a Before User Created hook or an
  Internal-audience Google OAuth app.
