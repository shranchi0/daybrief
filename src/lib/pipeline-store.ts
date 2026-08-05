import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { env } from "../config";
import type { Brief } from "../types";

/**
 * Partner/meeting/company queries for the nightly pipeline (M1). Requires the
 * Supabase Data API (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) — the nightly
 * runs server-side where that's always configured.
 */

let client: SupabaseClient | null = null;

function db(): SupabaseClient {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Nightly pipeline requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.");
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: ws as never },
    });
  }
  return client;
}

export interface Partner {
  id: string;
  email: string;
  name: string;
  timezone: string;
  slack_user_id: string | null;
}

export async function activePartners(): Promise<Partner[]> {
  const { data, error } = await db().from("partners").select("id, email, name, timezone, slack_user_id").eq("active", true);
  if (error) throw new Error(`partners query failed: ${error.message}`);
  return data;
}

/** Refresh token for the per-partner Google OAuth path. */
export async function googleRefreshToken(email: string): Promise<string | null> {
  const { data, error } = await db().from("partners").select("google_refresh_token").eq("email", email).maybeSingle();
  if (error) throw new Error(`partner token lookup failed: ${error.message}`);
  return (data?.google_refresh_token as string | null) ?? null;
}

/**
 * Store a partner's refresh token from a completed OAuth flow. Update-then-
 * insert on purpose: reconnecting must only refresh token fields — it must
 * never reactivate a deliberately deactivated partner or clobber a curated
 * name. First-time connects create the row (active defaults true).
 */
export async function connectPartnerGoogle(opts: { email: string; name: string; refreshToken: string }): Promise<void> {
  const patch = {
    google_refresh_token: opts.refreshToken,
    gcal_connected_at: new Date().toISOString(),
    google_nudged_at: null,
  };
  const { data, error } = await db().from("partners").update(patch).eq("email", opts.email).select("id");
  if (error) throw new Error(`partner connect failed: ${error.message}`);
  if ((data?.length ?? 0) > 0) return;

  const { error: insertError } = await db().from("partners").insert({ email: opts.email, name: opts.name, ...patch });
  if (insertError?.code === "23505") {
    // Lost a concurrent-insert race — fall back to the token-only update.
    const { error: updateError } = await db().from("partners").update(patch).eq("email", opts.email);
    if (updateError) throw new Error(`partner connect failed: ${updateError.message}`);
  } else if (insertError) {
    throw new Error(`partner connect failed: ${insertError.message}`);
  }
}

/**
 * Claim the right to send a reconnect nudge; at most one per cooldown window,
 * race-safe across the 05:00/06:45 crons via conditional UPDATE.
 */
export async function claimGoogleNudge(email: string, hours = 72): Promise<boolean> {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const { data, error } = await db()
    .from("partners")
    .update({ google_nudged_at: new Date().toISOString() })
    .eq("email", email)
    .or(`google_nudged_at.is.null,google_nudged_at.lt.${cutoff}`)
    .select("id");
  if (error) throw new Error(`nudge claim failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Token revoked (password change, manual revoke): clear it so the ops loop nudges a reconnect. */
export async function markGoogleDisconnected(email: string): Promise<void> {
  const { error } = await db()
    .from("partners")
    .update({ google_refresh_token: null, gcal_connected_at: null })
    .eq("email", email);
  if (error) throw new Error(`partner disconnect failed: ${error.message}`);
}

export async function upsertMeeting(row: {
  gcalEventId: string;
  partnerId: string;
  startsAt: string;
  endsAt: string;
  title: string;
  classification: string;
  classificationConfidence: string;
  companyId: string | null;
  resolvedDomain: string | null;
  resolutionConfidence: string;
  meetingDate: string;
  status: string;
  rawEvent: unknown;
}): Promise<string> {
  const { data, error } = await db()
    .from("meetings")
    .upsert(
      {
        gcal_event_id: row.gcalEventId,
        partner_id: row.partnerId,
        starts_at: row.startsAt,
        ends_at: row.endsAt,
        title: row.title,
        classification: row.classification,
        classification_confidence: row.classificationConfidence,
        company_id: row.companyId,
        resolved_domain: row.resolvedDomain,
        resolution_confidence: row.resolutionConfidence,
        meeting_date: row.meetingDate,
        status: row.status,
        raw_event: row.rawEvent,
      },
      { onConflict: "gcal_event_id,partner_id" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`meeting upsert failed: ${error.message}`);
  return data.id;
}

export async function setMeetingOutcome(meetingId: string, patch: { status: string; briefArtifactId?: string | null; companyId?: string | null }): Promise<void> {
  const { error } = await db()
    .from("meetings")
    .update({
      status: patch.status,
      ...(patch.briefArtifactId !== undefined ? { brief_artifact_id: patch.briefArtifactId } : {}),
      ...(patch.companyId !== undefined ? { company_id: patch.companyId } : {}),
    })
    .eq("id", meetingId);
  if (error) throw new Error(`meeting update failed: ${error.message}`);
}

/**
 * Existing meeting rows for these calendar events, keyed by gcal event id.
 * Deliberately date-independent: a multi-day event re-encountered on day 2
 * must see day 1's briefed row (the unique key is (gcal_event_id, partner_id)).
 */
export async function meetingsByEventIds(
  partnerId: string,
  gcalEventIds: string[],
): Promise<Map<string, { id: string; status: string; briefArtifactId: string | null; briefingStartedAt: string | null }>> {
  if (gcalEventIds.length === 0) return new Map();
  const { data, error } = await db()
    .from("meetings")
    .select("id, gcal_event_id, status, brief_artifact_id, briefing_started_at")
    .eq("partner_id", partnerId)
    .in("gcal_event_id", gcalEventIds);
  if (error) throw new Error(`meetings query failed: ${error.message}`);
  return new Map(
    data.map((m) => [
      m.gcal_event_id as string,
      {
        id: m.id as string,
        status: m.status as string,
        briefArtifactId: m.brief_artifact_id as string | null,
        briefingStartedAt: m.briefing_started_at as string | null,
      },
    ]),
  );
}

/**
 * Atomically claim a meeting for briefing. Returns false when another run holds
 * a fresh claim or the meeting is already terminal — the conditional WHERE
 * makes concurrent claims race-safe. Stale claims (>2h) are reclaimable.
 */
export async function claimMeeting(meetingId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db()
    .from("meetings")
    .update({ status: "briefing", briefing_started_at: new Date().toISOString() })
    .eq("id", meetingId)
    .or(`status.in.(pending,failed),and(status.eq.briefing,briefing_started_at.lt.${staleBefore})`)
    .select("id");
  if (error) throw new Error(`meeting claim failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Artifact already saved under this run — save-step idempotency across retries. */
export async function artifactIdByRunId(runId: string): Promise<string | null> {
  const { data, error } = await db().from("artifacts").select("id").eq("run_id", runId).eq("kind", "brief").maybeSingle();
  if (error) throw new Error(`artifact lookup failed: ${error.message}`);
  return data?.id ?? null;
}

/** Load a brief out of an artifact (redelivery of briefed-but-undelivered meetings). */
export async function briefFromArtifact(artifactId: string): Promise<Brief | null> {
  const { data, error } = await db().from("artifacts").select("content").eq("id", artifactId).maybeSingle();
  if (error) throw new Error(`artifact fetch failed: ${error.message}`);
  const content = data?.content as { brief?: Brief } | undefined;
  return content?.brief ?? null;
}

export async function companyIdByDomain(domain: string): Promise<string | null> {
  const { data, error } = await db().from("companies").select("id").eq("domain", domain).maybeSingle();
  if (error) throw new Error(`company lookup failed: ${error.message}`);
  return data?.id ?? null;
}

export async function priorMeetingCount(companyId: string, beforeDate: string): Promise<number> {
  const { count, error } = await db()
    .from("meetings")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .lt("meeting_date", beforeDate)
    .in("status", ["briefed", "completed"]);
  if (error) throw new Error(`prior meeting count failed: ${error.message}`);
  return count ?? 0;
}

/** Latest brief artifact for a company — feeds the "what's new" diff (PRD §13). */
export async function latestBrief(domain: string): Promise<Brief | null> {
  const companyId = await companyIdByDomain(domain);
  if (!companyId) return null;
  const { data, error } = await db()
    .from("artifacts")
    .select("content")
    .eq("company_id", companyId)
    .eq("kind", "brief")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`latest brief lookup failed: ${error.message}`);
  const content = data?.content as { brief?: Brief } | undefined;
  return content?.brief ?? null;
}
