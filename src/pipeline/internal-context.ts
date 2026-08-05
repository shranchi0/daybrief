import { affinityOrgByDomain, type AffinityOrgContext } from "../integrations/affinity";
import { fetchGmailContext, googleConfigured, type GmailContext } from "../integrations/google";
import { env } from "../config";
import { log } from "../lib/log";
import type { Recorder } from "../lib/store";

/**
 * Internal context (PRD §6.4): Affinity org record + earliest/latest Gmail
 * threads. Every source degrades gracefully — missing internal context makes
 * the brief thinner, never absent. Granola (prior meeting notes) is a v1.1
 * addition; the shape reserves a slot for it.
 */

export interface InternalContext {
  affinity: AffinityOrgContext | null;
  gmail: GmailContext | null;
  granola: null; // reserved
  deck_link: string | null;
}

export async function gatherInternalContext(opts: {
  partnerEmail: string;
  domain: string;
  recorder: Recorder;
}): Promise<InternalContext> {
  const [affinity, gmail] = await Promise.allSettled([
    env().AFFINITY_API_KEY ? affinityOrgByDomain(opts.domain, opts.recorder) : Promise.resolve(null),
    googleConfigured() ? fetchGmailContext(opts.partnerEmail, opts.domain) : Promise.resolve(null),
  ]);

  if (affinity.status === "rejected") {
    log.warn(`Affinity context failed for ${opts.domain}: ${String(affinity.reason)}`);
  }
  if (gmail.status === "rejected") {
    log.warn(`Gmail context failed for ${opts.domain}: ${String(gmail.reason)}`);
  }

  const gmailCtx = gmail.status === "fulfilled" ? gmail.value : null;
  const deckAttachment = [gmailCtx?.latestThread, gmailCtx?.earliestThread]
    .flatMap((t) => t?.attachments ?? [])
    .find((a) => /\.(pdf|key|pptx?)$/i.test(a.filename));

  const gmailRecord = gmailCtx
    ? { earliest: gmailCtx.earliestThread?.threadId ?? null, latest: gmailCtx.latestThread?.threadId ?? null }
    : null;
  await opts.recorder.record({
    provider: "google",
    request: { lookup: "gmail_context", domain: opts.domain, partner: opts.partnerEmail },
    response: gmailCtx ?? { unavailable: true },
    model_or_processor: null,
    tokens: null,
    cost_usd: null,
    latency_ms: 0,
    created_at: new Date().toISOString(),
  });
  void gmailRecord;

  return {
    affinity: affinity.status === "fulfilled" ? affinity.value : null,
    gmail: gmailCtx,
    granola: null,
    deck_link: deckAttachment
      ? (gmailCtx?.latestThread?.attachments.includes(deckAttachment)
          ? gmailCtx.latestThread.gmailLink
          : gmailCtx?.earliestThread?.gmailLink) ?? null
      : null,
  };
}

/** True when there is any internal signal worth handing to the synthesizer. */
export function hasInternalSignal(ctx: InternalContext): boolean {
  return Boolean(ctx.affinity || ctx.gmail?.earliestThread || ctx.gmail?.latestThread);
}
