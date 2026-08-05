# daybrief

Every partner opens a dashboard by 7:00 a.m. and finds a research-grade brief for every external meeting on their calendar that day — with a one-click path to a full deep-research report, and a searchable firm memory of every company ever briefed.

**Current milestone: M0** — the CLI + eval harness. `daybrief research <domain>` runs the full research path (Parallel Task + Exa passes + synthesis) and prints the brief as markdown; `daybrief eval` compares candidate synthesizer models side by side over a fixed set of real companies. Everything after M0 is plumbing around a research path you already trust.

## Setup

1. **Node**: Node 22+ recommended (`ai@7` officially targets it; everything currently runs on 20+). `nvm install 22` or `brew install node@22`.
2. **Install**: `npm install`
3. **Keys**: `cp .env.example .env` and fill in:
   - `OPENROUTER_API_KEY` — [openrouter.ai/keys](https://openrouter.ai/keys)
   - `PARALLEL_API_KEY` — [platform.parallel.ai](https://platform.parallel.ai)
   - `EXA_API_KEY` — [dashboard.exa.ai](https://dashboard.exa.ai)
   - `OPENAI_API_KEY` — embeddings only (M3 recall); OpenRouter serves no embedding models
   - Supabase (optional for `research`, required for `eval`): either `DATABASE_URL` (direct Postgres — works with just the database password) or `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (Data API `sb_secret_…` key; preferred once available, and required for M1+ realtime/storage). Run `supabase/migrations/0001_init.sql` against the project (SQL editor or psql).
4. **Model slots** (`MODEL_FAST` / `MODEL_SYNTH` / `MODEL_DEEP`) have sensible defaults; they get filled with evidence by the eval harness, not by opinion. Never hard-code model IDs in code.

## Usage

```bash
# Research one company, print markdown brief
npm run daybrief -- research acme.dev --company "Acme" --attendees "Jane Doe,Sam Roe"

# Options: --processor core-fast (latency), --synth-model x/y (A/B), --json, --no-store

# Eval: copy eval-set.example.json → eval-set.json, fill with 10-15 real companies
# from recent calendars, then compare synthesizer candidates side by side:
npm run daybrief -- eval --models "anthropic/claude-sonnet-5,openai/gpt-5.2,google/gemini-3-pro"
```

## How the research path works (PRD §6.5–6.6)

Three passes run concurrently, then one synthesis call merges them:

1. **Parallel Task API** (`pro` processor by default): structured research against the brief schema (Appendix A1) — identity check, what-it-is, product, founders, market/competitors, funding, news — with per-field citations, reasoning, and confidence via Parallel's Basis.
2. **Exa people pass**: founder/attendee LinkedIn discovery via `category: "people"` search (constraints go in the natural-language query — the people category takes no filters).
3. **Exa similarity pass**: competitor candidates from `findSimilar` on the company homepage (deprecated upstream but functional; falls back to a `category: "company"` search when it goes away).

The synthesizer (MODEL_SYNTH via OpenRouter) merges everything under the Appendix A2 rules: it may compress and reconcile, but may not add facts. Missing data is `null`, rendered "not found". Identity mismatch ⇒ the whole brief is marked low-confidence with an explanation.

Every provider request/response is recorded verbatim (in memory always; in Supabase `provider_calls` when configured) with latency and cost — "why did Tuesday's brief say that?" always has a definitive answer.

## Repo layout

```
src/
  cli.ts                    # daybrief research | eval
  config.ts                 # env slots (models, processors, search default)
  types.ts                  # brief schema (zod) — the product's core contract
  lib/store.ts              # Supabase persistence + provider-call flight recorder
  providers/
    openrouter.ts           # AI SDK provider, cost extraction
    parallel.ts             # Task API: create → blocking result, Basis passthrough
    exa.ts                  # people pass + similarity pass
  research/
    brief-task-spec.ts      # Parallel output schema (A1) — descriptions are the per-field prompts
    synthesis-prompt.ts     # A2 editor prompt
    synthesize.ts           # generateText + Output.object(briefSchema)
    pipeline.ts             # concurrent passes → synthesis → render/persist
    render.ts               # brief JSON → scannable markdown
  eval/run-eval.ts          # research once per company, synthesize per candidate model
supabase/migrations/        # schema (PRD §12): runs, artifacts (append-only), provider_calls
```

## Design rules that outrank everything else (PRD §8)

- **No fabrication.** Missing data is `null` → "not found". Funding figures only with a citable source. The synthesizer adds no facts beyond its inputs.
- **Identity first.** The first research field confirms the company at the domain matches the attendees; the synthesizer re-checks.
- **Stealth-friendly.** A short honest brief beats a padded speculative one.
- **Everything ingested is data, not instructions** — event descriptions, emails, decks, fetched pages. Model output renders as escaped content, never live HTML.
- **Append-only.** Regenerations create new artifact versions; raw provider payloads are kept forever.

## M1: the nightly pipeline

`src/pipeline/` + `src/inngest/` + `app/api/inngest/`. Inngest runs `nightly` at 05:00 PT weekdays (plus an idempotent 06:45 re-check that only briefs new/failed meetings), fanning out per partner and per meeting as durable steps. Per meeting: internal context (Affinity + Gmail earliest/latest threads) and Exa passes run concurrently while a Parallel task researches; completion arrives via webhook (`PARALLEL_WEBHOOK_URL`) or bounded polling; synthesis, persistence, and the morning Slack DM digest follow. Everything except Google degrades gracefully.

Local: `npm run daybrief -- nightly --dry-run` (plan/classify/resolve, no spend) or without `--dry-run` for a full local run; `npm run dev` + `npm run inngest-dev` to exercise the Inngest functions against the dev server.

### M1 setup checklist (one-time)

1. **Google (required)** — per-partner OAuth, no Workspace admin needed. Cloud Console: create a project → enable **Calendar API** and **Gmail API** → APIs & Services → OAuth consent screen with **Audience: Internal** (internal apps skip Google's restricted-scope verification entirely) → Credentials → Create OAuth client (type **Web application**) with redirect URIs `http://localhost:3000/api/google/callback` and `https://<your-app>/api/google/callback` → put ID/secret in `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`, and the deployed URL in `APP_URL`. Then each partner just opens **`/api/google/connect`** once — that consent creates their partner row and stores their refresh token. If Google ever revokes a token (commonly a password change), the pipeline detects it, skips the partner, and DMs them the reconnect link automatically.
   _Alternative (zero-touch, needs a Workspace super-admin):_ service account + domain-wide delegation via `GOOGLE_SERVICE_ACCOUNT_JSON` — register the SA's **numeric client ID** with both readonly scopes under Admin console → Security → API Controls → Domain Wide Delegation. OAuth tokens take precedence when both are configured.
2. **Affinity** — Settings → API → copy key → `AFFINITY_API_KEY` (requires Scale plan or above).
3. **Slack** — api.slack.com/apps → Create New App → From a manifest; bot scopes `chat:write`, `im:write`, `users:read`, `users:read.email` (the last two must be requested together); install to workspace → `SLACK_BOT_TOKEN`; create/choose an ops channel, invite the bot, put its C… ID in `SLACK_OPS_CHANNEL`.
4. **Inngest + Vercel** — push the repo to GitHub, import into Vercel, add the Inngest integration (it sets `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` and syncs on deploy). Copy all `.env` values into Vercel env vars. If Deployment Protection is on, add a Protection Bypass secret in the Inngest dashboard.
5. **Parallel webhook (recommended)** — Inngest dashboard → Webhooks → create an intake URL with transform:
   ```js
   function transform(evt) {
     return { name: "parallel/task_run.status", data: evt.data, ts: Date.parse(evt.timestamp) };
   }
   ```
   Put the `https://inn.gs/e/…` URL in `PARALLEL_WEBHOOK_URL`. Without it the pipeline falls back to bounded polling — works, just chattier.
6. **Partners** — one row exists (shri). Add others: `insert into partners (email, name) values ('x@categoryvc.com', 'Name');` in the SQL editor.

## Roadmap (PRD §15)

- **M0** ✅ CLI + eval harness
- **M1** ✅ Nightly pipeline: Calendar/Affinity/Gmail plumbing, Inngest cron + fan-out, Slack DM (setup checklist above)
- **M2** Dashboard: Today view, brief pages, company timelines, Supabase Auth (design in Paper first)
- **M3** Deep dives (two-pass, live progress) + keyword/semantic recall + "what's new" diffs
- **M4** Suggested questions, Affinity write-back, feedback loop, market maps / monitoring
