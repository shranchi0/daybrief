# Inngest TypeScript SDK Reference (v4)

> Verified against live docs at inngest.com/docs-markdown and the npm registry on **2026-08-05**.
> Current npm package: **`inngest@4.16.0`** (major version **v4**, `latest` dist-tag; v3 is maintained as `v3-lts` = 3.54.0).
> v4 has breaking API changes vs v3 — most notably **triggers moved into the options object** of `createFunction`. All snippets below use v4 syntax.

Source docs: `https://www.inngest.com/llms.txt` (index), `https://www.inngest.com/docs-markdown/...` (per-page markdown), `https://www.inngest.com/llms-full.txt` (everything).

---

## 1. Install, client init, env vars

```bash
npm install inngest        # 4.x
```

```ts
// src/inngest/client.ts — create ONE client and share it everywhere
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "machineint",            // required: unique app id (hyphenated slug, stable across deploys)
  // eventKey: "...",          // prefer INNGEST_EVENT_KEY env var instead
  // signingKey: "...",        // prefer INNGEST_SIGNING_KEY env var instead
  // isDev: true,              // force Dev Mode; prefer INNGEST_DEV=1
  // env: "branch-name",       // only for Branch Environments (or INNGEST_ENV)
  // baseUrl: "...",           // override default https://inn.gs event API (or INNGEST_BASE_URL)
  // middleware: [...],
  // checkpointing: { maxRuntime: "50s" },  // see Vercel section below
});
```

Client config options (v4): `id` (required), `baseUrl`, `env`, `eventKey`, `fetch`, `signingKey`, `signingKeyFallback`, `isDev`, `logger` (Pino-style object-first; `ConsoleLogger` default at level "info"), `internalLogger`, `middleware`, `aiMetadata` (default true), `endpointAdapter`, `checkpointing`.

### Modes (important v4 change)

- **Cloud Mode** (the DEFAULT in v4, even locally): signature verification ON, talks to `https://api.inngest.com`. Requires `INNGEST_SIGNING_KEY` or you get: `"A signing key is required to run in Cloud mode"`.
- **Dev Mode**: signature verification OFF, talks to Dev Server at `http://localhost:8288`. Enable with `INNGEST_DEV=1` (or `isDev: true`). v3 defaulted to dev; v4 defaults to cloud.

### Environment variables

| Var | Purpose |
|---|---|
| `INNGEST_EVENT_KEY` | Key used by `inngest.send()` to send events to Inngest Cloud. Set automatically by the Vercel integration. Any dummy value works against the local Dev Server (it doesn't validate keys). |
| `INNGEST_SIGNING_KEY` | Authenticates/signs requests between Inngest Cloud and your `serve()` endpoint. Required in Cloud Mode. Set automatically by the Vercel integration. |
| `INNGEST_SIGNING_KEY_FALLBACK` | Second key tried during signing-key rotation. |
| `INNGEST_DEV` | `1` forces Dev Mode, `0` forces Cloud Mode. Can also be a URL: `INNGEST_DEV=http://localhost:8288`. |
| `INNGEST_ENV` | Branch environment name. |
| `INNGEST_BASE_URL` | Override host for talking to Inngest (e.g. `http://host.docker.internal:8288` in Docker). |
| `INNGEST_SERVE_ORIGIN` | Public origin of your app (e.g. `https://acme.com`) when it can't be inferred from headers — set this on Vercel if you want syncs to use your custom domain. (v3's `INNGEST_SERVE_HOST` is deprecated.) |
| `INNGEST_SERVE_PATH` | Path of the serve handler, e.g. `/api/inngest`. |
| `INNGEST_STREAMING` | `true`/`false` — same as `streaming` option on `serve()`. |

In edge runtimes where env vars are passed at request time (Cloudflare/Hono): `inngest.setEnvVars(c.env)`.

---

## 2. createFunction — triggers (v4 shape)

```ts
inngest.createFunction(configuration, handler)
```

**v4 breaking change:** triggers live inside the first (options) argument as `triggers`, not as a separate second argument.

```ts
export const fn = inngest.createFunction(
  {
    id: "import-product-images",              // required, stable across deploys
    name: "Import product images",            // optional display name
    triggers: { event: "shop/product.imported" },  // single trigger object OR array (max 10)
    retries: 4,                               // 0–20, default 4
  },
  async ({ event, events, step, runId, logger, attempt }) => { /* ... */ }
);
```

### Cron triggers with timezone

Cron strings are unix-cron with an optional `TZ=` prefix (IANA timezone names):

```ts
import { cron } from "inngest";

// 5:00 AM Pacific, Mon–Fri
inngest.createFunction(
  { id: "weekday-morning-job", triggers: [cron("TZ=America/Los_Angeles 0 5 * * 1-5")] },
  async ({ step }) => { /* no `event` arg for cron-only runs */ }
);

// Plain-object form also works and supports jitter (random delay 1s–5m after boundary):
triggers: [{ cron: "0 * * * *", jitter: "5m" }]
```

Notes:
- Cron-triggered runs receive **no meaningful `event` payload** (handler's `event` is an internal `inngest/scheduled.timer`-style trigger; don't rely on `event.data`).
- DST warning: schedules near DST transitions may run 0, 1, or 2 times; prefer `TZ=UTC` or avoid transition hours (e.g. 2 AM US).
- Overlapping cron schedules on one function are deduplicated.
- Free plan: a cron function that fails 20 times consecutively is auto-paused.

### Typed event triggers (v4 trigger helpers)

```ts
import { eventType, cron, invoke, staticSchema } from "inngest";
import { z } from "zod";

// Runtime-validated (any Standard Schema lib: Zod, Valibot, ArkType…)
const orderPlaced = eventType("shop/order.placed", {
  schema: z.object({ orderId: z.string(), total: z.number() }),
});

// Type-only, no runtime validation (expects a `type`, not an `interface`)
const userCreated = eventType("app/user.created", {
  schema: staticSchema<{ userId: string; email: string }>(),
});

inngest.createFunction(
  { id: "process-order", triggers: [orderPlaced] },
  async ({ event }) => { /* event.data typed */ }
);
```

- Wildcards: `eventType("user/*")` (wildcard types can't define a schema).
- Schema `.transform()` is NOT supported — validate input shape only; transform inside the handler.
- Conditional filter: `triggers: [{ event: orderPlaced, if: "event.data.total > 100" }]` (CEL expression).
- Sending typed events: `await inngest.send(orderPlaced.create({ orderId: "x", total: 1 }))`.

### Multiple triggers on one function

Up to **10** triggers per function; mix events and crons:

```ts
inngest.createFunction(
  {
    id: "data-sync",
    triggers: [
      cron("TZ=America/Los_Angeles 0 5 * * 1-5"),
      eventType("app/sync.requested"),      // manual trigger for the same function
    ],
  },
  async ({ event, step }) => {
    // narrow with event.name when multiple event types are used
  }
);
```

### Full configuration keys on createFunction

`id`, `name`, `triggers`, `concurrency`, `throttle`, `idempotency` (CEL key expr; = rateLimit {limit:1, period:24h, key}), `rateLimit`, `debounce`, `priority` ({ run: <CEL returning -600..600> }), `batchEvents` ({ maxSize ≤100, timeout 1s–60s, key, if }), `retries` (0–20, default 4), `onFailure`, `cancelOn` (array of { event, match | if, timeout }), `timeouts` ({ start, finish }), `checkpointing` (or `false`).

---

## 3. Steps

All step tools memoize by **step id** (first argument). On re-execution of the function (after a step completes, a retry, or a resume), previously completed steps are NOT re-run — their recorded JSON result is returned. Everything a step returns is **serialized as JSON** (Dates become ISO strings, class instances become plain objects).

### step.run(id, handler): Promise<T>

```ts
const urls = await step.run("copy-images-to-s3", async () => {
  return copyAllImagesToS3(event.data.imageURLs);   // sync, async, or Promise-returning
});

// Parallel steps:
await Promise.all([
  step.run("create-subscription", () => {/*...*/}),
  step.run("add-to-crm", () => {/*...*/}),
]);
```

- **Retries**: each `step.run` has its OWN independent retry counter using the function's `retries` config. `retries: 4` ⇒ up to 5 attempts *per step*. A 3-step function with `retries: 4` could execute up to 15 attempts total.
- Throwing inside the handler triggers a retry of that step only; completed steps are never replayed.
- Always `await` (or `.then`) step calls.

### step.sleep(id, duration) / step.sleepUntil(id, date)

```ts
await step.sleep("wait-30m", "30m");            // ms-package string, number of ms, or Temporal.Duration
await step.sleepUntil("until-launch", new Date("2026-09-01T00:00:00Z"));
```
Sleep up to 1 year (7 days on Free plan). Sleeping runs do NOT consume concurrency.

### step.sendEvent(id, payload | payload[]): Promise<{ ids: string[] }>

Use this (not `inngest.send()`) **inside** functions for reliable, memoized delivery — this is the fan-out primitive.

```ts
const { ids } = await step.sendEvent("fan-out-items", items.map((item) => ({
  name: "app/item.process",
  data: { itemId: item.id },
})));
// ids: ULIDs like "01HQ8PTAESBZPBDS8JTRZZYY3S"
```
Max **5,000 events per call**.

### step.invoke(id, { function, data?, user?, timeout? }): Promise<Result>

RPC-style call of another Inngest function (same or different app); result is the invoked function's return value (JSON-serialized). Invoked function runs as its own run with its own retries/flow-control config.

```ts
const square = await step.invoke("compute-square-value", {
  function: computeSquare,          // imported function instance…
  data: { number: 4 },
  timeout: "1h",                    // DEFAULT IS 1 YEAR if unset (docs say this may be lowered)
});

// …or a reference (cross-app / no dep imports). v4 removed raw string function IDs.
import { referenceFunction } from "inngest";
const result = await step.invoke("call-other-app", {
  function: referenceFunction({ appId: "other-app", functionId: "compute-square" }),
  data: { number: 4 },
});
```

Failure semantics — the invoking step throws **`NonRetriableError`** (wrap in try/catch if expected) when the invoked function: is not found; exhausts its own retries and fails; hits the `timeout` (invoked run keeps running!); is skipped by its `rateLimit`; or is skipped by its `debounce` (only after timeout elapses — always set a timeout when invoking debounced functions). This prevents compounding retries in invoke chains.

Optionally declare a typed input schema on the target via the `invoke()` trigger helper:
```ts
triggers: [{ event: "image/uploaded" }, invoke({ schema: z.object({ imageUrl: z.string() }) })]
```

### step.waitForEvent(id, options): Promise<EventPayload | null>

Pauses the run until a matching event arrives or the timeout passes. **Resolves `null` on timeout** (does not throw).

```ts
// Match a field between the trigger event and the awaited event:
const approval = await step.waitForEvent("wait-for-approval", {
  event: "app/invoice.approved",     // string name OR an eventType() for typed results
  timeout: "7d",                     // ms-string | ms number | Date | Temporal.*
  match: "data.invoiceId",           // dot-path compared on BOTH events: event.data.invoiceId == async.data.invoiceId
});

// OR an arbitrary CEL expression (`event` = original trigger, `async` = incoming event).
// `match` and `if` are mutually exclusive.
const sub = await step.waitForEvent("wait-for-subscription", {
  event: "app/subscription.created",
  timeout: "30d",
  if: "event.data.userId == async.data.userId && async.data.billing_plan == 'pro'",
});

if (approval === null) { /* timed out */ }
```

CEL gotchas: the `in` operator is NOT supported in `if` — use chained `==` with `||`. Inside a `group.parallel()` race, a losing `waitForEvent` is not cancelled; it keeps the run "Running" until its timeout.

---

## 4. Flow control (config on createFunction)

### concurrency — limit concurrently executing STEPS

```ts
inngest.createFunction(
  {
    id: "sync-contacts",
    triggers: { event: "app/user.created" },
    concurrency: { limit: 10 },                       // or shorthand: concurrency: 10
  },
  async ({ event, step }) => { /* ... */ }
);

// Multiple constraints (max 2), keys, and scopes:
concurrency: [
  { scope: "account", key: `"openai"`, limit: 10 },   // account-wide virtual queue named "openai"
  { scope: "fn", key: "event.data.account_id", limit: 1 },  // per-account within this fn ("fn" is default scope)
],
```

- `limit`: max concurrently running steps (plan-capped: Free 5, Basic 25, Pro 200+, Enterprise custom). `0`/undefined = no limit.
- `scope`: `"fn"` (default) | `"env"` | `"account"` — env/account REQUIRE a `key`.
- `key`: CEL expression evaluated per triggering event; each unique value gets its own queue. To share a fixed queue, quote a literal: `key: '"openai"'`.
- Counts **executing steps**, not runs: sleeping/waiting runs don't consume slots — you can have 500 runs in flight with `concurrency: 10`.

### throttle — smooth run STARTS over time (non-lossy, FIFO)

```ts
throttle: {
  limit: 1,               // runs allowed to start per period
  period: "5s",           // 1s–7d
  burst: 2,               // extra runs allowed in a single burst (limit + burst max per window)
  key: "event.data.user_id",  // optional per-key limits
},
```
Runs over the limit are **enqueued** for later (GCRA algorithm). Applies only to run starts, not steps. Per-function (two functions with the same key have separate limits). Pair with `timeouts.start` to avoid unbounded backlogs.

### rateLimit — hard, LOSSY cap on run starts

```ts
rateLimit: {
  limit: 1,
  period: "4h",           // 1s–24h
  key: "event.data.company_id",   // optional
},
```
Events over the limit are **skipped entirely** (no run, no queueing). `idempotency: "<CEL key>"` is sugar for `rateLimit {limit:1, period:'24h', key}`.

### debounce — wait for quiet, run once with the LAST event

```ts
debounce: {
  period: "5m",           // 1s–7d (168h)
  key: "event.data.account_id",   // optional
  timeout: "30m",         // optional max total extension before it runs anyway
},
```
Each new matching event during `period` resets the timer; the run starts after `period` of silence, receiving the last event as input. **Cannot be combined with `batchEvents`.**

Summary: concurrency = cap on executing steps; throttle = pace run starts, queue the rest; rateLimit = drop excess run starts; debounce = collapse bursts into one trailing run.

---

## 5. Fan-out pattern (cron → N events → per-item function)

Recommended 2026 pattern (unchanged conceptually; v4 syntax). One scheduled producer sends a batch of events with `step.sendEvent`; a separate consumer function is triggered per event and they all run in parallel under their own flow-control config.

```ts
// producer: runs 12:00 Fri Paris time
export const prepareWeeklyDigest = inngest.createFunction(
  { id: "prepare-weekly-digest", triggers: { cron: "TZ=Europe/Paris 0 12 * * 5" } },
  async ({ step }) => {
    const users = await step.run("load-users", () => db.load("SELECT * FROM users"));

    await step.sendEvent(
      "send-digest-events",
      users.map((user) => ({
        name: "app/send.weekly.digest",
        data: { user_id: user.id, email: user.email },
      }))
    );
  }
);

// consumer: one run per event; add throttle/concurrency here as needed
export const sendWeeklyDigest = inngest.createFunction(
  {
    id: "send-weekly-digest-email",
    triggers: { event: "app/send.weekly.digest" },
    concurrency: { limit: 10 },
  },
  async ({ event }) => {
    await emailApi.send("weekly_digest", event.data.email, event.data.user_id);
  }
);
```

Why fan out instead of looping steps: **1,000 steps per function** hard limit (a step-per-item loop hits it fast); isolation (one item failing doesn't affect others); per-item retries; Bulk Replay of failures.

### Limits relevant to fan-out (usage-limits/inngest)

| Limit | Value |
|---|---|
| Events per `step.sendEvent()` / `inngest.send()` call | **5,000** |
| Single event payload size | Free 256KiB · Basic 512KiB · Pro 3MiB · Enterprise custom |
| Steps per function | 1,000 |
| Step-returned payload | 4MiB |
| Function run state (event + step + return data) | 32MiB |
| Event name length | 256 chars |
| Batch (`batchEvents`) size | maxSize 100 events, hard 10MiB |
| Step timeout | up to 2h (also bounded by your hosting provider; Vercel 10s–900s) |
| Max function run length | Free 30d · Basic 90d · Pro 366d |

For >5,000 items, chunk the `step.sendEvent` calls (e.g. one send step per 5,000).

---

## 6. Serving in Next.js App Router on Vercel

### Route handler

```ts
// app/api/inngest/route.ts
import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { prepareWeeklyDigest, sendWeeklyDigest } from "@/inngest/functions";

// Vercel: raise the route's max duration (Fluid compute; value per your plan)
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [prepareWeeklyDigest, sendWeeklyDigest],
  // streaming: true,        // see below
  // servePath: "/api/inngest", serveOrigin: "https://acme.com",  // usually inferred
});
```

- `GET` = dev-only landing page/diagnostics (`{ message, hasEventKey, hasSigningKey, functionsFound }`), `POST` = invoke function with run state, `PUT` = register/sync all functions with Inngest (authenticated by signing key).
- v4: `signingKey`, `signingKeyFallback`, `baseUrl`, `fetch` are **client** options now, NOT `serve()` options.

### Checkpointing + maxDuration (v4-specific, important)

v4 enables **checkpointing** by default: many steps execute inside a single HTTP request (much lower latency). On serverless you must cap it below the platform timeout:

```ts
export const inngest = new Inngest({
  id: "machineint",
  checkpointing: {
    maxRuntime: "240s",   // set to ~60–80% of the route's maxDuration (e.g. 240s for maxDuration=300)
    // bufferedSteps: 1, maxInterval: "10s"  // optional tuning
  },
});
```
Inngest's guidance: `maxRuntime` ≈ 60–80% of Vercel `maxDuration` (their examples: 50s for a 60s cap, 20–40% below maxDuration). When `maxRuntime` elapses the SDK returns the response and Inngest re-invokes to continue. Disable with `checkpointing: false` (client- or function-level).

### Streaming (extends effective timeout)

On **Vercel Fluid compute** (the current default compute model) or the Edge runtime, Next.js serve handlers can stream responses back to Inngest, letting execution reach up to **800s (13m20s)** on paid Vercel plans:

```ts
export const { GET, POST, PUT } = serve({ client: inngest, functions, streaming: true });
// Edge (only if not on Fluid): also `export const runtime = "edge";`
```
v4 simplified the option to `true | false` (v3's `"allow"`/`"force"` are gone); `true` throws if the handler can't stream.

### Deploy/sync with the Vercel integration

Install the official Vercel integration (vercel.com/integrations/inngest). It: (1) sets `INNGEST_SIGNING_KEY`, (2) sets `INNGEST_EVENT_KEY`, (3) **auto-syncs your app to Inngest on every deploy** (Vercel webhook → Inngest hits your `PUT /api/inngest`).

- **Deployment Protection** blocks Inngest by default. Either disable it, or enable Vercel "Protection Bypass for Automation" and paste the secret into Inngest dashboard → Settings → Integrations → Vercel → "Deployment protection key", then redeploy.
- Custom prod domain: set `INNGEST_SERVE_ORIGIN=https://acme.com` in Vercel env (otherwise Inngest uses per-deployment `*.vercel.app` URLs).
- Manual sync (no integration): Inngest Cloud UI "Sync app", or curl `PUT https://your-app.com/api/inngest`.

### Local dev

```bash
# terminal 1 — your app, in Dev Mode (v4 defaults to cloud mode!)
INNGEST_DEV=1 npm run dev            # or put INNGEST_DEV=1 in .env.local

# terminal 2 — the Dev Server (UI at http://localhost:8288)
npx inngest-cli@latest dev                       # docs often show: npx --ignore-scripts=false inngest-cli@latest dev
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest   # explicit app URL
```
- Auto-discovery scans common ports (3000…) and paths (`/api/inngest`); disable with `--no-discovery`.
- Send test events: Dev Server UI "Invoke"/"Test Event", or `curl -X POST http://localhost:8288/e/123 -d '{"name":"app/task.created","data":{...}}'` (any dummy event key works locally).
- Crons work locally; you can also Invoke them manually.
- Dev Server exposes an MCP endpoint at `http://127.0.0.1:8288/mcp`.
- Docker: `docker run -p 8288:8288 -p 8289:8289 inngest/inngest inngest dev -u http://host.docker.internal:3000/api/inngest` (app needs `INNGEST_DEV=1` and `INNGEST_BASE_URL=http://inngest:8288` in compose setups).

---

## 7. Webhook intake (third-party webhooks → Inngest events)

Inngest Cloud can BE the webhook consumer — no route in your app needed. Dashboard → **Manage → Webhooks → Create Webhook** gives you a unique intake URL of the form `https://inn.gs/e/<generated-key>`. Give that URL to the provider (Stripe, Clerk, **Parallel**, …).

### Transform functions

Each webhook has a JS **transform** (runs on Inngest's servers) that converts the raw POST body into the Inngest event shape (`name` + `data` required):

```js
// signature: (evt, headers = {}, queryParams = {}, raw) => InngestEventPayload
function transform(evt, headers = {}, queryParams = {}) {
  return {
    name: `clerk/${evt.type}`,   // convention: prefix with provider name
    data: evt.data,
    // id: evt.id,               // optional: dedupe/idempotency key
    // ts: evt.created_at * 1000 // optional ms timestamp
  };
}
```

- `headers` keys are canonicalized (`X-Github-Event` style casing); `queryParams` values are string arrays.
- Transform throws ⇒ Inngest returns **400** to the provider (provider will retry). Catching the error and returning a fallback event ⇒ **200** (provider won't retry — handle the failure event yourself).
- 4th arg `raw` is the raw body string — return it plus the signature header if you want to verify provider HMAC signatures inside your function (throw `NonRetriableError` on bad signature).
- Test transforms in the dashboard's transform tester; content types: `application/json`, plus `x-www-form-urlencoded` / `multipart/form-data` (beta; values arrive as string arrays).
- Local dev: use the dashboard's **"Send to Dev Server"** button on any received event to forward a copy to localhost. (Direct provider→Dev Server needs a tunnel.)
- Webhooks are manageable via the REST API (`https://api-docs.inngest.com` — v1 webhooks endpoints) so transforms can live in your repo.
- Branch envs share webhooks; target one with `?x-inngest-env=<branch-name>` query param or header.

### Example: Parallel `task_run.status` callbacks

Parallel (docs.parallel.ai) task runs accept `webhook: { url, event_types: ["task_run.status"] }` at task-run creation and POST `{ timestamp, type: "task_run.status", data: <TaskRun object incl. run_id, status, error, metadata> }` on completion or failure. Transform:

```js
function transform(evt, headers = {}, queryParams = {}) {
  // evt = { timestamp, type: "task_run.status", data: { run_id, status, is_active, error, processor, metadata, ... } }
  return {
    name: `parallel/${evt.type}`,          // => "parallel/task_run.status"
    data: evt.data,                        // keep the whole Task Run object
    ts: Date.parse(evt.timestamp),
  };
}
```

Then coordinate with `waitForEvent` — start a task in one step, pause until Parallel calls back:

```ts
const parallelTaskStatus = eventType("parallel/task_run.status", {
  schema: staticSchema<{ run_id: string; status: string; error: unknown }>(),
});

export const runResearch = inngest.createFunction(
  { id: "run-research", triggers: { event: "research/requested" } },
  async ({ event, step }) => {
    const run = await step.run("create-parallel-task", async () => {
      // POST https://api.parallel.ai/v1/tasks/runs with webhook.url = your inn.gs intake URL
      return createParallelTask(event.data.query);   // returns { run_id }
    });

    const done = await step.waitForEvent("wait-for-parallel", {
      event: parallelTaskStatus,
      timeout: "2h",
      // match won't work here: the trigger event has no run_id field, so use `if`
      if: `async.data.run_id == "${run.run_id}"`,
    });

    if (done === null) throw new Error("Parallel task timed out");
    if (done.data.status !== "completed") throw new NonRetriableError("Parallel task failed");
    // fetch results in a follow-up step...
  }
);
```

Note on matching: `match: "data.run_id"` requires the SAME dot-path to exist on BOTH the trigger event and the awaited event. When the correlation id is only known mid-run (like a task id created in a step), interpolate it into an `if` expression as above — CEL has no `in` operator; chain `==` with `||` if matching several ids.

---

## 8. Error handling

### Retries

- Default: **4 retries** (5 total attempts). Configure with `retries: 0..20` on the function.
- Retries apply **per step** (independent counters) AND to the function body itself when code outside steps throws.
- Backoff: exponential with jitter (Inngest's default schedule); override the next retry time by throwing `RetryAfterError`.
- `attempt` (zero-indexed) is passed to the handler; it resets after each successful step — usable for fallback logic ("after 2 OpenAI failures, try Mistral").

### Error classes (import from `"inngest"`)

```ts
import { NonRetriableError, RetryAfterError } from "inngest";

throw new NonRetriableError("Store not found", { cause: err });  // stop retries for this step/function immediately
throw new RetryAfterError("Hit Twilio rate limit", "30m");       // retry at a specific delay (ms number | ms-string | Date)
```

### Step-level failure (StepError) vs function-level failure

- When a **step** exhausts its retries, it throws a **`StepError`** into the function body. Catch it with `try/catch` (or `.catch()`) to recover — e.g. run a fallback step or rollback — and the run can still succeed. (Supported since 3.12.0.)
- If a failed step's error is NOT caught (or the function body throws and exhausts retries), the **run is marked Failed**.

```ts
try {
  data = await step.run("get-weather", () => fetch(primary));
} catch (err) {           // err instanceof StepError
  data = await step.run("get-weather-backup", () => fetch(backup));
}
```

### onFailure and the inngest/function.failed system event

```ts
inngest.createFunction(
  {
    id: "sync-shopify-products",
    triggers: { event: "shop/product_sync.requested" },
    retries: 5,
    onFailure: async ({ error, event, step, runId }) => {
      // called ONCE after all retries are exhausted
      const originalEvent = event.data.event;   // the trigger payload of the failed run
      await notifySlack(`Sync failed: ${error.toString()}`);
    },
  },
  async ({ event, step }) => { /* main handler */ }
);
```

- `onFailure` actually registers a hidden second function (shows as `"<name> (failure)"`) triggered by the system event `inngest/function.failed`.
- In `onFailure`: `error` is the deserialized last error (custom error classes come back as plain `Error` — no `instanceof` checks); `event` is the `inngest/function.failed` payload; `runId` is the failure-handler's run id — the failed run's id is `event.data.run_id`.
- Environment-wide failure handling: create a function with `triggers: { event: "inngest/function.failed" }`. Payload shape:

```json
{
  "name": "inngest/function.failed",
  "data": {
    "error": { "message": "...", "name": "Error", "stack": "..." },
    "event": { /* original trigger event of the failed run */ },
    "function_id": "<appId>-<functionId>",
    "run_id": "01H0TPSJ576QY54R6JJ8MEX6JH"
  },
  "ts": 1684523589227
}
```

There's also `inngest/function.cancelled` for cancellation cleanup.

---

## 9. Event sending API details

```ts
await inngest.send({
  id: "cart-checkout-completed-ed12c8bde",   // optional idempotency key (dedupes function triggering)
  name: "storefront/cart.checkout.completed",
  data: { cartId: "ed12c8bde" },             // arbitrary JSON
  ts: 1684274328198,                         // optional ms timestamp; FUTURE ts schedules the run (like sleepUntil) — does NOT delay waitForEvent matches
  v: "2024-05-15.1",                         // optional payload version
});
// => Promise<{ ids: string[] }>
```

- Raw HTTP ingestion (what the SDK calls): `POST https://inn.gs/e/<INNGEST_EVENT_KEY>` with the JSON payload; Dev Server: `POST http://localhost:8288/e/<any-key>`.
- v4 REMOVED `event.user` on received events (deprecated field; replay-incompatible) — put identifying fields in `data`. (`inngest.send` docs still show a `user` param for encrypted-at-rest storage, but functions should not read `event.user`; use encryption middleware for sensitive values.)
- REST API for querying events/runs: `https://api-docs.inngest.com` (e.g. `GET /v1/events/{id}`).

---

## 10. Gotchas / v3→v4 migration quick list

1. **Triggers are in the options object** (`triggers: {...}` / `[...]`), not the 2nd arg.
2. **Default mode is Cloud** — local dev silently fails without `INNGEST_DEV=1` / `isDev: true` (signing-key error).
3. `EventSchemas` on the client is GONE → `eventType()` / `staticSchema()` per event.
4. `event.user` removed from function input.
5. `serve()` no longer takes `signingKey`/`baseUrl`/`fetch`/`signingKeyFallback` — client options now.
6. `serveHost` → `serveOrigin` (env `INNGEST_SERVE_HOST` → `INNGEST_SERVE_ORIGIN`).
7. `streaming: "allow" | "force"` → `true | false`.
8. `step.invoke()` no longer accepts string function ids — pass the function or `referenceFunction()`.
9. **Checkpointing on by default** — set `checkpointing.maxRuntime` below Vercel `maxDuration`, and set `maxDuration` on the `/api/inngest` route.
10. **Optimized parallelism on by default** — `Promise.race` over steps waits for ALL to settle; use `group.parallel()` for true race semantics (losing `waitForEvent` still holds the run open until timeout).
11. `logLevel` client option removed — configure the `logger` (`new ConsoleLogger({ level: "debug" })`).
12. Docs discrepancy: the v4 createFunction page lists rateLimit period "1s to 60s", but the dedicated rate-limit reference (and its `4h` examples) says **1s–24h** — trust 1s–24h.

## UNVERIFIED / verify before relying on

- Exact plan-specific Vercel `maxDuration` ceilings (800s streaming figure is from Inngest docs for paid plans on Fluid; Vercel's own plan limits change).
- The `-p`/`--port` flag changes the Dev Server port; if you do, set `INNGEST_BASE_URL` accordingly (documented) — behavior of SDK auto-detection on non-default ports beyond that is not documented.
- Whether the webhook intake URL host is always `inn.gs` (docs consistently show `https://inn.gs/e/...`; the dashboard generates the canonical URL — copy it from there).
- `step.invoke` default timeout is documented as 1 year, with an inline docs comment saying they expect to lower it soon — don't rely on the long default; always pass `timeout`.
