import { WebClient } from "@slack/web-api";
import { env } from "../config";
import { log } from "../lib/log";
import type { Brief } from "../types";

/**
 * Slack delivery: morning DM per partner, run summary to the ops channel.
 * Degrades to log-only when SLACK_BOT_TOKEN is absent, so the pipeline never
 * fails because Slack isn't set up yet.
 */

let client: WebClient | null = null;

function slack(): WebClient | null {
  const token = env().SLACK_BOT_TOKEN;
  if (!token) return null;
  if (!client) client = new WebClient(token);
  return client;
}

const userIdCache = new Map<string, string>();

async function userIdByEmail(email: string): Promise<string | null> {
  const web = slack();
  if (!web) return null;
  const cached = userIdCache.get(email);
  if (cached) return cached;
  try {
    const res = await web.users.lookupByEmail({ email });
    const id = res.user?.id ?? null;
    if (id) userIdCache.set(email, id);
    return id;
  } catch (e) {
    log.warn(`Slack lookupByEmail failed for ${email}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** mrkdwn is not Markdown: links are <url|text>, bold is *text*. */
function md(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CONF = { high: "●●●", medium: "●●○", low: "●○○" } as const;

/** Compact Block Kit rendering of a brief for the morning DM. */
export function briefBlocks(brief: Brief, meta: { time: string | null; videoLink: string | null; classification: string }): unknown[] {
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `${brief.company_name} — ${brief.domain}`.slice(0, 150) } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: [meta.time, meta.classification, `confidence ${CONF[brief.overall_confidence]}`, meta.videoLink ? `<${meta.videoLink}|join>` : null]
            .filter(Boolean)
            .join("  ·  "),
        },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*${md(brief.one_liner)}*`.slice(0, 3000) } },
  ];

  if (!brief.identity.verified) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `:warning: *Identity not verified.* ${md(brief.identity.note ?? "")}`.slice(0, 3000) } });
  }

  const fields: string[] = [];
  if (brief.what_it_is) fields.push(`*What it is:* ${md(brief.what_it_is.text)}`);
  if (brief.founders.length > 0) {
    const founders = brief.founders
      .map((f) => `${md(f.name)}${f.title ? ` (${md(f.title)})` : ""}${f.linkedin_url ? ` — <${f.linkedin_url}|LinkedIn>` : ""}`)
      .join("; ");
    fields.push(`*Founders:* ${founders}`);
  }
  fields.push(`*Intro:* ${brief.how_we_got_introduced ? md(brief.how_we_got_introduced.text) : "_No record — ask._"}`);
  if (brief.funding_history && brief.funding_history.rounds.length > 0) {
    const rounds = brief.funding_history.rounds
      .map((r) => [r.stage, r.date, r.amount, r.lead_investors.length ? `led by ${r.lead_investors.join(", ")}` : null].filter(Boolean).join(" · "))
      .join(" | ");
    fields.push(`*Funding:* ${md(rounds)}`);
  } else {
    fields.push("*Funding:* _no public record_");
  }
  if (brief.market_and_competitors && brief.market_and_competitors.competitors.length > 0) {
    fields.push(`*Competitors:* ${md(brief.market_and_competitors.competitors.map((c) => c.name).join(", "))}`);
  }
  if (brief.whats_new) fields.push(`*What's new:* ${md(brief.whats_new)}`);

  for (const f of fields) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: f.slice(0, 3000) } });
  }
  blocks.push({ type: "divider" });
  return blocks;
}

export async function dmPartner(email: string, text: string, blocks?: unknown[]): Promise<boolean> {
  const web = slack();
  if (!web) {
    log.warn(`Slack not configured — DM to ${email} skipped: ${text.slice(0, 120)}`);
    return false;
  }
  const userId = await userIdByEmail(email);
  if (!userId) return false;
  // A raw user ID as channel opens the DM implicitly.
  await web.chat.postMessage({ channel: userId, text, ...(blocks ? { blocks: blocks as never } : {}) });
  return true;
}

export async function postOps(text: string): Promise<void> {
  const web = slack();
  const channel = env().SLACK_OPS_CHANNEL;
  if (!web || !channel) {
    log.warn(`Slack ops not configured — summary: ${text}`);
    return;
  }
  try {
    await web.chat.postMessage({ channel, text });
  } catch (e) {
    log.warn(`Slack ops post failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
