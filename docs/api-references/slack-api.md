# Slack Web API Reference — DM bot + channel poster (@slack/web-api)

> Researched 2026-08-05 against live docs. Slack's developer docs now live at
> **https://docs.slack.dev** (api.slack.com/methods/* 302-redirects there).
> All Web API calls go to `https://slack.com/api/<method>`.

---

## 1. SDK: @slack/web-api

- **Current version: `8.0.0`** (published 2026-07-14). Latest 7.x is `7.19.0` (2026-07-06).
- **v8 requires Node.js >= 20** (`"engines": { "node": ">= 20", "npm": ">=9.6.4" }` — verified from the published package).
- v8 breaking changes vs v7 (from official release notes, cross-checked against the published `.d.ts`):
  - HTTP transport moved from **axios to the standard Fetch API**. Removed `WebClientOptions`: `agent`, `tls`/`TLSOptions`, `requestInterceptor`, `adapter`, `attachOriginalToWebAPIRequestError`. New `fetch?: FetchFunction` option (defaults to `globalThis.fetch`) for proxies/TLS.
  - Errors are now real `Error` subclasses extending a common `SlackError` base — prefer `instanceof WebAPIPlatformError` etc. The `ErrorCode` enum and `.code` property **still exist in 8.0.0** (verified in `dist/errors.d.ts`; `CodedError` is marked `@deprecated`), so v7-style `error.code === ErrorCode.PlatformError` checks still compile and run.
  - Removed deprecated methods: `files.upload` (use `filesUploadV2`), `rtm.start`, `workflows.stepCompleted/stepFailed/updateStep`.
  - `WebAPIHTTPError.headers` is now `Record<string, string>` (was `IncomingHttpHeaders`).

### Init + core options (verified against 8.0.0 typings)

```ts
import { WebClient, LogLevel, retryPolicies } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN, {
  // all optional:
  logLevel: LogLevel.INFO,
  retryConfig: retryPolicies.fiveRetriesInFiveMinutes, // default: ten retries in ~30 min
  rejectRateLimitedCalls: false, // default false = SDK auto-waits Retry-After and retries 429s
  timeout: 0,                    // ms; also: slackApiUrl, headers, teamId, maxRequestConcurrency, fetch
});
```

- Bot tokens start with `xoxb-`, user tokens with `xoxp-`. Auth is sent as `Authorization: Bearer <token>` (the SDK does this for you).
- Every method returns `Promise<WebAPICallResult>`-derived typed responses (e.g. `ChatPostMessageResponse`); every response has `ok: boolean` and, on failure, `error: string`.
- Rate-limit observability: `slack.on(WebClientEvent.RATE_LIMITED, (numSeconds) => ...)`.

### Error handling (v8 idiom)

```ts
import {
  WebAPIPlatformError,   // API answered ok:false → err.data.error is the Slack error string
  WebAPIRateLimitedError, // HTTP 429 (only thrown if rejectRateLimitedCalls: true) → err.retryAfter (seconds)
  WebAPIHTTPError,       // non-200 → err.statusCode, err.headers, err.body
  WebAPIRequestError,    // network failure → err.original
} from '@slack/web-api';

try {
  await slack.chat.postMessage({ channel, text });
} catch (err) {
  if (err instanceof WebAPIPlatformError) {
    switch (err.data.error) {
      case 'channel_not_found': /* bad id, or bot can't see a private channel */ break;
      case 'not_in_channel':    /* invite the bot, or add chat:write.public */ break;
    }
  } else if (err instanceof WebAPIRateLimitedError) {
    // err.retryAfter = seconds to wait
  }
}
```

---

## 2. Creating the Slack app (2026) — manifest + scopes

Create at https://api.slack.com/apps → **Create New App → From a manifest** (paste YAML or JSON). Manifests are also manageable programmatically via the App Manifest APIs (`apps.manifest.create` etc.). Top-level sections: `display_information` (required), `features`, `oauth_config`, `settings`. `features.bot_user.display_name` max 80 chars; `oauth_config.scopes.bot` max 255 scopes.

```yaml
display_information:
  name: Machine Intel Bot
  description: DMs briefs to users and posts to a channel
features:
  bot_user:
    display_name: machineint
    always_online: true
oauth_config:
  scopes:
    bot:
      - users:read          # prerequisite for users:read.email
      - users:read.email    # users.lookupByEmail
      - im:write            # conversations.open for DMs
      - chat:write          # chat.postMessage
      # - chat:write.public # optional: post to public channels w/o joining
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

After creating: **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`) from *OAuth & Permissions*.

### Scope semantics (verified on docs.slack.dev)

| Need | Scope(s) | Notes |
|---|---|---|
| Look up user by email | `users:read.email` | Docs: "This scope must be requested at the same time as `users:read`." So you need **both**. |
| Open a DM | `im:write` | `conversations.open` also accepts `channels:manage`/`groups:write`/`mpim:write` for other conversation types; for 1:1 DMs `im:write` is the one you need. |
| Send messages | `chat:write` | Grants posting only to conversations the bot is a **member** of. |
| Post to any public channel without joining | `chat:write.public` | Without it, posting to a public channel the bot hasn't been invited to fails with `not_in_channel`. DMs opened via `conversations.open` count as membership, so DMs need no extra scope. |

**Membership answer:** yes — with plain `chat:write`, the bot must be a member of a public channel to post there (invite it with `/invite @botname`, or add `chat:write.public` and reinstall). Private channels/DMs always require membership; `chat:write.public` does not cover private channels.

Changing scopes in the manifest requires **reinstalling** the app to the workspace for the new token grants to take effect.

---

## 3. users.lookupByEmail

- **Endpoint:** `GET https://slack.com/api/users.lookupByEmail` (accepts `application/x-www-form-urlencoded` or JSON)
- **Token:** bot or user. **Scope:** `users:read.email` (must be granted alongside `users:read`).
- **Rate limit:** Tier 3 (~50+/min).

| Arg | Type | Required | Notes |
|---|---|---|---|
| `email` | string | yes | Email of a user **in this workspace** |

```ts
const res = await slack.users.lookupByEmail({ email: 'jane@categoryvc.com' });
const userId = res.user!.id; // "U…" / "W…"
```

Success (abridged — `user` is a full user object):

```json
{
  "ok": true,
  "user": {
    "id": "W012A3CDE",
    "team_id": "T012AB3C4",
    "name": "spengler",
    "deleted": false,
    "real_name": "Egon Spengler",
    "is_bot": false,
    "profile": { "email": "spengler@ghostbusters.example.com", "real_name": "Egon Spengler" }
  }
}
```

Not found → `ok:false` with error **`users_not_found`** (note the plural; covers unknown email *and* deactivated users):

```json
{ "ok": false, "error": "users_not_found" }
```

Other errors: `missing_scope`, `invalid_auth`, `not_authed`, `token_expired`, `token_revoked`, `invalid_arguments`, `ratelimited`, `service_unavailable`. With the SDK, `ok:false` surfaces as a thrown `WebAPIPlatformError` (`err.data.error === 'users_not_found'`).

---

## 4. conversations.open (get a DM channel id)

- **Endpoint:** `POST https://slack.com/api/conversations.open` (form or JSON)
- **Token:** bot or user. **Bot scopes:** `im:write` (1:1 DM); `mpim:write`/`channels:manage`/`groups:write` for other types.
- **Rate limit:** Tier 3.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `users` | string | one of users/channel | Comma-separated user IDs. **1 ID → 1:1 DM**, 2–8 → MPIM. Do not include the bot's own ID. |
| `channel` | string | one of users/channel | Resume an existing DM/MPIM by its `D…`/`G…` id instead |
| `return_im` | boolean | no | Return the full IM object instead of just `{id}` |
| `prevent_creation` | boolean | no | Only check for an existing DM, don't create |

```ts
const open = await slack.conversations.open({ users: userId });
const dmChannelId = open.channel!.id; // "D…"
```

Default success: `{ "ok": true, "channel": { "id": "D069C7QFK" } }`

With `return_im: true`:

```json
{
  "ok": true, "no_op": true, "already_open": true,
  "channel": {
    "id": "D069C7QFK", "created": 1460147748, "is_im": true, "is_org_shared": false,
    "user": "U069C7QF3", "last_read": "0000000000.000000", "latest": null,
    "unread_count": 0, "unread_count_display": 0, "is_open": true, "priority": 0
  }
}
```

Key errors: `user_not_found`, `user_not_visible`, `user_disabled`, `users_list_not_supplied` (neither arg given), `not_enough_users`, `too_many_users` (>8), `invalid_user_combination`, `channel_not_found` (bad `channel` arg), `missing_scope`, `invalid_auth`, `method_not_supported_for_channel_type`.

**Shortcut:** `chat.postMessage` accepts a plain **user ID** as `channel` and opens the DM implicitly — but calling `conversations.open` first is the explicit, documented pattern and gives you a stable `D…` id to reuse. Opening a DM does **not** notify the user; only the first posted message does.

---

## 5. chat.postMessage

- **Endpoint:** `POST https://slack.com/api/chat.postMessage` (form or JSON; JSON requires `Content-Type: application/json` + Bearer header — the SDK handles this)
- **Token:** bot or user. **Scope:** `chat:write` (+ `chat:write.public` to post to un-joined public channels; `chat:write.customize` for `username`/`icon_url` overrides).

| Arg | Type | Required | Notes |
|---|---|---|---|
| `channel` | string | yes | Channel ID (`C…`), DM ID (`D…`), or user ID (`U…` → implicit DM). Prefer IDs over `#names`. |
| `text` | string | yes unless `blocks`/`attachments` | With `blocks`, `text` becomes the **notification/screen-reader fallback** — always set it. Keep ≤ ~4,000 chars. |
| `blocks` | array (or JSON-encoded string) | no | Block Kit layout, **max 50 blocks** |
| `attachments` | array | no | Legacy; max 100 |
| `thread_ts` | string | no | Parent `ts` to reply in thread (+ `reply_broadcast: true` to also show in channel) |
| `mrkdwn` | boolean | no | default `true` (applies to `text`) |
| `unfurl_links` | boolean | no | default `true` — set `false` to suppress link-preview unfurls for text URLs |
| `unfurl_media` | boolean | no | default `true` — same for media previews |
| `metadata` | object | no | `{ event_type, event_payload }` |
| `parse`, `link_names`, `username`, `icon_url`, `icon_emoji`, `markdown_text` | — | no | `markdown_text` (max 12,000 chars, standard Markdown) conflicts with `text`/`blocks` — use one style only |

Success response:

```json
{
  "ok": true,
  "channel": "C123ABC456",
  "ts": "1503435956.000247",
  "message": { "text": "…", "bot_id": "B123ABC456", "type": "message", "ts": "1503435956.000247" }
}
```

`ts` is the message's unique id within the channel — save it if you'll thread or update later.

### Block Kit brief (header / section / context / divider)

Limits (verified): **50 blocks/message** (100 in modals & Home tabs); `header.text` is `plain_text`, **max 150 chars** (headers also accept an optional `level: 1–4` field now); `section.text` is `mrkdwn` or `plain_text`, **max 3,000 chars** (a section's `fields` array: max 10 items, 2,000 chars each, rendered two-column); `context.elements`: max 10 (mrkdwn/plain_text/image); `divider` is just `{ "type": "divider" }`.

mrkdwn syntax: links `<https://example.com|display text>`, mail `<mailto:a@b.com|Email>`, user mention `<@U012AB3CD>`, channel `<#C123ABC456>`, `*bold*` `_italic_` `~strike~` `` `code` ``, triple-backtick code blocks, date `<!date^1712345678^{date_pretty}|fallback>`. Escape literal `&` `<` `>` as `&amp;` `&lt;` `&gt;`. No native bullet/numbered lists in mrkdwn — fake with `•` + newlines. (This is *not* standard Markdown: `**bold**` and `[text](url)` do NOT work.)

```ts
import type { KnownBlock } from '@slack/web-api'; // types re-exported from @slack/types

const blocks: KnownBlock[] = [
  { type: 'header', text: { type: 'plain_text', text: 'Daily Machine Intel Brief' } }, // ≤150 chars
  {
    type: 'section',
    text: {
      type: 'mrkdwn', // ≤3000 chars per section — split long briefs across sections
      text: '*Acme Robotics* raised a $40M Series B — <https://example.com/story|read the story>.',
    },
  },
  { type: 'divider' },
  {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Generated 2026-08-05 • <mailto:shri@categoryvc.com|feedback>' }],
  },
];

await slack.chat.postMessage({
  channel: dmChannelId,
  text: 'Daily Machine Intel Brief: Acme Robotics raised a $40M Series B', // fallback for notifications
  blocks,
  unfurl_links: false, // keep the brief compact — no link previews
});
```

### chat.postMessage errors

| Error | Meaning / fix |
|---|---|
| `channel_not_found` | Bad channel id — or a **private** channel the bot can't see. Use the `C…` id, not `#name`. |
| `not_in_channel` | Bot isn't a member of the channel. `/invite @bot`, or add `chat:write.public` (public channels only) and reinstall. |
| `missing_scope` | Token lacks `chat:write`. |
| `invalid_blocks` | Block JSON failed validation (check char limits, block types). |
| `msg_too_long` / `no_text` | `text` too long / nothing to post. |
| `is_archived` | Channel archived. |
| `restricted_action` | Workspace posting policy / read-only channel. |
| `rate_limited` / HTTP 429 | Slow down; honor `Retry-After`. |

---

## 6. Rate limits (current state, Aug 2026)

Evaluated **per method, per app, per workspace**, in per-minute windows. On exceeding: **HTTP 429** with `Retry-After: <seconds>` header — the SDK auto-retries unless `rejectRateLimitedCalls: true`.

| Tier | Allowance |
|---|---|
| Tier 1 | 1+/min |
| Tier 2 | 20+/min |
| Tier 3 | 50+/min (`users.lookupByEmail`, `conversations.open`) |
| Tier 4 | 100+/min |
| Special (`chat.postMessage`) | **~1 message/sec per channel**, short bursts tolerated, plus a workspace-wide ceiling of several hundred msgs/min |

### Non-Marketplace app changes (2025–2026)

- Announced 2025; **only `conversations.history` and `conversations.replies`** are affected: **1 request/min, max 15 objects per request** for non-Marketplace *distributed* apps.
- Applies to: apps created on/after **May 29, 2025** that are distributed and not Marketplace-approved, and **new installations** of existing non-Marketplace apps.
- Current changelog text says the new limits **"will not be applied to existing installations"** of non-Marketplace distributed apps. (Slack had earlier announced enforcement for existing installs on Sept 2, 2025, then March 3, 2026; the current docs no longer state an enforcement date for existing installs — treat old third-party posts citing those dates as superseded.)
- **Exempt: internal customer-built apps** (like this one — a single-workspace internal tool keeps normal tiers, i.e. 50+/min and up to 1,000 objects on history methods) and Marketplace-approved apps.
- **`chat.postMessage` was NOT changed** by this program — its 1/sec/channel special limit is longstanding and applies to *all* apps.

Practical guidance for this bot: DM-ing N users = N `chat.postMessage` calls to N *different* channels, so the 1/sec/channel limit isn't the binding constraint; the workspace-wide ceiling is. Pace bulk sends (e.g. a few per second) and rely on the SDK's default retry policy.

---

## 7. Cross-cutting error semantics

Slack always returns HTTP 200 for API-level errors — inspect `ok`/`error` (the SDK throws `WebAPIPlatformError` for you):

| Error | Where | Meaning |
|---|---|---|
| `invalid_auth` | any method | Token invalid/malformed, or request from a disallowed IP. Check the `xoxb-` token and reinstall if revoked. Related: `not_authed` (no token), `token_revoked`, `token_expired`, `account_inactive`. |
| `missing_scope` | any method | Token lacks the needed scope — add to manifest and **reinstall**. |
| `users_not_found` | `users.lookupByEmail` | No active user with that email in the workspace (also fires for deactivated users). |
| `user_not_found` / `user_not_visible` | `conversations.open` | Bad user id / user can't be messaged by this app. |
| `channel_not_found` | `chat.postMessage`, `conversations.open` | Id wrong *or* the bot has no visibility (private channel it isn't in often surfaces as this rather than `not_in_channel`). |
| `not_in_channel` | `chat.postMessage` | Bot sees the channel but isn't a member — invite it or use `chat:write.public`. |
| `ratelimited` / HTTP 429 | any | Honor `Retry-After`. |

### End-to-end flow

```ts
async function dmUserByEmail(email: string, textFallback: string, blocks: KnownBlock[]) {
  const { user } = await slack.users.lookupByEmail({ email });          // users:read.email (+users:read)
  const { channel } = await slack.conversations.open({ users: user!.id! }); // im:write
  return slack.chat.postMessage({                                       // chat:write
    channel: channel!.id!,
    text: textFallback,
    blocks,
    unfurl_links: false,
  });
}
```

---

## Sources

- https://docs.slack.dev/reference/methods/users.lookupByEmail
- https://docs.slack.dev/reference/methods/conversations.open
- https://docs.slack.dev/reference/methods/chat.postMessage
- https://docs.slack.dev/apis/web-api/rate-limits/
- https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/
- https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/
- https://docs.slack.dev/reference/block-kit/blocks/section-block, /header-block, /context-block; https://docs.slack.dev/block-kit
- https://docs.slack.dev/messaging/formatting-message-text
- https://docs.slack.dev/reference/scopes/users.read.email
- https://docs.slack.dev/app-manifests/ ; https://docs.slack.dev/reference/app-manifest
- https://docs.slack.dev/tools/node-slack-sdk/web-api
- https://github.com/slackapi/node-slack-sdk/releases (@slack/web-api@8.0.0 notes)
- npm registry + published `@slack/web-api@8.0.0` typings (`dist/errors.d.ts`, `dist/WebClient.d.ts`, `package.json` engines)
