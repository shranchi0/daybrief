# OpenRouter API Reference (verified August 2026)

Sources: openrouter.ai/docs (live pages), `https://openrouter.ai/openapi.json` (fetched 2026-08-05),
npm registry, OpenRouterTeam/ai-sdk-provider GitHub. Anything not verified from these is marked
**UNVERIFIED**.

---

## 1. Chat completions basics

- **Base URL:** `https://openrouter.ai/api/v1`
- **Chat completions:** `POST https://openrouter.ai/api/v1/chat/completions` (OpenAI-compatible)
- **Also exists:** `POST /api/v1/responses` (OpenAI Responses API-compatible), `POST /api/v1/messages`
  (Anthropic-compatible), `POST /api/v1/embeddings`, `POST /api/v1/images`, etc.
- **Auth:** `Authorization: Bearer <OPENROUTER_API_KEY>` — same key for all endpoints.
- **Optional attribution headers:**
  - `HTTP-Referer: <your-app-url>` — app attribution/rankings
  - `X-Title: <app name>` (docs now also list alias `X-OpenRouter-Title`)
  - `X-OpenRouter-Categories` — marketplace categories (newer, optional)
- **Model ID format:** `vendor/model-slug`, e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4.6`,
  `google/gemini-2.5-flash`. Optional **variant suffix** after a colon:
  - `:online` — auto-enables the legacy web plugin (see §3B)
  - `:free`, `:nitro`, `:floor`, `:thinking` — free tier / throughput-sorted / price-sorted /
    reasoning variants (`:online` and `:thinking` verified in current docs; the others are
    long-standing and low-risk but individual model support varies — check `/models`).
- `model` may also be an array via `models: [...]` for fallback routing; `provider: {...}` object
  controls provider routing (e.g. `{"require_parameters": true}`, `{"only": [...]}`, `{"order": [...]}`).

### Minimal request

```bash
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Response is standard OpenAI chat-completion shape (`id`, `choices[].message`,
`choices[].finish_reason`, `usage`, plus OpenRouter extras: top-level `provider`,
`choices[].native_finish_reason`). The response `id` (e.g. `gen-...`) is the **generation ID**
used with `GET /generation` (§5).

Finish reasons are normalized to: `tool_calls`, `stop`, `length`, `content_filter`, `error`
(raw provider value in `native_finish_reason`).

Notable request-body fields (verified against OpenAPI request schema): `messages`, `model`,
`models`, `stream`, `stream_options`, `max_tokens` / `max_completion_tokens`, `temperature`,
`top_p`, `top_k`, `seed`, `stop`, `tools`, `tool_choice`, `parallel_tool_calls`,
`response_format`, `plugins`, `provider`, `reasoning` / `reasoning_effort`, `route`,
`stop_server_tools_when`, `session_id`, `metadata`, `user`.

---

## 2. Server-side agentic tools ("server tools") — beta

Docs: `https://openrouter.ai/docs/guides/features/server-tools/web-search` (and sibling pages).
**Status: beta — "The API and behavior may change."**

These are tools the *model can call 0–N times during one request*, executed **server-side by
OpenRouter** (no client tool loop needed). Declared in the normal `tools` array alongside your
own function tools; OpenRouter runs its tools, you still handle your own `function` tool calls.

### Full tool list (exact `type` strings, from OpenAPI spec)

| Tool | `type` string |
|---|---|
| Web Search | `openrouter:web_search` |
| Web Fetch | `openrouter:web_fetch` |
| Datetime | `openrouter:datetime` |
| Image Generation | `openrouter:image_generation` |
| Apply Patch | `openrouter:apply_patch` |
| Shell | `openrouter:shell` |
| Fusion | `openrouter:fusion` |
| Advisor | `openrouter:advisor` |
| Subagent | `openrouter:subagent` |
| Search Models | `openrouter:experimental__search_models` |

### 2A. `openrouter:web_search`

```json
{
  "model": "anthropic/claude-sonnet-4.6",
  "messages": [{"role": "user", "content": "What changed in the EU AI Act this month?"}],
  "tools": [
    {
      "type": "openrouter:web_search",
      "parameters": {
        "engine": "exa",
        "max_results": 5,
        "max_uses": 3,
        "max_total_results": 15,
        "allowed_domains": ["europa.eu"],
        "max_characters": 2000
      }
    }
  ]
}
```

All `parameters` fields optional (verified against `WebSearchServerToolConfig` in OpenAPI spec):

| Param | Type | Notes |
|---|---|---|
| `engine` | string | `auto` (default) \| `native` \| `exa` \| `parallel` \| `firecrawl` \| `perplexity`. `auto` = provider-native search when supported, else **Exa**. `native` forces provider's built-in search. `firecrawl` requires BYOK (your Firecrawl key). |
| `max_results` | int | Per search call, default 5. Exa/Firecrawl/Parallel/Perplexity only; ignored for native. Perplexity clamps at 20. |
| `max_uses` | int | Max searches per request; exceeding returns an error result to the model. Forwarded to Anthropic native as `max_uses`; other native providers ignore it. |
| `max_total_results` | int | Cumulative results across all searches in the request; **defaults to 50**. Cost/context control for agentic loops. |
| `search_context_size` | string | `low` \| `medium` \| `high` (quality level). |
| `max_characters` | int | Exact char cap per result (Exa/Parallel/Perplexity; ignored for native + Firecrawl). Takes precedence over `search_context_size`. Parallel default excerpt ≈1500 chars. |
| `allowed_domains` / `excluded_domains` | string[] | Mutually exclusive. Supported by Exa, Firecrawl, Parallel, Perplexity + most native (Anthropic, OpenAI, xAI). |
| `user_location` | object | Location-biased results (native providers). |

**Native-search-capable providers** (used when `engine` is `auto`/`native`): OpenAI (GPT-4.1+ /
GPT-5 / o3 / o4-mini), Anthropic (Claude 3.5 Haiku and newer), Google (Gemini 3+), xAI (Grok 4+),
Perplexity (all models). Everything else falls back to Exa under `auto`.

**Pinning the engine:** set `parameters.engine` explicitly (`"exa"`, `"parallel"`,
`"perplexity"`, `"firecrawl"`, `"native"`). This is the supported way to pin Exa vs Parallel etc.

**Pricing (docs, Aug 2026):**
- Exa: **$0.005/request** + $0.001 per result beyond 10
- Parallel: **$0.001/request** + $0.001 per result beyond 10
- Perplexity: **$0.005/request**
- Firecrawl: billed to your own Firecrawl credits (≈2 credits per search of 10 results, 5 per scraped result)
- Native: provider's own search pricing passed through
(Billed on top of normal LLM token costs — search results become prompt tokens too.)

**Response:** cited content appears as `annotations` of type `url_citation` on the assistant
message (see §3B for the shape — same annotation schema). Usage object includes
`server_tool_use_details` (see §4).

### 2B. `openrouter:web_fetch`

```json
{
  "model": "openai/gpt-5.2",
  "messages": [{"role": "user", "content": "Summarize https://example.com/article"}],
  "tools": [
    {
      "type": "openrouter:web_fetch",
      "parameters": {
        "engine": "auto",
        "max_uses": 10,
        "max_content_tokens": 100000,
        "allowed_domains": ["docs.example.com"],
        "blocked_domains": ["private.example.com"]
      }
    }
  ]
}
```

Params (verified against `WebFetchServerToolConfig`): `engine`
(`auto` | `native` | `openrouter` | `exa` | `parallel` | `firecrawl`; `openrouter` = direct HTTP
fetch), `max_uses` (fetches per request, error once exceeded), `max_content_tokens` (approx-token
truncation cap), `allowed_domains`, `blocked_domains`. Fetches web pages **and PDFs**.

**Pricing (docs):** Exa/Parallel ≈ **$1 per 1,000 fetches**; Firecrawl on your credits;
`openrouter`/native free or provider pass-through. OpenRouter/native engines cap at 50 fetches
per request.

### 2C. Agent-loop controls

- `max_tool_calls` (top-level): max server-tool agent steps per request — **default 30, max 30**.
  Verified in the OpenAPI spec on the **`/responses`** request schema. The docs describe it for
  server tools generally, but it is **not present in the `/chat/completions` request schema** in
  the current spec — on chat completions use `stop_server_tools_when` for step limits
  (this discrepancy is real as of 2026-08-05; treat `max_tool_calls` on chat/completions as
  UNVERIFIED).
- `stop_server_tools_when` (top-level, verified on chat completions): array of stop conditions,
  OR logic; overrides `max_tool_calls`. When it fires mid-tool-call, pending tool calls execute
  and one final no-tools turn produces a natural-language answer. Condition types:
  `step_count_is` (`{"type":"step_count_is","step_count":5}`), `max_cost`
  (`{"type":"max_cost","max_cost_in_dollars":0.5}`), `max_tokens_used`, `has_tool_call`,
  `finish_reason_is`.
- Nested agentic tools (Fusion/Advisor/Subagent) take their own `parameters.max_tool_calls`
  (caps 16–25).

### 2D. Server tools vs. the legacy web plugin — the key differences

| | Server tool (`openrouter:web_search`) | Web plugin (`plugins:[{id:"web"}]` / `:online`) |
|---|---|---|
| Who decides to search | The **model**, 0–N times per request (agentic) | Always exactly **one** search, injected before the model runs (single-shot) |
| Works with | Any model (tool-calling capable) | Any model |
| Domain filter params | `allowed_domains` / `excluded_domains` | `include_domains` / `exclude_domains` |
| Cumulative cap | `max_total_results` (default 50) | none |
| Status | Beta, **recommended** by docs | Still supported, docs point to server tools for new work |

---

## 3. Legacy single-shot mechanisms

### 3A. Plugins array (current plugin ids, from OpenAPI spec)

`plugins` discriminated by `id`: `web`, `web-fetch`, `file-parser`, `response-healing`,
`moderation`, `context-compression`, `auto-router`, `auto-beta-router`, `pareto-router`, `fusion`.

### 3B. Web plugin & `:online`

```json
{ "model": "openai/gpt-5.2:online" }
```
is equivalent to
```json
{
  "model": "openai/gpt-5.2",
  "plugins": [{ "id": "web" }]
}
```

Full options (verified against `WebSearchPlugin` schema):

```json
{
  "plugins": [{
    "id": "web",
    "enabled": true,
    "engine": "exa",
    "max_results": 5,
    "max_uses": 3,
    "search_prompt": "A web search was conducted on `date`. ...",
    "include_domains": ["example.com", "*.substack.com", "openai.com/blog"],
    "exclude_domains": ["reddit.com"],
    "user_location": {"type": "approximate", "city": "San Francisco", "country": "US"}
  }]
}
```

- `engine`: `native` | `exa` | `firecrawl` | `parallel` | `perplexity` | unset (auto behavior).
- Domain filters support wildcards and path filtering.
- Same per-request engine pricing as §2A.

**Citations** arrive as OpenAI-standard annotations on the assistant message (same shape for the
server tool):

```json
{
  "message": {
    "role": "assistant",
    "content": "...",
    "annotations": [{
      "type": "url_citation",
      "url_citation": {
        "url": "https://example.com/result",
        "title": "Result Title",
        "content": "Extracted excerpt",
        "start_index": 100,
        "end_index": 200
      }
    }]
  }
}
```

---

## 4. Usage accounting (tokens + cost per request)

**IMPORTANT CHANGE (2026):** the old opt-in is gone. Per current docs and the OpenAPI spec:
- `usage: { include: true }` — **deprecated, no effect; not even in the request schema anymore.**
- `stream_options: { include_usage: true }` — present in schema but marked
  `"deprecated": true, "This field has no effect. Full usage details are always included."`

Every response now always carries a full `usage` object (non-streaming: in the response;
streaming: on the **final SSE chunk**). Sending the old flags is harmless.

### `usage` object (verified `ChatUsage` schema)

```json
{
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25,
    "cost": 0.0012,
    "cost_details": {
      "upstream_inference_cost": null,
      "upstream_inference_prompt_cost": 0.0008,
      "upstream_inference_completions_cost": 0.0004
    },
    "is_byok": false,
    "prompt_tokens_details": {
      "cached_tokens": 2,
      "cache_write_tokens": 0,
      "audio_tokens": 0,
      "video_tokens": 0
    },
    "completion_tokens_details": { "reasoning_tokens": 5 },
    "server_tool_use_details": {
      "tool_calls_requested": 2,
      "tool_calls_executed": 2,
      "web_search_requests": 2
    }
  }
}
```

- `cost` = amount charged to your OpenRouter account, in **credits** (OpenRouter credits are
  USD-denominated; docs label the unit "credits"). Nullable.
- `cost_details.upstream_inference_cost` = actual upstream provider cost (relevant for BYOK,
  where `cost` is only OpenRouter's fee).
- Token counts are from the provider's **native** tokenizer.
- `server_tool_use_details`: `tool_calls_requested`/`tool_calls_executed` count
  OpenRouter-orchestrated server tool calls; `web_search_requests` counts searches (native
  provider search may report only `web_search_requests`). **Do not sum the two.**
  (Older docs showed `server_tool_use.web_search_requests`; current OpenAPI schema says
  `server_tool_use_details` — trust the schema; handle both keys defensively if paranoid.)

### 5. `GET /generation` — after-the-fact cost lookup

```
GET https://openrouter.ai/api/v1/generation?id=gen-XXXX
Authorization: Bearer <OPENROUTER_API_KEY>
```

`id` = the `id` from the chat completion response. Response (full example from OpenAPI spec):

```json
{
  "data": {
    "id": "gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG",
    "model": "sao10k/l3-stheno-8b",
    "provider_name": "Infermatic",
    "api_type": "completions",
    "total_cost": 0.0015,
    "usage": 0.0015,
    "upstream_inference_cost": 0.0012,
    "cache_discount": null,
    "is_byok": false,
    "tokens_prompt": 10,
    "tokens_completion": 25,
    "native_tokens_prompt": 10,
    "native_tokens_completion": 25,
    "native_tokens_reasoning": 5,
    "native_tokens_cached": 3,
    "native_tokens_completion_images": 0,
    "num_media_prompt": 1,
    "num_media_completion": 0,
    "num_search_results": 5,
    "num_fetches": 0,
    "web_search_engine": "exa",
    "generation_time": 1200,
    "latency": 1250,
    "moderation_latency": 50,
    "finish_reason": "stop",
    "native_finish_reason": "stop",
    "streamed": true,
    "cancelled": false,
    "created_at": "2024-07-15T23:33:19.433273+00:00",
    "origin": "https://openrouter.ai/",
    "http_referer": "https://openrouter.ai/",
    "app_id": 12345,
    "external_user": "user-123",
    "session_id": null,
    "preset_id": "a9e8d400-592a-494f-908c-375efa66cafd",
    "request_id": "req-1727282430-aBcDeFgHiJkLmNoPqRsT",
    "upstream_id": "chatcmpl-791bcf62-080e-4568-87d0-94c72e3b4946",
    "router": "openrouter/auto",
    "service_tier": "priority",
    "data_region": "global",
    "user_agent": "Mozilla/5.0",
    "provider_responses": null
  }
}
```

- `total_cost` in credits (USD-denominated). `tokens_*` = normalized (GPT-tokenizer) counts;
  `native_tokens_*` = provider-native counts used for billing.
- `num_search_results` / `num_fetches` / `web_search_engine` let you audit web-tool spend per
  generation — useful for an eval harness.
- Stats are written shortly after the generation completes; immediately-after queries can 404 —
  poll with a short backoff (exact propagation delay UNVERIFIED, practically ≤ a few seconds).
- Related: `GET /generation/content`, `POST /generation/feedback`, and `GET /activity` +
  `POST /analytics/query` for aggregate accounting.

---

## 6. Structured outputs (`response_format: json_schema`)

```json
{
  "model": "openai/gpt-5.2",
  "messages": [{"role": "user", "content": "What is 2+2? Reply as JSON."}],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "math_response",
      "description": "A mathematical response",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "answer": { "type": "number" } },
        "required": ["answer"],
        "additionalProperties": false
      }
    }
  }
}
```

Verified schema details:
- `response_format.type` one of: `text`, `json_object`, `json_schema`, `grammar`, `python`
  (the last two are newer, niche).
- Inside `json_schema`: **`name` is the only required field** (a–z, A–Z, 0–9, `_`, `-`, max 64
  chars); `strict` (boolean, default false-ish/null) enforces exact adherence; `schema` = the
  JSON Schema object; optional `description`.
- Streaming works (streams valid partial JSON).

**Which models:** "select models" — support is per provider endpoint (OpenAI, Google Gemini,
Anthropic, Fireworks-hosted OSS, etc.). Discover programmatically via
`GET /models?supported_parameters=structured_outputs` (also `response_format` for plain JSON
mode) — each model's `supported_parameters` array tells you.

**Hard-require support at routing time:**

```json
{ "provider": { "require_parameters": true }, "response_format": { "type": "json_schema", ... } }
```

This routes only to endpoints supporting everything you sent. Unsupported model → error;
malformed schema → error. Optional `plugins: [{"id": "response-healing"}]` repairs near-miss
JSON on non-streaming responses.

---

## 7. Listing models — `GET /models`

```
GET https://openrouter.ai/api/v1/models            # no auth required for the public list
GET https://openrouter.ai/api/v1/models?supported_parameters=structured_outputs,tools
GET https://openrouter.ai/api/v1/models?category=programming&limit=1000&offset=0
```

Query params (verified): `offset` (default 0), `limit` (default 500, max 1000 — **omit both to
get the full list**), `category` (enum: programming, roleplay, marketing, marketing/seo,
technology, science, translation, legal, finance, health, trivia, academia),
`supported_parameters` (comma-separated), `output_modalities` (`text` default; comma list of
text,image,audio,embeddings or `all`).

Per-model object (verified example):

```json
{
  "id": "openai/gpt-4",
  "canonical_slug": "openai/gpt-4",
  "name": "GPT-4",
  "created": 1692901234,
  "description": "...",
  "context_length": 8192,
  "architecture": {
    "modality": "text->text",
    "input_modalities": ["text"],
    "output_modalities": ["text"],
    "tokenizer": "GPT",
    "instruct_type": "chatml"
  },
  "pricing": {
    "prompt": "0.00003",
    "completion": "0.00006",
    "request": "0",
    "image": "0"
  },
  "supported_parameters": ["temperature", "top_p", "max_tokens"],
  "top_provider": { "context_length": 8192, "max_completion_tokens": 4096, "is_moderated": true },
  "per_request_limits": null,
  "default_parameters": null,
  "knowledge_cutoff": null,
  "expiration_date": null,
  "links": { "details": "/api/v1/models/openai/gpt-4/endpoints" }
}
```

- **`pricing` values are strings, USD per token** (per request / per image for those keys):
  `"0.00003"` = $30/M input tokens. Multiply by 1e6 for per-million pricing.
- `supported_parameters` is where you check for `tools`, `structured_outputs`,
  `response_format`, `reasoning`, etc.
- Related endpoints for a harness: `GET /models/count`, `GET /models/user` (models your key can
  use), `GET /models/{author}/{slug}/endpoints` (per-provider endpoints incl. per-endpoint
  pricing/quantization/uptime), `GET /model/{author}/{slug}`, `GET /providers`.

---

## 8. `@openrouter/ai-sdk-provider` (Vercel AI SDK)

**Versions (npm, checked 2026-08-05):**
- `latest`: **3.0.0** (published 2026-07-06) — peer deps `ai@^7.0.0`, `zod@^3.25.76 || ^4.1.8`,
  Node 22+, **ESM-only**.
- AI SDK v6 → use `@openrouter/ai-sdk-provider@2.9.1` (2.x line, up to 2.10.0)
- AI SDK v5 → `@1.5.4`; AI SDK v4 → dist-tag `ai-sdk-v4` (0.7.5)
- Pre-release tags exist (`beta` 1.0.0-beta.7, `alpha` 6.0.0-alpha.1) — ignore for prod.

### Init + basic usage

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, generateObject, streamText } from 'ai';
import { z } from 'zod';

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,          // required
  // baseURL: 'https://openrouter.ai/api/v1',       // optional override
  headers: { 'HTTP-Referer': 'https://myapp.dev', 'X-Title': 'MyApp' },
  // extraBody: { ... }                              // merged into every request body
});

const { text, usage, providerMetadata } = await generateText({
  model: openrouter('anthropic/claude-sonnet-4.6'), // or openrouter.chat('...')
  prompt: 'Write a haiku about eval harnesses.',
});
```

### generateObject (structured outputs)

```ts
const { object } = await generateObject({
  model: openrouter('openai/gpt-5.2', {
    plugins: [{ id: 'response-healing' }],          // optional JSON repair
  }),
  schema: z.object({ name: z.string(), age: z.number() }),
  prompt: 'Generate a person.',
});
```
(The AI SDK maps your zod schema to `response_format: json_schema` under the hood.)

### Passing OpenRouter-specific body fields — three equivalent routes

1. **Per-call** via `providerOptions.openrouter` (merged into request body):
```ts
await streamText({
  model: openrouter.chat('anthropic/claude-opus-4.6'),
  messages: [...],
  providerOptions: {
    openrouter: {
      reasoning: { max_tokens: 10 },
      // server tools go here too:
      tools: [{
        type: 'openrouter:web_search',
        parameters: { engine: 'exa', max_results: 5, max_total_results: 15 },
      }],
      tool_choice: 'auto',
    },
  },
});
```
2. **Per-model** via model settings: `openrouter('model-id', { extraBody: {...}, plugins: [...], usage: {...} })`
3. **Provider-wide** via `createOpenRouter({ extraBody: {...} })`

Anything OpenRouter accepts in the body (`plugins`, `provider`, `transforms`, `models`,
`reasoning`, server `tools`, `stop_server_tools_when`, ...) can be sent through these.
The `:online` suffix also works: `openrouter('openai/gpt-5.2:online')`.

Caveat (GitHub issue #494, open as of Aug 2026): when server tools run, providerMetadata may
misreport the provider name for some models — cosmetic, results are correct.

### Reading cost/usage via the SDK

```ts
const result = await generateText({ model: openrouter('openai/gpt-5.2'), prompt: 'hi' });
result.usage.inputTokens;                                   // AI SDK normalized
const or = result.providerMetadata?.openrouter as any;
or?.usage?.cost;            // credits (USD) charged
or?.usage?.totalTokens;
```
README still shows `openrouter('model', { usage: { include: true } })` — now a no-op server-side
(usage is always returned) but harmless; providerMetadata cost still populates.
`generationId` is also exposed in providerMetadata (verified for video models; for chat it is
the response `id` — use it with `GET /generation`).

Anthropic prompt caching via message-part `providerOptions.openrouter.cacheControl =
{ type: 'ephemeral' }`.

---

## 9. Errors

```ts
type ErrorResponse = {
  error: { code: number; message: string; metadata?: Record<string, unknown> };
};
```
HTTP status matches `error.code`:
400 bad request/CORS · 401 invalid key/OAuth · **402 insufficient credits** · 403 moderation/
guardrail/permissions · 408 timeout · 429 rate limited · 502 model down or invalid upstream
response · 503 no provider matches routing requirements.

Moderation 403 metadata: `{ reasons: string[], flagged_input: string /* ≤100 chars */,
provider_name: string, model_slug: string }`.

**Mid-stream errors:** after SSE begins, HTTP stays 200; an error chunk arrives
(`choices[0].finish_reason: "error"`, top-level `error` with `metadata.error_type` /
`metadata.provider_code`) and the stream terminates. Handle this in streaming eval code.

---

## 10. Gotchas summary

1. `usage: {include: true}` and `stream_options.include_usage` are **deprecated no-ops** —
   usage + cost are now always in every response (final SSE chunk when streaming).
2. Server tools (`openrouter:web_search`, `openrouter:web_fetch`) are **beta**; the legacy web
   plugin/`:online` is single-shot, uses `include_domains`/`exclude_domains` (server tool uses
   `allowed_domains`/`excluded_domains`).
3. `max_tool_calls` (top-level) is only in the `/responses` schema; on `/chat/completions` use
   `stop_server_tools_when`.
4. Usage schema field is `server_tool_use_details` (some docs pages still say
   `server_tool_use`).
5. `/models` `pricing` values are **strings in USD per token**, not per million.
6. Old doc URLs (`/docs/api-reference/*`, `/docs/use-cases/*`, `/docs/features/*`) 404 —
   docs moved under `/docs/guides/...`; the OpenAPI spec at `https://openrouter.ai/openapi.json`
   is the ground truth.
7. `@openrouter/ai-sdk-provider@3.0.0` requires AI SDK v7 + Node 22, ESM-only; pin 2.9.1 for
   AI SDK v6.
8. Mid-stream failures return HTTP 200 with an error chunk (`finish_reason: "error"`).
