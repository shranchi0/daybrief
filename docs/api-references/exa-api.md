# Exa API Reference (verified against live docs, August 2026)

Sources: `https://exa.ai/docs/llms.txt` index, `https://exa.ai/docs/exa-spec.yaml` (OpenAPI),
`exa.ai/docs/sdks/typescript-sdk-specification.md`, `exa.ai/docs/reference/*` pages,
`exa.ai/docs/changelog.md`, and the shipped type declarations of `exa-js@2.16.3` (npm, published 2026-07-27).
Anything not confirmed by those sources is marked **UNVERIFIED**.

---

## 0. Basics

- **Base URL:** `https://api.exa.ai`
- **Auth:** either header works (both appear in official docs):
  - `x-api-key: $EXA_API_KEY`
  - `Authorization: Bearer $EXA_API_KEY`
  (The OpenAI-compat endpoints `/chat/completions` and `/responses` use `Authorization: Bearer`.)
- **Content type:** `Content-Type: application/json`, all core endpoints are `POST`.
- **Key endpoints:** `POST /search`, `POST /contents`, `POST /answer`, `POST /findSimilar` (deprecated),
  `POST /context` (code search), `POST /agent/runs` (Agent API), `POST /monitors`, `/websets/v0/...` (Websets).
- **`POST /research` was REMOVED in April 2026** — replaced by `/search` with `type: "deep-reasoning"`.
- Free tier: new accounts get $20 credits; free tier adds $10/month.

---

## 1. exa-js SDK

- **Package:** `exa-js`, current latest **2.16.3** (2026-07-27). dist-tags: `latest: 2.16.3`, `legacy-v1: 1.10.3`, `beta: 2.5.1-beta.3`. v2 had breaking changes vs v1 (see gotchas).
- **Install:** `npm install exa-js`
- **Init:**

```ts
import Exa from "exa-js";

const exa = new Exa();                 // reads EXA_API_KEY from env
// or: const exa = new Exa("your-api-key");
// constructor(apiKey?: string, baseURL?: string)
```

- **Current methods on the client** (from shipped `dist/index.d.ts` of 2.16.3):
  - `exa.search(query, options?)` — primary method
  - `exa.streamSearch(query, options?)` — SSE streaming for synthesized output
  - `exa.getContents(urls, options?)` — urls: `string | string[] | SearchResult[]`
  - `exa.answer(query, options?)` / `exa.streamAnswer(query, options?)`
  - `exa.searchAndContents(query, options?)` — legacy compatibility wrapper (top-level contents options); still works, docs treat plain `search` + nested `contents` as canonical
  - `exa.findSimilar(url, options?)` / `exa.findSimilarAndContents(url, options?)` — **marked `@deprecated` in the SDK** ("will be removed in a future version"), still functional
  - Sub-clients: `exa.websets` (WebsetsClient), `exa.monitors` (SearchMonitorsClient), `exa.agent` (AgentClient: `exa.agent.runs.create/get/list/pollUntilFinished`), `exa.beta`, `exa.research` (legacy ResearchClient — the underlying `/research` endpoint was removed April 2026; do not use)
  - Escape hatches: `exa.request<T>(endpoint, method, body?, params?, headers?)`, `exa.rawRequest(...)`
- **Errors:** SDK throws `ExaError extends Error` with `statusCode: number`, `timestamp?: string`, `path?: string`.
- **Casing:** TypeScript SDK uses camelCase everywhere, matching the raw HTTP JSON shape.

**IMPORTANT SDK default:** `exa.search(query)` with no `contents` option returns **full text contents by default** (`text: { maxCharacters: 10000 }`). Pass `contents: false` to opt out (faster/cheaper), or `contents: { highlights: true }` for token-efficient excerpts (recommended default for agent workflows).

```ts
// canonical usage
const res = await exa.search("hottest AI startups", {
  type: "auto",
  numResults: 10,
  contents: { highlights: true },
});
// res.results[], res.requestId, res.costDollars, res.statuses
```

---

## 2. POST /search

Request shape (camelCase JSON):

```json
{
  "query": "latest developments in LLMs",        // required
  "type": "auto",                                 // "auto" (default) | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning"
  "numResults": 10,                               // 1-100 (public max 100; some plans lower)
  "category": "company",                          // see categories below
  "includeDomains": ["nasa.gov", "exa.ai/blog", "*.substack.com"],  // max 1200 entries; hostnames, path prefixes, wildcard subdomains
  "excludeDomains": ["docs.python.org/3"],
  "startPublishedDate": "2025-01-01T00:00:00.000Z",  // ISO 8601
  "endPublishedDate": "2025-12-31T00:00:00.000Z",
  "userLocation": "US",                           // 2-letter ISO country code
  "moderation": false,
  "additionalQueries": ["..."],                   // deep-* types only, max 10 (SDK doc says max 5) — else 400 INVALID_REQUEST
  "systemPrompt": "Prefer official sources.",     // guides synthesized output
  "outputSchema": { "type": "object", "properties": { "...": {} }, "required": [] },  // enables synthesized output.content
  "stream": false,                                // SSE; only used when outputSchema is provided
  "contents": {                                   // ALL content extraction is NESTED here on /search
    "text": true,                                 // or { "maxCharacters": 1..10000, "includeHtmlTags": bool, "verbosity": "compact"|"standard"|"full", "includeSections": [...], "excludeSections": [...] }
    "highlights": true,                           // or { "query": "...", "maxCharacters": 1..10000 }
    "summary": { "query": "...", "schema": { } }, // per-result LLM call — costs extra
    "maxAgeHours": 24,                            // -1 cache-only, 0 always live-crawl, max 720; replaces deprecated `livecrawl`
    "livecrawlTimeout": 10000,                    // ms, max 90000, default 10000
    "subpages": 0,                                // 0-100
    "subpageTarget": "sources",                   // string or string[]
    "extras": { "links": 0, "imageLinks": 0 }     // 0-1000 each (spec also lists richLinks, richImageLinks, codeBlocks)
  }
}
```

**Search types (2026):** `auto` (default, balanced), `fast` (p50 < 425ms), `instant` (sub-150ms, real-time apps), `deep-lite` (~4s, light synthesis), `deep` (4–15s multi-step), `deep-reasoning` (12–40s hardest research). The API validation error message enumerates exactly: `'auto' | 'fast' | 'instant' | 'deep-lite' | 'deep' | 'deep-reasoning'`. **`neural` and `keyword` are no longer documented request types**; the shipped exa-js type union still contains `"keyword" | "neural" | "hybrid"` for back-compat — whether the server still accepts them is UNVERIFIED; do not use in new code.

**Categories (enum in OpenAPI spec):** `company`, `publication`, `news`, `personal site`, `financial report`, `people`. Other strings are accepted as soft "hints" but stick to the documented set. History: `people` replaced `linkedin` (Dec 2025); `publication` replaced `research paper` (July 2026); `pdf`, `github`, `tweet` deprecated (July 2026). Never invent categories like `github`/`documentation`/`qa`/`pdf`.

**Category filter restrictions (400 error if violated):** for `category: "people"` and `category: "company"`, the following are NOT supported: `startPublishedDate`, `endPublishedDate`, `excludeDomains` (per OpenAPI spec). Crawl-date params are ignored globally. For `people` specifically, the coding-agent reference says `includeDomains` is also unavailable, while the build-with-exa skill doc says `includeDomains` for people "only accepts LinkedIn domains" — conflicting docs; safest: **use no domain filters with `people` and encode all constraints in the natural-language query**. `company` does support `excludeDomains` per the skill doc (conflicts with spec; treat as UNVERIFIED).

Response (200):

```json
{
  "requestId": "b5947044c4b78efa9552a7c89b306d95",
  "results": [
    {
      "title": "...",                       // string | null
      "url": "https://...",
      "id": "https://...",                  // temporary doc ID, usable with /contents
      "publishedDate": "2023-11-16T01:36:32.547Z",
      "author": "..." ,                     // string | null
      "image": "https://.../img.png",       // optional
      "favicon": "https://.../favicon.ico", // optional
      "text": "...",                        // if contents.text requested (or SDK default)
      "highlights": ["..."],                // if requested
      "highlightScores": [0.46],            // deprecated (removed from responses May 2026 per changelog; still in some doc examples)
      "summary": "...",                     // if requested
      "subpages": [ { "title": "...", "url": "...", "id": "..." } ],
      "entities": [ /* typed company/person/publication entities, see People section */ ]
    }
  ],
  "output": {                                // ONLY when outputSchema provided
    "content": "string OR object matching outputSchema",
    "grounding": [
      { "field": "companies[0].funding", "citations": [{ "url": "...", "title": "..." }], "confidence": "low|medium|high" }
    ]
  },
  "statuses": [ { "id": "https://...", "status": "success" } ],
  "costDollars": { "total": 0.007, "search": { "neural": 0.007 } },
  "searchTime": 1234                          // ms (SDK-documented field)
}
```

- `resolvedSearchType` and `context` still appear in responses but are **deprecated** (`resolvedSearchType` may be an empty string; do not branch on it).
- `score` is not returned by `auto` search (deprecated July 2025).
- Streaming (`stream: true` + `outputSchema`): `text/event-stream` with chunk types `text-delta`, `grounding`, `results`, `stream-reset`, `done`, `error`.

---

## 3. POST /contents

Content fields are **TOP-LEVEL** here (the #1 shape confusion vs `/search`):

```json
{
  "urls": ["https://arxiv.org/abs/2307.06435"],   // 1-100 URLs (or "ids": [...] — provide one, not both)
  "text": true,                                    // or object as in /search contents.text
  "highlights": { "query": "methodology", "maxCharacters": 2000 },
  "summary": { "query": "...", "schema": { } },
  "maxAgeHours": 24,
  "livecrawlTimeout": 10000,
  "subpages": 1,
  "subpageTarget": "about",
  "extras": { "links": 5, "imageLinks": 1 }
}
```

Response (200 — note: **HTTP 200 even when individual URLs fail**; always check `statuses`):

```json
{
  "requestId": "...",
  "results": [ { "id": "...", "url": "...", "title": "...", "text": "...", "...": "same result shape as /search" } ],
  "statuses": [
    { "id": "https://example.com", "status": "success", "source": "cached" },   // source: "cached" | "crawled"
    { "id": "https://bad.example", "status": "error",
      "error": { "tag": "CRAWL_NOT_FOUND", "httpStatusCode": 404 } }
  ],
  "costDollars": { "total": 0.001 }
}
```

Per-URL error tags: `CRAWL_NOT_FOUND` (404), `CRAWL_TIMEOUT` (504), `CRAWL_LIVECRAWL_TIMEOUT` (504), `SOURCE_NOT_AVAILABLE` (403), `UNSUPPORTED_URL`, `CRAWL_UNKNOWN_ERROR` (500+).
Notes:
- `/contents` does NOT support `stream: true`.
- `livecrawl` string param (`never|always|fallback|preferred`) is **deprecated** — use `maxAgeHours` (omitted = cache with crawl fallback; `0` = always live crawl; `-1` = cache only; positive = max cache age in hours). Never send both.
- Billing: $1/1k pages **per content type** — one page with `text` + `highlights` bills as two.

```ts
const result = await exa.getContents(["https://example.com/a"], {
  text: { maxCharacters: 1000 },
  highlights: { query: "AI" },
  maxAgeHours: 168,
});
```

---

## 4. POST /findSimilar  (DEPRECATED — works, but plan migration)

The OpenAPI spec marks the endpoint `deprecated: true`, `x-exa-lifecycle: deprecated`:
"Find links similar to the provided URL... **Deprecated: prefer `/search` with a query describing the source.**"
The exa-js `findSimilar`/`findSimilarAndContents` methods carry `@deprecated` JSDoc ("will be removed in a future version. There is no direct replacement for URL-based similarity."). It is absent from the current TS SDK spec docs page. It still ships and still serves requests as of Aug 2026.

Request:

```json
{
  "url": "https://acme-competitor.com",     // required, the source homepage
  "excludeSourceDomain": true,              // boolean — drop results from the source URL's own domain
  "category": "company",                    // same enum as /search; company/people filter restrictions apply
  "numResults": 10,                         // 1-100
  "includeDomains": [...], "excludeDomains": [...],
  "startPublishedDate": "...", "endPublishedDate": "...",
  "contents": { "text": true }              // nested, same ContentsOptions as /search
}
```

Response: `{ "requestId": "...", "results": [ SearchResult... ], "costDollars": {...} }` — same result object as `/search` (no `output`, no `statuses` in FindSimilarResponse schema).

```ts
// still-working SDK call (typed deprecated):
const similar = await exa.findSimilar("https://acme.com", {
  excludeSourceDomain: true,
  category: "company",
  numResults: 10,
  contents: { highlights: true },   // or contents: false to skip contents
});
```

**Recommended 2026 pattern for competitor discovery from a company homepage** (what Exa docs now push): describe the company and search the `company` category instead, e.g.

```ts
const competitors = await exa.search(
  "companies similar to Acme — cloud cost optimization platform for enterprises",
  { category: "company", type: "auto", numResults: 10, contents: { highlights: true } },
);
// then filter out results whose url hostname matches the source domain yourself
```

---

## 5. POST /answer

Request:

```json
{
  "query": "What is the latest valuation of SpaceX?",  // required
  "text": false,          // include full text of each citation
  "stream": false,        // SSE stream when true
  "outputSchema": { "type": "object", "properties": {...}, "required": [...] },  // JSON Schema draft-07 → answer becomes object
  "systemPrompt": "...",  // (documented in skill/SDK docs)
  "userLocation": "US"
}
```

Response (200):

```json
{
  "requestId": "...",
  "answer": "$350 billion.",          // string, or object when outputSchema given
  "citations": [
    { "id": "https://...", "url": "https://...", "title": "...",
      "publishedDate": "2024-12-11", "author": "...", "text": "only when text:true",
      "image": "...", "favicon": "..." }
  ],
  "costDollars": { "total": 0.005 }
}
```

- Model param: SDK `AnswerOptions.model` accepts only `"exa"` (default).
- Special status: **501 `UNABLE_TO_GENERATE_RESPONSE`** when the model can't answer from available info; 403 `PROHIBITED_CONTENT` for moderation blocks.
- Streaming: SSE `data: <json>` chunks; SDK: `for await (const chunk of exa.streamAnswer(q, { text: true })) { chunk.content?, chunk.citations? }`.
- Pricing: $5 / 1k requests.

```ts
const r = await exa.answer("What is the capital of France?", { text: true });
```

---

## 6. Finding a person's LinkedIn profile (2026 recommended pattern)

What the docs actually recommend now:

1. **Use `POST /search` with `category: "people"`** (this replaced the old `linkedin` category in Dec 2025). Index: 1B+ public profiles aggregated from LinkedIn, company pages, and other sources; refreshed weekly.
2. **Put everything in the natural-language query** — name, role, company, location, seniority. Date/text/domain filters are unsupported for `people` (400 errors); "Natural language is the only filter."
3. Result rows that resolve to a person typically have a **LinkedIn profile URL in `results[].url`** (docs example: `"url": "https://www.linkedin.com/in/janedoe"`) plus **typed metadata in `results[].entities[]`**:

```json
{
  "id": "person_...", "type": "person", "version": 1,
  "properties": {
    "name": "Jane Doe", "firstName": "Jane", "lastName": "Doe",
    "location": "San Francisco, California, United States",
    "workHistory": [ { "title": "VP Engineering", "location": "...",
        "dates": { "from": "2022-01-01", "to": null },        // to:null usually = current role
        "company": { "id": "company_...", "name": "Example AI" } } ],
    "educationHistory": [ { "degree": "BS Computer Science", "dates": {"from":"2010","to":"2014"},
        "institution": { "id": null, "name": "Stanford University" } } ]
  }
}
```

Code-ready lookup:

```ts
const res = await exa.search(
  "Jane Doe, VP Engineering at Example AI, San Francisco",   // name + role + company disambiguates best
  { category: "people", type: "auto", numResults: 5, contents: { highlights: true } },
);
const linkedin = res.results.find(r => /linkedin\.com\/in\//.test(r.url))?.url;
// verify identity via results[].entities[0].properties (name + workHistory company match)
```

Docs' gotcha list for people search:
- **Always set `category: "people"`** — without it you hit the general web index and get no structured person entities.
- Use `highlights` (not `text`) to keep dense profiles token-efficient.
- Verify with `entities[].properties` rather than parsing titles.
- For custom fields beyond the entity schema, use `type: "deep"` + `outputSchema`.
- For bulk/verified people lists, docs point to **Websets**; for one-shot "find this person's LinkedIn" with guaranteed structured output, the **Agent API** examples use `outputSchema` with a `linkedin_url` field (`{ "type": "string", "format": "uri" }`).

---

## 7. Cost reporting & rate limits

**Cost reporting:** all core endpoints return `costDollars` in the response:

```json
"costDollars": { "total": 0.007, "search": { "neural": 0.007 } }
```

- Schema (`CostDollarsOutput`): `total` (float, estimated dollar cost) plus endpoint-dependent breakdown; only non-zero components included. Instant/fast/auto responses may include `search.neural`; deep modes may reflect only in `total`. The SDK type also declares a `contents` breakdown (`CostDollarsContents`). Docs warn: "Billing is computed from usage counters rather than this response object" — treat as an estimate, not an invoice.
- Pricing (Aug 2026): `/search` $7/1k requests (first 10 results incl. text+highlights free), +$1/1k extra results, summaries $1/1k pages; deep-lite & deep $12/1k; deep-reasoning $15/1k; `/contents` $1/1k pages per content type; `/answer` $5/1k; `/monitors` $15/1k; Agent: fixed effort $0.012 (minimal) – $1.00 (xhigh) per run, or `auto` metered ($0.10/ACU, $0.005/search, $0.02/email, $0.07/phone, cap $5/run).

**Rate limits (default, non-enterprise):**

| Endpoint | Limit |
|---|---|
| `/search` | 10 QPS |
| `/contents` | 100 QPS |
| `/answer` | 10 QPS |

429 responses use a simple `{ "error": "..." }` body (no tag). Agent concurrency = QPS/5 (default 2 concurrent runs). Higher limits: sales@exa.ai.

**Error semantics:** non-429 errors return `{ "requestId", "error", "tag" }`. Key tags: `INVALID_API_KEY` (401), `NO_MORE_CREDITS`/`API_KEY_BUDGET_EXCEEDED`/`TEAM_BUDGET_EXCEEDED` (402), `FEATURE_DISABLED`/`ACCESS_DENIED`/`ROBOTS_FILTER_FAILED`/`PROHIBITED_CONTENT`/`CONTENT_FILTER_ERROR` (403), `INVALID_REQUEST_BODY`/`INVALID_REQUEST`/`INVALID_URLS`/`INVALID_NUM_RESULTS`/`NUM_RESULTS_EXCEEDED`/`INVALID_JSON_SCHEMA` (400), `FETCH_DOCUMENT_ERROR` (422), `UNABLE_TO_GENERATE_RESPONSE` (501), `DEFAULT_ERROR`/`INTERNAL_ERROR` (500). Retry 5xx with backoff; back off exponentially on 429.

---

## 8. Websets (future use)

Websets (`POST https://api.exa.ai/websets/v0/websets`, SDK `exa.websets.*`) is Exa's asynchronous list-building product: you give it a natural-language query ("agtech companies in the US that raised Series A"), an item `count`, optional verification `criteria`, and `enrichments` (typed data points to extract per item — e.g. "LinkedIn profile of VP of Engineering", format `text`/`number`/`date`/`boolean`/`email`/etc.), and it searches, verifies each candidate against the criteria, and enriches every match, delivering structured items over time via polling (`GET /v0/websets/{id}`, `/items`), webhooks, or the dashboard. It also supports imports (bring your own CSV/URLs), monitors (keep a webset fresh on a schedule), and previews (`POST /v0/websets/preview` shows how a query decomposes into entity type + criteria before you commit). Use it instead of `/search` when you need verified, enriched lists across many entities rather than a single ranked result page.

## 9. Agent API — the successor to /research (future use)

The old `/research` endpoint was removed in April 2026; its niche is now split between `/search` `type: "deep-reasoning"` (synchronous, structured output + grounding) and the **Agent API** (June 2026): `POST /agent/runs` creates an async multi-step research/list-building/enrichment run with `query`, `effort` (`minimal|low|medium|high|xhigh|auto`), `outputSchema` (draft-07/2019-09/2020-12; `format: "email"`/`"phone"` triggers contact enrichment), optional `input.data` (build on an existing dataset), `previousRunId` (follow-ups), and `dataSources` (Exa Connect premium partners like Similarweb, Fiber.ai — Fiber notably covers B2B people/LinkedIn data). Runs go `queued → running → completed|failed|cancelled` (1-hour timeout), are polled via `GET /agent/runs/{id}` (or SSE via `Accept: text/event-stream`, replay via `/agent/runs/{id}/events`), and return `output.text`, `output.structured`, `output.grounding` plus `usage.agentComputeUnits`; unsupported fields come back `null` rather than hallucinated. SDK: `exa.agent.runs.create(...)`, `.get(...)`, `.list(...)`, `.pollUntilFinished(...)`.

---

## 10. Deprecations & migration cheat-sheet (things that changed recently)

| Old (pre-2026 assumption) | Current (Aug 2026) |
|---|---|
| `type: "neural" \| "keyword"` | Documented types: `auto`, `fast`, `instant`, `deep-lite`, `deep`, `deep-reasoning`. neural/keyword only linger in SDK types (UNVERIFIED server acceptance) |
| `category: "linkedin"` / `"linkedin profile"` | `category: "people"` (Dec 2025) |
| `category: "research paper"` | `category: "publication"` (July 2026) |
| `category: "pdf" / "github" / "tweet"` | Deprecated (July 2026) |
| `/research` endpoint | Removed Apr 2026 → `/search` `type: "deep-reasoning"` or Agent API |
| `/findSimilar` + SDK `findSimilar()` | Deprecated, still works; prefer `/search` with a descriptive query |
| `livecrawl: "always"/"fallback"/...` | `maxAgeHours` (`0`=always crawl, `-1`=cache only) + `livecrawlTimeout` |
| `useAutoprompt` | Deprecated/ignored |
| highlights `numSentences`, `highlightsPerUrl` | Deprecated → `highlights: true` or `{ query, maxCharacters }` |
| `resolvedSearchType`, `highlightScores`, result `score` (auto), `context` | Deprecated/removed from responses (Apr–May 2026); don't branch on them |
| `startCrawlDate` / `endCrawlDate` | Accepted but silently ignored |
| top-level `text`/`highlights` on `/search` | Must be nested under `contents` (top-level is the `/contents` shape) |
| `exa.searchAndContents()` as canonical | Compatibility wrapper; canonical is `search(query, { contents: {...} })` |
