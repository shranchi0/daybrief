# Affinity CRM API Reference (verified August 2026)

Verified against live docs on 2026-08-05:

- **v2 docs**: https://developer.affinity.co (Mintlify; every page also served as raw `.md`, index at https://developer.affinity.co/llms.txt)
- **v1 docs**: https://api-docs.affinity.co (single-page Slate site, legacy)

Per the PRD: **prefer v2 where available, fall back to v1.** v2 is NOT at feature parity with v1
(Affinity says so explicitly); the fallback cases that matter for us are noted inline below.

---

## 1. Versions, base URLs, auth, plan gating

### Base URL (same host for both versions)

```
https://api.affinity.co          # v1 endpoints live at the root, e.g. GET /organizations
https://api.affinity.co/v2/...   # all v2 endpoints are prefixed with /v2
```

HTTPS required. HTTP requests return no data.

### API versions within v2 (date-based)

- **`2026-07-15`** — current stable. Breaking changes vs 2024-01-01: (a) list-entry field values on
  opportunities your key can't manage come back as `type: "hidden"` with `value.data: null` (and
  writes to them return 403); (b) `quarter` added to relative-date filter units.
- **`2024-01-01`** — previous stable, locked, no further changes.

Select per request with the `X-Affinity-Api-Version: 2026-07-15` header; otherwise the app's
"Default API Version" (configured in Settings → Manage Apps) is used. `current` is accepted but
makes you vulnerable to breaking changes. Every response echoes `X-Affinity-Api-Version`.

### Authentication

API keys are created in Affinity Settings → **Manage Apps** (requires the "Generate an API key"
role permission). Keys act as the user they belong to and respect that user's in-product sharing
permissions. Optional per-key IP allowlist.

| Version | Scheme | Example |
|---|---|---|
| **v2** | Bearer only | `Authorization: Bearer $AFFINITY_API_KEY` |
| **v1** | HTTP Basic (blank username, key as password) **or** Bearer (added 2025-11-05) | `curl -u ":$AFFINITY_API_KEY"` or `Authorization: Bearer $AFFINITY_API_KEY` |

Practical consequence: **use `Authorization: Bearer <key>` for both versions** with the same key.

Verify auth / identity:

- v2: `GET /v2/auth/whoami` → `{ tenant: {id, name, subdomain}, user: {id, firstName, lastName, emailAddress}, grant: {type: "api-key", scopes: ["api"], createdAt} }`
- v1: `GET /whoami` (same idea, snake_case)

### Plan gating

From the rate-limit tables (both doc sites) plus the Help Center FAQ (article 5563700459533):

| Plan tier | API access (v1 AND v2) | Monthly call cap (account-wide, both versions pooled) |
|---|---|---|
| Essentials | **No API access** | — |
| Scale | Yes | 100,000 |
| Advanced | Yes | 100,000 |
| Enterprise | Yes | Unlimited (per-minute + concurrency limits still apply) |
| Professional (legacy) | v1 table lists it | None listed (pre-July-2023 signups: 40,000/mo) |
| Premium (legacy) | v1 table lists it | 100,000 |

There is **no separate gate for v2 vs v1** — any plan with API access gets both. Trials get no API
access.

---

## 2. Find an organization by domain

### v2 (preferred): `POST /v2/companies/search` — ⚠️ BETA

Beta means breaking changes may occur **without versioning or notice**. Wrap this call so it's easy
to swap to the v1 fallback.

The `search.term` is always matched against **company name and primary domain** (min 3 chars).
Requires the "Export All Organizations directory" permission on the key's user.

```http
POST https://api.affinity.co/v2/companies/search?limit=10
Authorization: Bearer <key>
Content-Type: application/json

{ "search": { "term": "acme.com" } }
```

Query params: `fieldIds` (repeatable) or `fieldTypes` (repeatable; `enriched | global | relationship-intelligence`)
— mutually exclusive — plus `cursor`, `limit` (1–100, default 100), `totalCount` (boolean, extra
query cost). **Returns `201`** (not 200) with:

```json
{
  "data": [
    {
      "id": 1,
      "name": "Horizon Technologies",
      "domain": "horizontech.com",
      "domains": ["horizontech.com"],
      "isGlobal": false,
      "fields": []
    }
  ],
  "pagination": { "prevUrl": null, "nextUrl": "https://api.affinity.co/v2/companies/search?cursor=..." }
}
```

`domain` is the primary domain (nullable); `domains` is all domains. `isGlobal: true` means the
record is from Affinity's global dataset rather than tenant-created. The search body also supports
`filters` (nested AND/OR `FilterGroup` of `{fieldId, valueType, operator, value, attributeId?}`)
and `sorts` (max 5) — see §4 for field IDs.

Note: v2 `GET /v2/companies` has **no** `term`/domain parameter (only `ids`, `fieldIds`,
`fieldTypes`, `cursor`, `limit`), so the beta search endpoint is the only native v2 domain lookup.

**List memberships in v2** (after you have `companyId`):

- `GET /v2/companies/{companyId}/lists` → paged `ListWithType[]` (see §4).
- `GET /v2/companies/{companyId}/list-entries` → paged rows across all lists **with comprehensive
  field data attached automatically** (no fieldIds needed).

### v1 (stable fallback): `GET /organizations?term=<domain>`

```bash
curl "https://api.affinity.co/organizations?term=acme.com" -H "Authorization: Bearer $KEY"
```

```json
{
  "organizations": [
    { "id": 64779194, "name": "Affinity", "domain": "affinity.co", "domains": ["affinity.co"], "global": false }
  ],
  "next_page_token": "eyJ..."
}
```

- `term` matches part of name **or domain**.
- Gotcha: when only a `term` is supplied, Affinity also searches its **global dataset outside your
  instance** — filter results client-side (e.g., require exact domain match and/or `global: false`
  depending on intent).
- `page_size` (default = max = 500), `page_token`.
- Optional: `with_interaction_dates=true`, `with_interaction_persons=true`, `with_opportunities=true`,
  and `min_/max_{first_email|last_email|last_interaction|last_event|first_event|next_event}_date`
  filters (ISO 8601). With `with_interaction_dates=true`, orgs with **no** interactions are omitted.
- `GET /organizations/{id}` additionally returns `person_ids`, `opportunity_ids` (with param), and
  `list_entries: [{id, list_id, creator_id, entity_id, created_at}]` — i.e., v1 gives you list
  memberships directly on the single-org fetch.

---

## 3. Find a person by email

### v2 (preferred): `POST /v2/persons/search` — ⚠️ BETA

`search.term` is always matched against **first name, last name, and primary email address**.
Requires the "Export All People directory" permission. Same query params / body / 201 response
pattern as company search.

```http
POST https://api.affinity.co/v2/persons/search
Content-Type: application/json

{ "search": { "term": "jane@acme.com" } }
```

Person object (v2):

```json
{
  "id": 1,
  "firstName": "Jane",
  "lastName": "Doe",
  "primaryEmailAddress": "jane.smith@northpointvc.com",
  "emailAddresses": ["jane.smith@northpointvc.com", "janedoe@gmail.com"],
  "type": "internal",
  "fields": []
}
```

`type` is `"internal" | "external"` (in some nested `PersonData` contexts also `"collaborator"`).
Caveat: the term matches **primary** email; a person findable only by a secondary address may be
missed (UNVERIFIED whether secondary emails are matched — docs only promise first/last name +
primary email). The v1 fallback searches all emails.

**Associated orgs in v2**: the person object itself has no org-ID array. Get them via field data —
e.g. `GET /v2/persons/{id}?fieldTypes=enriched` and read the `affinity-data-current-organizations`
-style enriched field (a `company-multi` value), or use `GET /v2/persons/{id}/list-entries` /
`/lists` for list context. (Exact enriched field ID varies by tenant — discover via
`GET /v2/persons/fields`.)

### v1 (stable fallback): `GET /persons?term=<email>`

`term` can be part of an **email address**, first name, or last name.

```json
{
  "persons": [
    {
      "id": 38706, "type": 0, "first_name": "John", "last_name": "Doe",
      "primary_email": "john@affinity.co",
      "emails": ["john@affinity.co", "jdoe@alumni.stanford.edu", "johnjdoe@gmail.com"]
    }
  ],
  "next_page_token": "eyJ..."
}
```

- v1 `type`: `0` = external, `1` = internal (integer enum, not string). (Direction verified from the
  docs' example: `john@affinity.co` employee is listed with `type: 0` in one sample, so treat the
  numeric mapping as **UNVERIFIED** and rely on it only via v2's string `type` if it matters.)
- The list response does **not** include `organization_ids`/`list_entries`. Fetch
  `GET /persons/{id}?with_current_organizations=true&with_opportunities=true` to get
  `organization_ids` (all associated orgs, past and present), `current_organization_ids`
  (per "Affinity Data: Current Organizations"), and `list_entries`.
- Same `with_interaction_dates` / `min_/max_*_date` / `page_size` (max 500) / `page_token`
  machinery as organizations.

---

## 4. Lists, list entries, and field values

### v2 model in one paragraph

Fields have string IDs and a `type` ∈ `enriched | global | list | relationship-intelligence`
(`hidden` appears only as a redaction state on restricted opportunities in 2026-07-15). ID
patterns: enriched → `affinity-data-description`, `dealroom-…`; global & list → `field-1234`;
relationship-intelligence → human-readable slugs like `source-of-introduction`, `first-email`,
`last-email`, `last-contact`, `first-event`, `last-event`, `next-event`, `first-chat-message`,
`last-chat-message`. Value types (`valueType` in metadata, `value.type` on data):
`text`, `number(-multi)`, `datetime`, `location(-multi)`, `dropdown(-multi)`, `ranked-dropdown`,
`person(-multi)`, `company(-multi)`, `filterable-text(-multi)`, `formula-number`, `interaction`.
Empty multi-values come back as `null`, not `[]`. **Status columns are `ranked-dropdown` list
fields.**

### v2 endpoints

| Purpose | Endpoint | Notes |
|---|---|---|
| Enumerate lists | `GET /v2/lists` | `term` (substring on name), `cursor`, `limit` ≤ 100. Item: `{id, name, creatorId, ownerId, isPublic, type: "company"\|"person"\|"opportunity", createdAt}` |
| List's field metadata | `GET /v2/lists/{listId}/fields` | Returns `FieldMetadata {id, name, type, enrichmentSource, valueType, createdAt}`; supports `filter` (`name="Status"`, `name=~stat`) and `includes=filterability&includes=sortability` |
| Rows on a list | `GET /v2/lists/{listId}/list-entries` | **Must pass `fieldIds` or `fieldTypes` to get any field data** (`fieldTypes` here also allows `list`). Requires "Export data from Lists" permission. Items are discriminated by `type` (`company`/`person`/`opportunity`) with `entity` embedded |
| One row | `GET /v2/lists/{listId}/list-entries/{listEntryId}` | |
| **All field values on one row** | `GET /v2/lists/{listId}/list-entries/{listEntryId}/fields` | Paged; all fields by default; filter with `ids`/`types` (`enriched\|global\|list\|relationship-intelligence`); default `limit` 20, max 100 |
| Rows for a company across lists | `GET /v2/companies/{companyId}/list-entries` | Comprehensive field data attached automatically (no field selection needed/possible) |
| Rows for a person across lists | `GET /v2/persons/{personId}/list-entries` | Same |
| Lists containing a company/person | `GET /v2/companies/{id}/lists`, `GET /v2/persons/{id}/lists` | |
| Non-list field values on a company | `GET /v2/companies/{companyId}/fields` (⚠️ BETA) | `ids`/`types` params; list fields NOT returned here |
| Non-list field metadata | `GET /v2/companies/fields`, `GET /v2/persons/fields` | Discover field IDs/valueTypes for the `fieldIds`/`fieldTypes` params and search filters |
| Search rows on a list | `POST /v2/lists/{listId}/list-entries/search` (⚠️ BETA) | Same SearchCriteria body as §2 |
| Write one cell | `POST /v2/lists/{listId}/list-entries/{listEntryId}/fields/{fieldId}` / batch `PATCH …/fields` | 403 on restricted-opportunity fields (2026-07-15) |
| Field value history | `GET /v2/field-value-changes` (⚠️ BETA, workspace-wide, `filter=changedAt>…` for delta sync) and `GET /v2/lists/{listId}/list-entries/{listEntryId}/field-value-changes` | Only user-managed `global`/`list` fields track changes |

Field-with-value shape (as returned inside `fields[]` or by the `*/fields` value endpoints):

```json
{
  "id": "field-1625",
  "name": "Status",
  "type": "list",
  "enrichmentSource": null,
  "value": {
    "type": "ranked-dropdown",
    "data": { "dropdownOptionId": 886, "text": "Interested", "rank": 1, "color": "gray" }
  }
}
```

`"Source of introduction"` = relationship-intelligence field, id **`source-of-introduction`**:
request via `?fieldTypes=relationship-intelligence` (or `fieldIds=source-of-introduction`) on
`GET /v2/companies/{id}` / `GET /v2/persons/{id}` / list-entries endpoints. Its value is a
`person`-typed value (the introducer) — UNVERIFIED exact value type; inspect
`GET /v2/companies/fields` output in the target tenant.

### v1 endpoints (fallback / when you need numeric field IDs)

| Purpose | Endpoint | Notes |
|---|---|---|
| Enumerate lists | `GET /lists` | Bare array. `{id, type: 0(person)\|1(org)\|8(opportunity), name, public, owner_id, creator_id, list_size}` |
| List + its fields | `GET /lists/{list_id}` | Adds `fields: [{id, name, value_type, allows_multiple, dropdown_options: [{id, text, rank, color}]}]` |
| Rows | `GET /lists/{list_id}/list-entries` | No `page_size` → returns **ALL** rows as a bare array; with `page_size` → `{list_entries, next_page_token}`. Row: `{id, list_id, creator_id, entity_id, entity, created_at}` — **no cell values here** |
| **Cell/field values** | `GET /field-values?list_entry_id=…` (or exactly one of `person_id` / `organization_id` / `opportunity_id`) | Bare array of `{id, field_id, list_entry_id, entity_id, created_at, updated_at, value}`. Entity-scoped queries include values from all of that entity's list entries (`list_entry_id` set on list-specific ones, `null` on global) |
| Field defs | `GET /fields?list_id=…&with_modified_names=true` | `value_type` ints: 0 person, 1 organization, 2 text/dropdown, 3 number, 4 date, 5 location, 6 long text, 7 **ranked dropdown (Status)**. `list_id: null` ⇒ global field |
| Write a cell | `POST /field-values` `{field_id, entity_id, value, list_entry_id?}`; `PUT /field-values/{id}`; `DELETE /field-values/{id}` | |
| Field value history | `GET /field-value-changes?field_id=…` | Now supports `changed_after`, `limit`, `order_by`, `after_id` keyset pagination (2026-03/04 changelog); `changed_at` has microsecond precision |

v1 gotchas:

- "Smart fields" (interaction dates) can NOT be read via `/field-values` — use
  `with_interaction_dates=true` on the person/org endpoints (§6).
- A dropdown "update" in-product may surface as a NEW field-value row (new `id`) rather than an
  update — key on `(field_id, list_entry_id)` not on field-value `id`.
- v1 dropdown `color` is an integer; v2 gives a string.
- "Source of Introduction" is not documented anywhere in v1 (not in `/fields`, not in
  `/field-values`) — treat it as **v2-only** (UNVERIFIED that it's impossible in v1, but no
  documented route exists).

---

## 5. Notes

### v2 (preferred)

| Endpoint | Behavior |
|---|---|
| `GET /v2/companies/{companyId}/notes` | Directly attached notes **plus** notes attached to persons at the company |
| `GET /v2/persons/{personId}/notes` | Directly attached + notes on meetings the person attended + notes where the person is mentioned |
| `GET /v2/opportunities/{opportunityId}/notes` | Direct + via associated persons |
| `GET /v2/notes` | All root notes (no replies). |
| `GET /v2/notes/{noteId}`, `GET /v2/notes/{noteId}/replies` (BETA), `POST /v2/notes` (v2 create supports a `creator` override), `PATCH`/`DELETE /v2/notes/{noteId}` | |
| `GET /v2/notes/{noteId}/companies` / `/persons` / `/opportunities` | Full attached-entity lists |

Common query params: `filter` (properties: `creator.id` `=`; `createdAt`/`updatedAt`
`>`, `<`, `>=`, `<=`; on `GET /v2/notes` also `id=1|id=2`), `cursor`, `limit` (default 20, max 100),
`totalCount`, and `includes` (repeatable: `companiesPreview`, `personsPreview`,
`opportunitiesPreview`, `repliesCount`).

Note shape — discriminated union on `type` ∈
`entities | interaction | ai-notetaker | user-reply | ai-notetaker-reply`; all share:

```json
{
  "id": 1,
  "type": "entities",
  "content": { "html": "<p>This is a note!</p>" },
  "creator": { "id": 1, "firstName": "Jane", "lastName": "Smith", "primaryEmailAddress": "…", "type": "internal" },
  "mentions": [],
  "createdAt": "2023-01-01T00:00:00Z",
  "updatedAt": "2023-01-21T00:00:00Z"
}
```

`interaction`-type notes add `interaction: {id, type: "meeting"|"call"|"chat-message"|"email"}`;
replies add `parent: {id}`. Content is HTML (`content.html`, nullable).

### v1 (fallback)

`GET /notes?organization_id=…` (or `person_id=`, `opportunity_id=`, `creator_id=`), `page_size` ≤
500, `page_token`. Note resource: `{id, creator_id, person_ids, associated_person_ids,
interaction_person_ids, interaction_id, interaction_type, is_meeting, mentioned_person_ids,
organization_ids, opportunity_ids, parent_id, content, type, created_at, updated_at}`. `type`:
0 plain text, 2 HTML, 1 legacy email-notes, 3 AI Notetaker summaries (system-only). `person_id`
filter also matches interaction attendees (like v2's person-notes semantics).

---

## 6. Interactions & relationship intelligence

### What actually exists

1. **First/last interaction dates per company/person**
   - **v2**: relationship-intelligence fields, fetched via
     `GET /v2/companies/{id}?fieldTypes=relationship-intelligence` (or `fieldIds=last-email&…`).
     Field IDs: `first-email`, `last-email`, `first-event`, `last-event`, `next-event`,
     `first-chat-message`, `last-chat-message`, `last-contact` (+ `source-of-introduction`).
     Value type is `interaction`: `value.data` is the actual interaction object
     (`{id, type: "meeting"|"email"|"call"|"chat-message", …, startTime/endTime or sentAt, attendees/participants with nested person}`), or `null`. In search
     filters/sorts these fields require `attributeId: "date-of-activity"`.
   - **v1**: `with_interaction_dates=true` (+ optional `with_interaction_persons=true`) on
     `GET /organizations`, `GET /organizations/{id}`, `GET /persons`, `GET /persons/{id}` →
     `interaction_dates: {first_email_date, last_email_date, first_event_date, last_event_date, next_event_date, last_chat_message_date, last_interaction_date}`
     and `interactions: {first_email: {date, person_ids}, …}`. Note v1 has a computed
     `last_interaction_date`; in v2 the analogue is `last-contact`.

2. **Relationship strength**
   - **v2**: `GET /v2/companies/{companyId}/relationships` and
     `GET /v2/persons/{personId}/relationships` → paged
     `{person1: {id, firstName, lastName, primaryEmailAddress}, person2: {…}, interactionScore, linkedIn: {connectedOn} | null}`.
     `interactionScore` ∈ 0.0–1.0 (≥0.7 regular contact, 0.4–0.7 occasional, <0.4 sporadic; recency
     weighted). Supports `filter=interactionScore>=0.5`, `orderBy=-interactionScore` (default),
     `limit` ≤ 100 (default 20), `totalCount`. Includes LinkedIn-connection-only rows with score 0.
   - **v1**: `GET /relationships-strengths?external_id={personId}[&internal_id={personId}]` → bare
     array `[{internal_id, external_id, strength}]`, strength 0–1, recalculated ~daily.
     `external_id` required (so v1 is person-centric; the docs' "Common Use Cases" section shows
     computing an org's strongest connection by iterating its people).

3. **Raw interaction streams**
   - **v2** (metadata only, paginated, permission-scoped): `GET /v2/emails`, `GET /v2/meetings`,
     `GET /v2/calls`, `GET /v2/chat-messages`; plus `GET /v2/transcripts` and inferred connections
     (`GET /v2/inferred-connections/coworker`-style, BETA — path UNVERIFIED, see llms.txt pages).
   - **v1**: `GET /interactions?type=…` (types: meetings/calls, chat messages, emails), max
     `page_size` 100, date range ≤ 1 year. Also CRUD for logged meetings/calls.

---

## 7. Rate limits, pagination, errors

### Rate limits (shared pool across v1+v2)

- **Per user**: 900 requests/minute (may be temporarily lowered).
- **Per account**: monthly cap by plan (see §1); resets at **end of calendar month**. Also an
  unspecified account-level concurrency cap.
- On any limit: **429**. Response headers on every call (lower-case in v2 docs, same names):

| Header | Meaning |
|---|---|
| `x-ratelimit-limit-user` / `-remaining` / `-reset` | per-minute user limit / remaining / seconds to reset |
| `x-ratelimit-limit-org` / `-remaining` / `-reset` | monthly account limit / remaining / seconds to reset |

v1 also has `GET /rate-limit` for current usage. Webhooks (v1): max 3 subscriptions per instance.

### Pagination

- **v2**: cursor-based. Params `cursor` + `limit` (max 100; default 100 on directory/list-entry
  endpoints, **20** on notes/relationships/field-value endpoints). Response
  `pagination: { prevUrl, nextUrl }` — both full URLs; follow `nextUrl` until `null`. Some
  endpoints accept `totalCount=true` → `pagination.totalCount` (extra cost).
- **v1**: token-based. Params `page_size` (max 500 on most; `/interactions` max 100;
  `/lists/{id}/list-entries` returns **everything** if omitted) + `page_token`. Response carries
  `next_page_token` (null/absent ⇒ done; presence does not guarantee a non-empty next page). All
  other query params must be identical across pages or you get `Invalid page_token variable`.

### Error semantics

Status codes (both versions): 400 (v2), 401 invalid key, 403 insufficient rights, 404, 405 (v2),
422 malformed/logically-impossible params, 429 rate limit, 500, 503.

v2 error body: `{ "errors": [ { "code": "bad-request" | "validation" | "authentication" | "authorization" | "conflict" | …, "message": "…", "param": "limit"? } ] }`
(`param` present on `validation` errors). v1 returns `{error/message}`-style JSON (shape looser —
treat any non-2xx as `{ message?: string }`).

---

## 8. Node/TypeScript clients

- **There is no official Affinity SDK.** Raw REST is the norm; the official docs only show curl.
- Community: [`@planet-a/affinity-node`](https://www.npmjs.com/package/@planet-a/affinity-node)
  (planet-a-ventures/affinity-node, v0.0.4, last publish 2025-11-26) covers v1 + generated v2
  client — pre-1.0, does not target API version `2026-07-15` (UNVERIFIED coverage). Also
  Konfig-generated SDKs and an MCP server (`@alludium/affinity-mcp-server`).
- **Recommendation: write a thin typed fetch wrapper** (below) — the surface we need is small.

### Minimal typed client (no deps, Node 18+)

```ts
// affinity.ts
const BASE = "https://api.affinity.co";
const API_VERSION = "2026-07-15";

export class AffinityError extends Error {
  constructor(
    public status: number,
    public errors: { code: string; message: string; param?: string }[],
  ) {
    super(errors[0]?.message ?? `Affinity API error ${status}`);
  }
}

async function request<T>(
  path: string, // "/v2/..." for v2, "/organizations" etc. for v1
  init: RequestInit = {},
  { retries = 3 }: { retries?: number } = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.AFFINITY_API_KEY}`,
      "Content-Type": "application/json",
      ...(path.startsWith("/v2/") ? { "X-Affinity-Api-Version": API_VERSION } : {}),
      ...init.headers,
    },
  });
  if (res.status === 429 && retries > 0) {
    const reset = Number(res.headers.get("x-ratelimit-limit-user-reset") ?? 5);
    await new Promise((r) => setTimeout(r, Math.min(reset, 60) * 1000));
    return request(path, init, { retries: retries - 1 });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AffinityError(res.status, body.errors ?? [{ code: String(res.status), message: body.message ?? res.statusText }]);
  }
  return res.json() as Promise<T>;
}

// ---------- v2 types ----------
export interface V2Pagination { prevUrl: string | null; nextUrl: string | null; totalCount?: number }
export interface V2Paged<T> { data: T[]; pagination: V2Pagination }

export interface V2Company {
  id: number; name: string; domain: string | null; domains: string[];
  isGlobal: boolean; fields?: V2FieldWithValue[];
}
export interface V2Person {
  id: number; firstName: string; lastName: string | null;
  primaryEmailAddress: string | null; emailAddresses: string[];
  type: "internal" | "external"; fields?: V2FieldWithValue[];
}
export type V2FieldType = "enriched" | "global" | "list" | "relationship-intelligence" | "hidden";
export interface V2FieldWithValue {
  id: string; name: string; type: V2FieldType;
  enrichmentSource: "affinity-data" | "dealroom" | "eventbrite" | "mailchimp" | null;
  value: V2FieldValue;
}
export type V2FieldValue =
  | { type: "text" | "filterable-text"; data: string | null }
  | { type: "filterable-text-multi"; data: string[] | null }
  | { type: "number"; data: number | null }
  | { type: "number-multi"; data: number[] | null }
  | { type: "datetime"; data: string | null }
  | { type: "dropdown"; data: { dropdownOptionId: number; text: string } | null }
  | { type: "dropdown-multi"; data: { dropdownOptionId: number; text: string }[] | null }
  | { type: "ranked-dropdown"; data: { dropdownOptionId: number; text: string; rank: number; color: string | null } | null }
  | { type: "person"; data: V2PersonData | null }
  | { type: "person-multi"; data: V2PersonData[] | null }
  | { type: "company"; data: V2CompanyData | null }
  | { type: "company-multi"; data: V2CompanyData[] | null }
  | { type: "location"; data: V2Location | null }
  | { type: "location-multi"; data: V2Location[] | null }
  | { type: "formula-number"; data: { calculatedValue: number | null } | null }
  | { type: "interaction"; data: V2Interaction | null };
export interface V2PersonData {
  id: number; firstName: string | null; lastName: string | null;
  primaryEmailAddress: string | null; type: "internal" | "collaborator" | "external";
}
export interface V2CompanyData { id: number; name: string; domain: string | null }
export interface V2Location {
  streetAddress: string | null; city: string | null; state: string | null;
  country: string | null; continent: string | null;
}
export type V2Interaction = {
  id: number; type: "meeting" | "email" | "call" | "chat-message";
  // meeting/call: title, allDay, startTime, endTime, attendees[{emailAddress, person?}] …
  // email: subject, sentAt, from/to … — see api-reference for full discriminated shapes
  [k: string]: unknown;
};
export interface V2ListEntry {
  id: number; listId: number; listName?: string; createdAt: string;
  creatorId: number | null; fields: V2FieldWithValue[];
}
export interface V2List {
  id: number; name: string; creatorId: number; ownerId: number;
  isPublic: boolean; type: "company" | "person" | "opportunity"; createdAt: string;
}
export interface V2Note {
  id: number;
  type: "entities" | "interaction" | "ai-notetaker" | "user-reply" | "ai-notetaker-reply";
  content: { html: string | null };
  creator: V2PersonData; mentions: unknown[];
  createdAt: string; updatedAt: string | null;
  interaction?: { id: number; type: "meeting" | "call" | "chat-message" | "email" };
  parent?: { id: number };
}
export interface V2Relationship {
  person1: V2PersonData; person2: V2PersonData;
  interactionScore: number; linkedIn: { connectedOn: string } | null;
}

// ---------- lookups ----------
export async function findCompanyByDomain(domain: string): Promise<V2Company | null> {
  const res = await request<V2Paged<V2Company>>(`/v2/companies/search?limit=10`, {
    method: "POST",
    body: JSON.stringify({ search: { term: domain } }),
  });
  const d = domain.toLowerCase();
  return (
    res.data.find((c) => c.domain?.toLowerCase() === d || c.domains.some((x) => x.toLowerCase() === d)) ?? null
  );
}

// v1 fallback (stable, also searches Affinity's global dataset)
interface V1Org { id: number; name: string; domain: string | null; domains: string[]; global: boolean }
export async function findCompanyByDomainV1(domain: string): Promise<V1Org | null> {
  const res = await request<{ organizations: V1Org[]; next_page_token: string | null }>(
    `/organizations?term=${encodeURIComponent(domain)}`,
  );
  const d = domain.toLowerCase();
  return res.organizations.find((o) => o.domain?.toLowerCase() === d || o.domains.some((x) => x.toLowerCase() === d)) ?? null;
}

export async function findPersonByEmail(email: string): Promise<V2Person | null> {
  const res = await request<V2Paged<V2Person>>(`/v2/persons/search?limit=10`, {
    method: "POST",
    body: JSON.stringify({ search: { term: email } }),
  });
  const e = email.toLowerCase();
  return res.data.find((p) => p.emailAddresses.some((x) => x.toLowerCase() === e)) ?? null;
}

// v1 fallback searches ALL email addresses, not just primary
interface V1Person { id: number; type: number; first_name: string; last_name: string; primary_email: string | null; emails: string[] }
export async function findPersonByEmailV1(email: string): Promise<V1Person | null> {
  const res = await request<{ persons: V1Person[]; next_page_token: string | null }>(
    `/persons?term=${encodeURIComponent(email)}`,
  );
  const e = email.toLowerCase();
  return res.persons.find((p) => p.emails.some((x) => x.toLowerCase() === e)) ?? null;
}

// generic v2 pager: follow pagination.nextUrl until null
export async function* pageV2<T>(firstPath: string, init?: RequestInit): AsyncGenerator<T> {
  let path: string | null = firstPath;
  while (path) {
    const res: V2Paged<T> = await request<V2Paged<T>>(path, init);
    yield* res.data;
    path = res.pagination.nextUrl ? res.pagination.nextUrl.replace(BASE, "") : null;
    init = undefined; // nextUrl already encodes the query; and search POST cursors go via query, body may be re-sent — keep body for POST search!
  }
}

// Example: all list entries for a company (comprehensive field data, incl. Status + Source of introduction)
export async function companyListEntries(companyId: number): Promise<V2ListEntry[]> {
  const out: V2ListEntry[] = [];
  for await (const e of pageV2<V2ListEntry>(`/v2/companies/${companyId}/list-entries?limit=100`)) out.push(e);
  return out;
}

export function fieldValue(entry: { fields: V2FieldWithValue[] }, fieldId: string): V2FieldValue | undefined {
  return entry.fields.find((f) => f.id === fieldId)?.value;
}
// e.g. status text on a deal row:
//   const v = fieldValue(entry, "field-1625");
//   const status = v?.type === "ranked-dropdown" ? v.data?.text : undefined;
// e.g. source of introduction (relationship intelligence):
//   const src = fieldValue(entry, "source-of-introduction");

export const getCompanyNotes = (companyId: number) =>
  request<V2Paged<V2Note>>(`/v2/companies/${companyId}/notes?limit=100`);

export const getCompanyRelationships = (companyId: number, minScore = 0) =>
  request<V2Paged<V2Relationship>>(
    `/v2/companies/${companyId}/relationships?limit=100&filter=${encodeURIComponent(`interactionScore>=${minScore}`)}`,
  );

// First/last interaction dates for a company via relationship-intelligence fields
export const getCompanyWithInteractions = (companyId: number) =>
  request<V2Company>(`/v2/companies/${companyId}?fieldTypes=relationship-intelligence`);
```

Caveat on `pageV2` + POST search endpoints: for `POST /v2/*/search` the cursor arrives in
`pagination.nextUrl` as a query param; keep re-sending the same body with each `POST` to the
nextUrl path (UNVERIFIED whether the body may be omitted once a cursor is supplied — safest is to
resend it unchanged, mirroring v1's "identical params" rule).

---

## 9. Quick decision table for our PRD

| Need | Use | Fallback |
|---|---|---|
| Org by domain | `POST /v2/companies/search` (BETA) | `GET /organizations?term=` (v1, stable) |
| Person by email | `POST /v2/persons/search` (BETA; primary-email match) | `GET /persons?term=` (v1; matches all emails) |
| Org's lists / rows | `GET /v2/companies/{id}/lists`, `/list-entries` | v1 `GET /organizations/{id}` → `list_entries` |
| Status column & custom list fields | `GET /v2/lists/{listId}/fields` + `GET /v2/lists/{listId}/list-entries?fieldIds=…` or per-row `…/list-entries/{id}/fields` | v1 `GET /lists/{id}` + `GET /field-values?list_entry_id=` |
| "Source of introduction" | v2 `fieldIds=source-of-introduction` (relationship-intelligence) | none documented in v1 |
| Notes for org/person | `GET /v2/companies/{id}/notes`, `GET /v2/persons/{id}/notes` | v1 `GET /notes?organization_id=` |
| First/last interaction dates | v2 `fieldTypes=relationship-intelligence` on company/person | v1 `with_interaction_dates=true` |
| Relationship strength | v2 `GET /v2/companies/{id}/relationships` (`interactionScore`) | v1 `GET /relationships-strengths?external_id=` |
| Auth check | `GET /v2/auth/whoami` | v1 `GET /whoami` |
