import { env } from "../config";
import { affinityOrgByDomain, type AffinityOrgContext } from "../integrations/affinity";
import {
  dateInTimezone,
  fetchDaysEvents,
  GoogleNotConnectedError,
  isGoogleAuthRevoked,
  type CalendarEvent,
} from "../integrations/google";
import { briefBlocks, dmPartner, postOps } from "../integrations/slack";
import { log } from "../lib/log";
import {
  briefFromArtifact,
  claimGoogleNudge,
  claimMeeting,
  companyIdByDomain,
  googleRefreshToken,
  latestBrief,
  markGoogleDisconnected,
  meetingsByEventIds,
  priorMeetingCount,
  setMeetingOutcome,
  upsertMeeting,
  type Partner,
} from "../lib/pipeline-store";
import { Recorder } from "../lib/store";
import { gatherResearch, synthesizeAndRender } from "../research/pipeline";
import type { Brief } from "../types";
import { classifyMeeting, type Classification } from "./classify";
import { gatherInternalContext, hasInternalSignal } from "./internal-context";
import { resolveFromAttendeeDomains, splitAttendees, type DomainResolution } from "./resolve";

/**
 * The nightly pipeline core (PRD §6), shaped as phases the Inngest functions
 * and the CLI `daybrief nightly` share:
 *  - planPartnerDay: calendar → classify → resolve → meetings rows
 *  - claim + briefPlannedMeeting: internal context + research + synthesis
 *  - deliverPartnerDigest: morning Slack DMs, meetings marked delivered
 *
 * Meeting status machine: pending → briefing (claimed) → briefed (artifact
 * saved) → delivered (DM sent). failed and stale briefing claims are
 * reclaimable; briefed/delivered are terminal for research (a briefed row only
 * needs redelivery). The 06:45 recheck therefore never re-briefs or re-pays.
 */

export interface PlannedMeeting {
  meetingId: string;
  partner: Partner;
  event: CalendarEvent;
  classification: Classification;
  resolution: DomainResolution;
  /** Affinity context fetched during planning (classification needs it). */
  affinity: AffinityOrgContext | null;
  /** true when this meeting still needs research. */
  briefable: boolean;
  /** Artifact exists but was never DM'd (e.g. delivery failed) — redeliver. */
  needsDelivery: boolean;
  existingBriefArtifactId: string | null;
  meetingDate: string;
}

const CLAIM_STALE_MS = 2 * 60 * 60 * 1000;

export interface GoogleAuthFailure {
  message: string;
  /** The partner's dead OAuth token was cleared and a service account exists — retry once, it will take the SA path. */
  saFallback: boolean;
}

/**
 * Classify partner-level Google auth failures. Returns null for anything that
 * isn't a connect problem (including service-account invalid_grant from key
 * rotation/clock skew, which is transient — callers rethrow so retries engage).
 * Revoked OAuth tokens are cleared; the reconnect DM is rate-limited to one per
 * 72h and can never throw.
 */
export async function handleGoogleAuthFailure(partner: Partner, e: unknown): Promise<GoogleAuthFailure | null> {
  const notConnected = e instanceof GoogleNotConnectedError;
  let revoked = false;
  if (!notConnected) {
    if (!isGoogleAuthRevoked(e)) return null;
    // invalid_grant only means "partner token revoked" when a token exists;
    // the SA path emits the same string transiently.
    const hadToken = (await googleRefreshToken(partner.email).catch(() => null)) !== null;
    if (!hadToken) return null;
    revoked = true;
    await markGoogleDisconnected(partner.email).catch(() => {});
  }

  const saFallback = revoked && Boolean(env().GOOGLE_SERVICE_ACCOUNT_JSON);
  const link = `${env().APP_URL}/api/google/connect`;
  if (await claimGoogleNudge(partner.email).catch(() => false)) {
    await dmPartner(
      partner.email,
      saFallback
        ? `Your Google connection was revoked (often a password change). daybrief switched to the firm's service-account access, so briefs continue. Reconnect any time to use your own consent again: ${link}`
        : `daybrief can't read your Google Calendar${revoked ? " anymore (access was revoked — often a password change)" : ""}. Reconnect in 10 seconds: ${link}`,
    ).catch((err) => log.warn(`reconnect DM to ${partner.email} failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return { message: e instanceof Error ? e.message : String(e), saFallback };
}

export async function planPartnerDay(partner: Partner, date?: string): Promise<PlannedMeeting[]> {
  const day = date ?? dateInTimezone(partner.timezone);
  const events = await fetchDaysEvents(partner.email, partner.timezone, day);
  log.step(`${partner.email}: ${events.length} event(s) on ${day}`);

  const existing = await meetingsByEventIds(
    partner.id,
    events.map((e) => e.gcalEventId),
  );

  const planned: PlannedMeeting[] = [];
  for (const event of events) {
    const prior = existing.get(event.gcalEventId);
    const claimFresh =
      prior?.status === "briefing" &&
      prior.briefingStartedAt !== null &&
      Date.now() - new Date(prior.briefingStartedAt).getTime() < CLAIM_STALE_MS;
    const terminal = prior?.status === "briefed" || prior?.status === "delivered" || claimFresh;

    const { external } = splitAttendees(event.attendees, env().FIRM_DOMAIN);
    const resolution = resolveFromAttendeeDomains(external);

    // Affinity signals inform classification (portfolio/LP/follow-up).
    let affinity: AffinityOrgContext | null = null;
    if (resolution.domain && env().AFFINITY_API_KEY) {
      affinity = await affinityOrgByDomain(resolution.domain).catch((e) => {
        log.warn(`Affinity lookup failed for ${resolution.domain}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
    }

    const companyId = resolution.domain ? await companyIdByDomain(resolution.domain) : null;
    const priorCount = companyId ? await priorMeetingCount(companyId, day) : 0;

    const classification = await classifyMeeting({
      externalAttendees: external,
      title: event.title,
      description: event.description,
      onPortfolioList: affinity?.onPortfolioList ?? false,
      onLpList: affinity?.onLpList ?? false,
      priorMeetingCount: priorCount,
      affinityFirstInteraction: affinity?.firstInteraction ?? null,
    });

    const briefable =
      !terminal &&
      classification.classification !== "internal" &&
      classification.classification !== "other" &&
      resolution.domain !== null;

    let meetingId: string;
    if (prior && terminal) {
      // Never touch a terminal/claimed row — the upsert would clobber its status.
      meetingId = prior.id;
    } else {
      meetingId = await upsertMeeting({
        gcalEventId: event.gcalEventId,
        partnerId: partner.id,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        title: event.title,
        classification: classification.classification === "internal" ? "internal" : classification.classification,
        classificationConfidence: classification.confidence,
        companyId,
        resolvedDomain: resolution.domain,
        resolutionConfidence: resolution.confidence,
        meetingDate: day,
        status:
          classification.classification === "internal"
            ? "skipped_internal"
            : classification.classification === "other"
              ? "skipped_other"
              : resolution.domain === null
                ? "unresolved"
                : prior?.status === "failed"
                  ? "failed"
                  : "pending",
        rawEvent: event.raw,
      });
    }

    planned.push({
      meetingId,
      partner,
      event,
      classification,
      resolution,
      affinity,
      briefable,
      needsDelivery: prior?.status === "briefed" && prior.briefArtifactId !== null,
      existingBriefArtifactId: prior?.briefArtifactId ?? null,
      meetingDate: day,
    });
  }
  return planned;
}

export interface MeetingBriefOutcome {
  meetingId: string;
  domain: string | null;
  title: string;
  startsAt: string;
  classification: string;
  ok: boolean;
  brief?: Brief;
  artifactId?: string | null;
  error?: string;
  costUsd: number;
}

/**
 * Brief one planned meeting end to end (CLI path — the Inngest function runs
 * the same work as separate durable steps). Claims the meeting first so a
 * concurrent run can't double-brief. Freshness policy (PRD §6): every meeting
 * gets fresh research — no cache; the previous brief version feeds "what's new".
 */
export async function briefPlannedMeeting(item: PlannedMeeting): Promise<MeetingBriefOutcome> {
  const base = {
    meetingId: item.meetingId,
    domain: item.resolution.domain,
    title: item.event.title,
    startsAt: item.event.startsAt,
    classification: item.classification.classification,
  };
  if (!item.briefable || !item.resolution.domain) {
    return { ...base, ok: false, error: `not briefable (${item.classification.classification}/${item.resolution.confidence})`, costUsd: 0 };
  }
  if (!(await claimMeeting(item.meetingId))) {
    return { ...base, ok: false, error: "not briefable (claimed by another run)", costUsd: 0 };
  }
  const domain = item.resolution.domain;

  const recorder = new Recorder("brief");
  try {
    // Inside the try: a run-row failure after the claim must still mark the
    // meeting failed (reclaimable) rather than leaving the claim dangling.
    await recorder.startRun();
    const [internalContext, previousBrief] = await Promise.all([
      gatherInternalContext({ partnerEmail: item.partner.email, domain, recorder }),
      latestBrief(domain).catch(() => null),
    ]);

    const attendees = item.resolution.externalAttendees.map((a) => a.displayName ?? a.email.split("@")[0] ?? "").filter(Boolean);
    const bundle = await gatherResearch({
      domain,
      companyName: item.affinity?.name,
      attendees,
      recorder,
      internalContext: hasInternalSignal(internalContext) ? internalContext : null,
      previousBrief,
    });
    const { brief, markdown } = await synthesizeAndRender(bundle, { recorder });

    const artifactId = await recorder.saveArtifact({
      kind: "brief",
      domain,
      companyName: brief.company_name,
      content: { brief, meeting_id: item.meetingId, partner_email: item.partner.email },
      contentMd: markdown,
    });
    const companyId = await companyIdByDomain(domain);
    await setMeetingOutcome(item.meetingId, { status: "briefed", briefArtifactId: artifactId, companyId });
    await recorder.finishRun("succeeded", { domain, meeting_id: item.meetingId });

    return { ...base, ok: true, brief, artifactId, costUsd: recorder.totalCostUsd };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setMeetingOutcome(item.meetingId, { status: "failed" }).catch(() => {});
    await recorder.finishRun("failed", { domain, error: message }).catch(() => {});
    return { ...base, ok: false, error: message, costUsd: recorder.totalCostUsd };
  }
}

/** Morning Slack DM: header + one compact brief per meeting; each DM'd meeting is marked delivered. */
export async function deliverPartnerDigest(partner: Partner, outcomes: MeetingBriefOutcome[], day: string): Promise<void> {
  const briefed = outcomes.filter((o) => o.ok && o.brief);
  const failed = outcomes.filter((o) => !o.ok && !o.error?.startsWith("not briefable"));

  const headline = `daybrief · ${day}: ${briefed.length} brief(s)${failed.length ? `, ${failed.length} failed` : ""}`;
  await dmPartner(partner.email, headline);

  for (const o of briefed) {
    const time = o.startsAt
      ? new Intl.DateTimeFormat("en-US", { timeZone: partner.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(o.startsAt))
      : null;
    const sent = await dmPartner(
      partner.email,
      `${o.brief!.company_name}: ${o.brief!.one_liner}`,
      briefBlocks(o.brief!, { time, videoLink: null, classification: o.classification }),
    );
    if (sent) await setMeetingOutcome(o.meetingId, { status: "delivered" }).catch(() => {});
  }
}

/** Briefed-but-undelivered meetings from a previous run, loaded for redelivery. */
export async function redeliveryOutcomes(planned: PlannedMeeting[]): Promise<MeetingBriefOutcome[]> {
  const outcomes: MeetingBriefOutcome[] = [];
  for (const p of planned.filter((x) => x.needsDelivery && x.existingBriefArtifactId)) {
    const brief = await briefFromArtifact(p.existingBriefArtifactId!).catch(() => null);
    if (brief) {
      outcomes.push({
        meetingId: p.meetingId,
        domain: p.resolution.domain,
        title: p.event.title,
        startsAt: p.event.startsAt,
        classification: p.classification.classification,
        ok: true,
        brief,
        artifactId: p.existingBriefArtifactId,
        costUsd: 0,
      });
    }
  }
  return outcomes;
}

/** Full sequential run for one partner (CLI path; Inngest fans out instead). */
export async function runPartnerDay(partner: Partner, date?: string, opts?: { dryRun?: boolean }): Promise<MeetingBriefOutcome[]> {
  const day = date ?? dateInTimezone(partner.timezone);
  let planned: PlannedMeeting[];
  try {
    planned = await planPartnerDay(partner, day);
  } catch (e) {
    const failure = await handleGoogleAuthFailure(partner, e);
    if (failure === null) throw e;
    if (failure.saFallback) {
      // Dead token was cleared — this retry takes the service-account path.
      planned = await planPartnerDay(partner, day);
    } else {
      log.warn(`${partner.email}: skipped — ${failure.message}`);
      await postOps(`daybrief ${day} · ${partner.email}: SKIPPED — Google not connected`);
      return [];
    }
  }
  for (const p of planned) {
    log.detail(
      `${p.event.title} → ${p.classification.classification}/${p.classification.confidence}, domain=${p.resolution.domain ?? "unresolved"} ${p.briefable ? "(will brief)" : p.needsDelivery ? "(redeliver)" : "(skip)"}`,
    );
  }
  if (opts?.dryRun) {
    return planned.map((p) => ({
      meetingId: p.meetingId,
      domain: p.resolution.domain,
      title: p.event.title,
      startsAt: p.event.startsAt,
      classification: p.classification.classification,
      ok: false,
      error: "dry run",
      costUsd: 0,
    }));
  }

  const outcomes: MeetingBriefOutcome[] = [];
  for (const item of planned.filter((p) => p.briefable)) {
    log.step(`Briefing ${item.resolution.domain} …`);
    outcomes.push(await briefPlannedMeeting(item));
  }
  outcomes.push(...(await redeliveryOutcomes(planned)));

  await deliverPartnerDigest(partner, outcomes, day);
  const spend = outcomes.reduce((s, o) => s + o.costUsd, 0);
  await postOps(
    `daybrief ${day} · ${partner.email}: ${outcomes.filter((o) => o.ok).length}/${outcomes.length} briefed, $${spend.toFixed(2)} spend, ${planned.length - outcomes.length} skipped`,
  );
  return outcomes;
}
