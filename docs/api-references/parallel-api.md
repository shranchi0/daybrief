# Parallel API Reference (verified August 5, 2026)

Sources: `https://docs.parallel.ai/llms-full.txt` (fetched live 2026-08-05), `https://docs.parallel.ai/public-openapi.json` (fetched live), TypeScript SDK repo `parallel-web/parallel-sdk-typescript` (README + src). Anything not confirmed from these is marked **UNVERIFIED**.

---

## 0. Basics

- **Base URL:** `https://api.parallel.ai`
- **Auth:** header `x-api-key: $PARALLEL_API_KEY` on every request (OpenAPI securityScheme: apiKey in header named `x-api-key`). Get keys at https://platform.parallel.ai
- **Beta features:** opt-in via header `parallel-beta: <flag>[,<flag>]`. Known flags (OpenAPI `ParallelBeta` enum): `mcp-server-2025-07-17`, `events-sse-2025-07-24`, `webhook-2025-08-12`, `findall-2025-09-15`, `search-extract-2025-10-10`, `field-basis-2025-11-25`.
- **Content type:** `application/json`.
- **Docs as markdown:** append `.md` to any docs URL, or send `Accept: text/markdown`.

### Rate limits (defaults)
| Product | Quota | Counted request |
|---|---|---|
| Search | 600/min | POST `/v1/search` |
| Extract | 600/min | POST `/v1/extract` |
| Tasks/TaskGroups | 2,000/min | POST `/v1/tasks/runs` or POST `/v1/tasks/groups/{taskgroup_id}/runs` |
| Chat | 300/min | POST `/v1beta/chat/completions` |

GET requests (polling status/results) do NOT count against rate limits. On exceeding: `429`.

### HTTP error semantics
| Status | Meaning | Retry? |
|---|---|---|
| 401 | Bad/missing API key | No |
| 402 | Insufficient credit (note: in-flight credit reservations can trigger this even with positive balance) | No |
| 403 | Invalid processor / permissions | No |
| 404 | Run/resource not found | No |
| 408 | Synchronous request timed out (e.g. blocking result timeout) | Yes — poll again |
| 422 | Validation failed (detail explains which fields) | No |
| 429 | Rate limited | Yes, backoff |
| 500/502/503 | Server-side | Yes, backoff |

Error body format: `{"error": {"message": "...", "detail": {...}}}`. The `Error` object attached to a failed run is `{ref_id, message, detail?}`.

Billing note: only successfully **completed** task runs are billed; failed runs are free.

---

## 1. Task API — creating a task run

### Endpoint
```
POST https://api.parallel.ai/v1/tasks/runs
x-api-key: $PARALLEL_API_KEY
Content-Type: application/json
```

### Request body (`TaskRunInput`, from OpenAPI)
Required: `processor`, `input`.

| Field | Type | Notes |
|---|---|---|
| `input` | string \| JSON object | Text or structured input. e.g. `"What was the GDP of France in 2023?"` or `{"country":"France","year":2023}` |
| `processor` | string | See processor table below. e.g. `"core"`, `"core-fast"` |
| `task_spec` | TaskSpec \| null | If omitted, defaults to `auto` output schema |
| `metadata` | object \| null | String/number/bool values. Keys ≤16 chars, values ≤512 chars |
| `webhook` | `{url: string, event_types: ["task_run.status"]}` \| null | Completion callback (see §2.3). Note from OpenAPI: "not available via the Python SDK" (TS SDK supports it) |
| `enable_events` | bool \| null | Enables SSE progress events. Default `true` for `pro` and above |
| `previous_interaction_id` | string \| null | Chain context from a prior run (`interaction_id` from its response). Not available for ZDR customers |
| `source_policy` | `{include_domains?: string[], exclude_domains?: string[], after_date?: "YYYY-MM-DD"}` \| null | ≤200 domains combined; accepts `example.com` or `.gov`-style extensions |
| `advanced_settings` | `{location?: string}` \| null | ISO 3166-1 alpha-2 country code |
| `mcp_servers` | McpServer[] \| null | Beta (`mcp-server-2025-07-17`): private-data tool calls during the run |

`task_spec` = `{ "output_schema": <schema|string>, "input_schema"?: <schema|string> }`.
Schema forms:
- **JSON schema**: `{"type": "json", "json_schema": { ...JSON Schema object... }}` (`type` defaults to `"json"` if omitted)
- **Text schema**: `{"type": "text", "description"?: "..."}` → markdown/text output with inline citations
- **Auto**: `{"type": "auto"}` or omit `task_spec` entirely → processor picks structure. Deep-Research-style auto output only on `pro` and above.
- **Bare string** for either schema = text schema with that string as the description.

### Example (cURL)
```bash
curl -s https://api.parallel.ai/v1/tasks/runs \
  -H "x-api-key: $PARALLEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {"company_name": "Stripe", "website": "stripe.com"},
    "processor": "core",
    "task_spec": {
      "output_schema": {
        "type": "json",
        "json_schema": {
          "type": "object",
          "properties": {
            "founding_year": {"type": "string", "description": "Year founded, YYYY. If unavailable, return null."},
            "total_funding": {"type": "string", "description": "Total funding raised in USD, e.g. \"$8.7B\". If unknown, return \"Unknown\"."}
          },
          "required": ["founding_year", "total_funding"],
          "additionalProperties": false
        }
      }
    },
    "metadata": {"my_ref": "row-42"}
  }'
```

### Response — `TaskRun` object (returned by create AND by GET status)
```json
{
  "run_id": "trun_e0083b6aac0544eb8686e8d2a76533d2",
  "interaction_id": "trun_e0083b6aac0544eb8686e8d2a76533d2",
  "status": "queued",
  "is_active": true,
  "warnings": null,
  "error": null,
  "processor": "core",
  "metadata": {"my_ref": "row-42"},
  "taskgroup_id": null,
  "created_at": "2025-08-06T00:52:58.619503Z",
  "modified_at": "2025-08-06T00:52:59.495063Z"
}
```
- `status` enum (OpenAPI): `queued | action_required | running | completed | failed | cancelling | cancelled`
- `is_active` = status in `{queued, running, cancelling}`
- `error` present only when `status == "failed"`; shape `{ref_id, message, detail?}`
- `warnings`: array of `{type: "spec_validation_warning"|"input_validation_warning"|"warning", message, detail?}`

CAUTION: the docs page "Task Runs Lifecycle" shows an older response example with `result`, `result_url`, `errors` (plural) fields and only 4 states — that example is stale; the OpenAPI `TaskRun` schema above is authoritative. There is no documented cancel endpoint for task runs in the public OpenAPI spec (the `cancelling`/`cancelled` states exist in the enum; how to trigger cancellation is **UNVERIFIED**).

### Processors (current tier names)
Standard tiers, cost per 1,000 runs (per run = /1000). Fast variants (`-fast` suffix) cost the same as standard, run 2–5x faster, and trade peak data freshness for speed.

| Processor | $/1000 runs | Latency (standard) | Latency (fast) | Strengths / max fields |
|---|---|---|---|---|
| `lite` / `lite-fast` | $5 | 10s–60s | 10s–20s | Basic metadata, ~2 fields |
| `base` / `base-fast` | $10 | 15s–100s | 15s–50s | Standard enrichments, ~5 fields |
| `core` / `core-fast` | $25 | 60s–5min | 15s–100s | Cross-referenced outputs, ~10 fields |
| `core2x` / `core2x-fast` | $50 | 60s–10min | 15s–3min | High-complexity cross-referenced, ~10 fields |
| `pro` / `pro-fast` | $100 | 2min–10min | 30s–5min | Exploratory web research, ~20 fields |
| `ultra` / `ultra-fast` | $300 | 5min–25min | 1min–10min | Deep research, ~20 fields |
| `ultra2x` / `ultra2x-fast` | $600 | 5min–50min | 1min–20min | Difficult deep research, ~25 fields |
| `ultra4x` / `ultra4x-fast` | $1200 | 5min–90min | 1min–40min | Very difficult deep research, ~25 fields |
| `ultra8x` / `ultra8x-fast` | $2400 | 5min–2hr | 1min–1hr | Hardest deep research, ~25 fields |

Pricing is per run (row), not per output field. Standard = prioritizes live-data freshness; fast = prioritizes latency.

---

## 2. Retrieving results

### 2.1 Poll status (non-blocking)
```
GET /v1/tasks/runs/{run_id}          → TaskRun (status object, shape above)
GET /v1/tasks/runs/{run_id}/input    → the original run input
```
Poll `status` until `completed` / `failed`. GETs don't consume rate limit.

### 2.2 Blocking result endpoint
```
GET /v1/tasks/runs/{run_id}/result?timeout=600
```
- Blocks until the run is `completed`, up to `timeout` seconds (query param, **default 600**). On expiry returns 408 — just call again.
- Response — `TaskRunResult`:
```json
{
  "run": { ...TaskRun with status "completed"... },
  "output": {
    "type": "json",              // or "text"
    "content": { ... },           // native JSON object for type=json; string for type=text
    "basis": [ ...FieldBasis... ],
    "mcp_tool_calls": null,
    "output_schema": null         // populated only for auto-schema runs (json output)
  }
}
```
- `TaskRunJsonOutput.content` is a **native JSON object** per OpenAPI ("Output from the task as a native JSON object"). Note: one docs example shows `content` as a JSON-encoded string — treat the OpenAPI native-object shape as authoritative for `/v1`; defensively `typeof content === "string" ? JSON.parse(content) : content` costs nothing.
- `TaskRunTextOutput.content` is a string (markdown with inline citations); its `basis` has a single entry with `field: "output"`.

### 2.3 Webhooks
Register at run creation via the `webhook` field (see §1). Only event type: `task_run.status` — fires when the run completes (success or failure).

**Payload:**
```json
{
  "timestamp": "2025-04-23T20:21:48.037943Z",
  "type": "task_run.status",
  "data": {
    "run_id": "trun_9907962f83aa4d9d98fd7f4bf745d654",
    "status": "completed",            // or "failed"
    "is_active": false,
    "warnings": null,
    "error": null,                     // {message, details} on failure
    "processor": "core",
    "metadata": {"key": "value"},
    "created_at": "...", "modified_at": "..."
  }
}
```
`data` is the full TaskRun object — **the webhook does NOT contain the output**. On receipt, call `GET /v1/tasks/runs/{run_id}/result`.

**Verification (Standard Webhooks / Svix style):** request headers `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature` (`v1,<base64sig>`, space-delimited if multiple). Signature = HMAC-SHA256 over `` `${webhookId}.${webhookTimestamp}.${rawBody}` ``, key = Base64-decode of your webhook secret after stripping the `whsec_` prefix; output standard Base64 with padding. Secret at Platform → Settings → Webhooks. Use timing-safe compare; any Standard-Webhooks/Svix library works.

Retry policy: documented on the webhook-setup page (retries exist; exact schedule **UNVERIFIED** — not captured here).

### 2.4 SSE (per-run event stream)
```
GET /v1/tasks/runs/{run_id}/events
Accept: text/event-stream
x-api-key: ...
```
(A `/v1beta/tasks/runs/{run_id}/events` variant also exists in the OpenAPI spec; `/v1` is the documented path.)

- Enable with `"enable_events": true` at creation (default on for `pro`+).
- Stream stays open max **570 seconds**; not resumable (no cursors). Reconnecting replays the full reasoning trace + latest stats.
- Event types (SSE `event:` field = `type` in data):
  - `task_run.state` — first event of every stream and on transition to non-active status. Data: `{type, event_id, input, run: TaskRun, output}`; for completed runs the final `task_run.state` includes the full `output` (so you can skip the result endpoint).
  - `task_run.progress_msg.plan | .tool | .result | .exec_status | .search` — reasoning trace messages `{type, message, timestamp}`. `.search` messages are prefixed `Objective:` or `Query:`. `.plan`/`.tool` may be limited on `lite`; search events emitted on `base`+.
  - `task_run.progress_stats` — `{type, source_stats: {num_sources_considered, num_sources_read, sources_read_sample: [urls]}}` (current state only).
  - `error` — errors during execution.

---

## 3. Task Groups (batching)

Endpoints:
```
POST /v1/tasks/groups                                  # create group; body {"metadata"?: {...}} ({} ok)
POST /v1/tasks/groups/{taskgroup_id}/runs              # add up to 1,000 runs per request; ?refresh_status=false for fast bulk adds
GET  /v1/tasks/groups/{taskgroup_id}                   # aggregated status snapshot
GET  /v1/tasks/groups/{taskgroup_id}/runs              # SSE snapshot of runs; ?last_event_id=&status=&include_input=&include_output=
GET  /v1/tasks/groups/{taskgroup_id}/runs/{run_id}     # single run status
GET  /v1/tasks/groups/{taskgroup_id}/events            # live SSE: group status + run completions; ?last_event_id=&timeout=
GET  /v1/tasks/runs/{run_id}/result                    # fetch individual results as runs complete
```

Lifecycle:
1. Create group → response `TaskGroupResponse`: `{taskgroup_id, metadata, status: TaskGroupStatus, created_at}`.
2. Add runs — body `{"default_task_spec"?: TaskSpec, "inputs": TaskRunInput[]}` (each input may carry its own `processor`, `task_spec` override, `metadata`). Response: `{status, run_ids: string[], run_cursor, event_cursor}`. Up to 1,000 runs per POST; loop for more; can keep adding runs indefinitely. Set `refresh_status=false` query param for faster bulk adds (returns cached status).
3. Monitor — `GET /{taskgroup_id}` returns `status`: `{num_task_runs, task_run_status_counts: {queued: n, running: n, completed: n, failed: n, ...}, is_active, status_message, modified_at}`. Group is done when `is_active == false` (statuses counted over the same 7-state enum as runs).
4. Retrieve — `GET .../runs?include_input=true&include_output=true` returns an **SSE stream** (one event per run currently in the group — a snapshot, then closes; it does NOT wait for completion). Events: `{type: "task_run.state"|"error", event_id, run: TaskRun, input?: RunInput, output?: TaskRunOutput}`. `output` present only when `include_output=true` AND the run completed. Resume newer runs with `?last_event_id=<event_id>`.
5. `GET .../events` is the live stream (stays open while runs are active): group-level status + run status transitions only — no reasoning trace, resumable via `event_id`. Final results NOT included; fetch via run result endpoint.

Runs in a group are stored indefinitely.

---

## 4. Basis (citations / reasoning / confidence / excerpts)

Every completed run's `output` carries `basis: FieldBasis[]` — one entry per **top-level** output field (for text output: a single entry with `field: "output"`).

**FieldBasis** (OpenAPI; required: `field`, `reasoning`):
```json
{
  "field": "founding_year",
  "citations": [
    {
      "title": "About Microsoft" ,          // string|null, optional
      "url": "https://www.microsoft.com/en-us/about",   // required
      "excerpts": ["Founded in 1975, Microsoft ..."]     // string[]|null — only certain processors provide excerpts
    }
  ],
  "reasoning": "Multiple authoritative sources consistently state 1975...",
  "confidence": "high"                       // "low"|"medium"|"high" or null — only certain processors
}
```
- `citations` defaults to `[]`.
- Confidence levels: high = multiple consistent authoritative sources; medium = adequate but some inconsistency; low = limited/conflicting evidence.
- Docs guide says "All processors include a confidence rating"; the OpenAPI schema hedges "Only certain processors provide confidence levels" — treat `confidence` as nullable.
- **Per-element basis (beta):** send header `parallel-beta: field-basis-2025-11-25` on run creation → array fields additionally get per-element FieldBasis entries with dot-notation field names: `key_executives`, `key_executives.0`, `key_executives.1`, ...
- Do NOT add `citations`/`reasoning`/`confidence`/`sources`/`source_urls`/`evidence`/`source` fields to your output schema — triggers a spec validation warning; the info is already in `basis`.

Example full JSON output object:
```json
{
  "content": {"company": "Microsoft", "founded": "1975"},
  "basis": [
    {"field": "company", "citations": [{"url": "...", "excerpts": ["..."]}], "reasoning": "...", "confidence": "high"},
    {"field": "founded", "citations": [{"url": "..."}, {"url": "..."}], "reasoning": "...", "confidence": "high"}
  ],
  "type": "json"
}
```

---

## 5. Output schema authoring

**Field `description` is the per-field prompt.** Put entity/action/format/fallback instructions there, e.g.:
```json
"employee_count": {
  "type": "string",
  "description": "The current number of employees at the company. Use the most recent data available from LinkedIn, company website, or press releases. Format as a range (e.g., '501-1000') if exact count unavailable. If no data found, return 'Unknown'."
}
```
- Fallbacks like "If unavailable, return null" / "return 'Not found'" go in the description.
- Top-level schema `description` carries task-wide instructions (e.g. "Extract all information only from well-known government sites.").
- Use specific field names (`ceo_name`, `annual_revenue_2024`), specify date formats (`YYYY-MM-DD`), quantities in names (`top_5_products`). Keep schemas flat.

**Validation rules (JSON Schema subset):**
- Root must be `"type": "object"` with `properties` (error). Root `anyOf` not allowed (error). Standalone `null` type only inside unions (error).
- All properties should be in `required` (warning); optionality via union: `"type": ["string", "null"]`.
- `additionalProperties: false` on all objects (warning if not).
- Limits (errors): nesting ≤ 5 levels; ≤ 100 total properties; ≤ 500 enum values total (≤7,500 chars of enum strings when >250 values); task spec ≤ 15,000 chars; **task spec + input combined ≤ 25,000 chars**.
- **Unsupported keywords** (rejected): `contains`, `format`, `maxContains`, `maxItems`, `maxLength`, `maxProperties`, `maximum`, `minContains`, `minItems`, `minLength`, `minimum`, `minProperties`, `multipleOf`, `pattern`, `patternProperties`, `propertyNames`, `uniqueItems`, `unevaluatedItems`, `unevaluatedProperties`. Express constraints in `description` instead.

---

## 6. Search API (synchronous)

```
POST https://api.parallel.ai/v1/search
x-api-key: $PARALLEL_API_KEY
```

### Request (`V1SearchRequest`; required: `search_queries`)
| Field | Type | Notes |
|---|---|---|
| `search_queries` | string[] | Required, ≥1 non-empty. Concise keyword queries 3–6 words; 2–3 recommended; max 5 queries, 200 chars each |
| `objective` | string \| null | Natural-language research goal; ≤5000 chars. Provide both objective + queries for best results |
| `mode` | `"turbo"` \| `"basic"` \| `"advanced"` \| null | Default `advanced` (~3s, highest quality). `turbo`: p50 ~200ms, cheapest. `basic`: quick retrieval |
| `max_chars_total` | int \| null | Cap on total excerpt chars across results (default dynamic) |
| `client_model` | string \| null | Model consuming results, e.g. `"claude-opus-4-7"` — enables tailoring |
| `session_id` | string \| null | ≤1000 chars; reuse across related search/extract calls of one task |
| `advanced_settings` | object \| null | `{source_policy?: {include_domains, exclude_domains, after_date}, fetch_policy?: {max_age_seconds,...}, excerpt_settings?: {max_chars_per_result}, location?: "us", max_results?: int}` — `max_results` default 10, public cap 20 |

There is **no `processor` param** on the GA Search API — the tier knob is `mode`. (Older beta had `processor: base|pro`; migrated to modes.)

### Response (`V1SearchResponse`)
```json
{
  "search_id": "search_8a911eb27c7a4afaa20d0d9dc98d07c0",
  "results": [
    {
      "url": "https://...",           // required
      "title": "..." ,                 // string|null
      "publish_date": "2025-11-19",   // string|null, YYYY-MM-DD
      "excerpts": ["markdown excerpt ..."]   // required, string[]
    }
  ],
  "warnings": null,
  "usage": [{"name": "sku_search", "count": 1}],
  "session_id": "session_8a911eb27c7a4afaa20d0d9dc98d07c0"
}
```
Results ordered by decreasing relevance. `session_id` is echoed or server-generated — pass it to subsequent related calls.

Pricing: turbo $1/1000 requests; basic/advanced $5/1000; +$1/1000 additional results beyond default 10.

Related (not Search): `POST /v1/extract` ($1/1000 URLs) for URL→markdown; `POST /v1beta/findall/entity-search` for fast people/company entity search.

---

## 7. TypeScript SDK (`parallel-web`)

- Package: **`parallel-web`**, latest **1.1.0** (published ~2026-06, npm dist-tag `latest`). Official: "The official TypeScript library for the Parallel API". Node 20+. Python equivalent: `parallel-web` on PyPI.
- Repo: github.com/parallel-web/parallel-sdk-typescript
- Errors: subclasses of `APIError` (`AuthenticationError` 401, `RateLimitError` 429, `UnprocessableEntityError` 422, etc.). Default request timeout 1 min; default 2 retries on connection errors/408/409/429/5xx; configure `{maxRetries, timeout}` on constructor or per request.

### Init
```ts
import Parallel from "parallel-web";

const client = new Parallel({
  apiKey: process.env["PARALLEL_API_KEY"], // default env var — can omit
  // maxRetries: 2, timeout: 60_000,
});
```

### Method surface (from SDK api.md)
```ts
client.search({ ...params })                    // -> SearchResult
client.extract({ ...params })                   // -> ExtractResponse
client.taskRun.create({ ...params })            // -> TaskRun
client.taskRun.retrieve(runId)                  // -> TaskRun
client.taskRun.result(runId, { timeout? , betas? })  // -> TaskRunResult (timeout = API blocking seconds, query param)
client.taskRun.events(runId)                    // -> Stream<TaskRunEventsResponse> (SSE)
client.taskRun.retrieveInput(runId)             // -> RunInput
client.taskGroup.create({ metadata? })          // -> TaskGroup
client.taskGroup.retrieve(taskGroupId)          // -> TaskGroup
client.taskGroup.addRuns(taskGroupId, { default_task_spec?, inputs, refresh_status? }) // -> TaskGroupRunResponse
client.taskGroup.getRuns(taskGroupId, { include_input?, include_output?, last_event_id?, status? }) // -> SSE stream
client.taskGroup.events(taskGroupId, { ...params })  // -> SSE stream
client.taskGroup.retrieveRun(runId, { ...params })   // -> TaskRun
// client.beta.* exists (FindAll etc.); client.monitor.* for Monitor API
```
Python naming differs: `client.task_run.result(run_id, api_timeout=3600)` (Python uses `api_timeout`; TS uses `timeout` inside the params object).

### Task run: create + blocking result
```ts
import Parallel from "parallel-web";

const client = new Parallel({ apiKey: process.env.PARALLEL_API_KEY });

const run = await client.taskRun.create({
  input: { company_name: "Stripe", website: "stripe.com" },
  processor: "core",
  task_spec: {
    output_schema: {
      type: "json",
      json_schema: {
        type: "object",
        properties: {
          founding_year: { type: "string", description: "Year founded, YYYY. If unavailable, return null." },
          total_funding: { type: "string", description: "Total funding in USD. If unknown, return 'Unknown'." },
        },
        required: ["founding_year", "total_funding"],
        additionalProperties: false,
      },
    },
  },
});

// Blocking (timeout = server-side seconds to hold the request; 408 -> retry)
const result = await client.taskRun.result(run.run_id, { timeout: 300 });
const output = result.output as Parallel.TaskRunJsonOutput;
console.log(output.content, output.basis);
```

Poll-with-retry pattern used in official docs:
```ts
async function pollResult(runId: string) {
  for (let i = 0; i < 20; i++) {
    try {
      return await client.taskRun.result(runId, { timeout: 25 });
    } catch (error) {
      if (i === 19) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
```

### Webhook at creation (TS)
```ts
const taskRun = await client.taskRun.create({
  task_spec: { output_schema: "Find the GDP of the specified country and year" },
  input: "France (2023)",
  processor: "core",
  metadata: { key: "value" },
  webhook: { url: "https://your-domain.com/webhooks/parallel", event_types: ["task_run.status"] },
});
```

### Search (TS)
```ts
const search = await client.search({
  objective: "Find latest information about Parallel Web Systems. Focus on new product releases.",
  search_queries: ["Parallel Web Systems products", "Parallel Web Systems announcements"],
  // mode: "turbo",
});
for (const r of search.results) {
  console.log(r.title, r.url);
  for (const excerpt of r.excerpts) console.log(excerpt.slice(0, 200));
}
```

### Task group batch (TS, condensed from docs)
```ts
const group = await client.taskGroup.create({});
const { run_ids } = await client.taskGroup.addRuns(group.taskgroup_id, {
  default_task_spec: taskSpec, // Parallel.TaskSpec
  inputs: companies.map((c) => ({ input: c, processor: "pro" })), // Parallel.RunInput[] (≤1000/call)
  // refresh_status: false, // for bulk adds
});

// poll group
while (true) {
  const g = await client.taskGroup.retrieve(group.taskgroup_id);
  if (!g.status.is_active) break;
  await new Promise((r) => setTimeout(r, 10_000));
}

// stream results snapshot
const runStream = await client.taskGroup.getRuns(group.taskgroup_id, {
  include_input: true,
  include_output: true,
});
for await (const event of runStream) {
  if (event.type === "task_run.state" && event.output) {
    const out = (event.output as Parallel.TaskRunJsonOutput).content;
    // event.input?.input has the original input
  }
}
```
Useful SDK types: `Parallel.TaskSpec`, `Parallel.RunInput`, `Parallel.TaskGroup`, `Parallel.TaskGroupStatus`, `Parallel.TaskGroupRunResponse`, `Parallel.TaskGroupGetRunsResponse`, `Parallel.TaskRunJsonOutput`, `Parallel.TaskRunTextOutput`.

---

## 8. Adjacent APIs (one-liners, for orientation)

- `POST /v1/extract` — URLs → LLM-ready markdown (sync).
- `POST /v1/responses` — OpenAI-Responses-compatible, cited web-research answers in 5–60s; `reasoning.effort` low/$10, medium/$50 (default), high/$250 per 1000 (added July 21, 2026).
- `POST /v1beta/chat/completions` — OpenAI ChatCompletions-compatible; models `speed|lite|base|core`.
- `POST /v1beta/findall/runs` (+ entity-search) — entity discovery/verification.
- `POST /v1/monitors` — scheduled web monitoring (GA May 2026), can trigger follow-up Tasks.

## Gotchas recap
- Auth header is `x-api-key`, NOT `Authorization: Bearer`.
- TaskRun status enum has 7 states incl. `action_required`, `cancelling`, `cancelled` — handle unknown statuses defensively; older docs pages show only 4.
- Webhook = notification only; fetch results separately.
- Blocking result default timeout 600s; returns 408 (retryable) on expiry.
- `GET /v1/tasks/groups/{id}/runs` is an SSE snapshot stream, not JSON — and it doesn't wait for completion; `/events` is the live stream.
- Search GA has `mode` (turbo/basic/advanced), not `processor`.
- Task spec + input combined ≤ 25,000 chars; many JSON Schema validation keywords unsupported (put constraints in `description`).
- TS SDK `taskRun.result(runId, { timeout })` — `timeout` here is the API's blocking-seconds query param, distinct from the SDK's own request `timeout` (ms) in `RequestOptions`; Python calls it `api_timeout`.
- `enable_events` defaults true only for `pro`+; per-run SSE streams close after 570s and are not resumable.
- Interactions: pass `previous_interaction_id` (response's `interaction_id`) to chain context; not available for ZDR accounts.
