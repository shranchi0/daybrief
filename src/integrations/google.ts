import { readFileSync } from "node:fs";
import { google, type calendar_v3 } from "googleapis";
import { JWT, OAuth2Client } from "google-auth-library";
import { env, requireKey } from "../config";
import { log } from "../lib/log";
import { googleRefreshToken } from "../lib/pipeline-store";
import type { Attendee } from "../pipeline/resolve";

/**
 * Google Workspace access, read-only scopes only (PRD §14). Two auth paths:
 *  - Per-partner OAuth (preferred): each partner consents once at
 *    /api/google/connect; their refresh token lives in partners (service-role
 *    access only). Internal-audience OAuth apps skip Google's restricted-scope
 *    verification entirely.
 *  - Service account with domain-wide delegation (optional alternative):
 *    zero-touch for partners, but needs Workspace-admin setup.
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];

/** Partner has no usable Google credential — connect (or reconnect) needed. */
export class GoogleNotConnectedError extends Error {
  constructor(public partnerEmail: string, reason: string) {
    super(`${partnerEmail}: ${reason}`);
    this.name = "GoogleNotConnectedError";
  }
}

/**
 * True when an API error looks like a dead credential. Callers must also check
 * that the partner actually has a stored refresh token — the service-account
 * path emits the same invalid_grant on key rotation or clock skew, which is
 * transient, not a revocation.
 */
export function isGoogleAuthRevoked(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /invalid_grant|invalid_rapt|token has been expired or revoked/i.test(message);
}

/** Any Google auth path configured (per-partner OAuth or service account)? */
export function googleConfigured(): boolean {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_SERVICE_ACCOUNT_JSON } = env();
  return Boolean((GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET) || GOOGLE_SERVICE_ACCOUNT_JSON);
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

let keyCache: ServiceAccountKey | null = null;

function serviceAccountKey(): ServiceAccountKey {
  if (!keyCache) {
    const raw = requireKey("GOOGLE_SERVICE_ACCOUNT_JSON");
    // Accept a path to the JSON key file or the JSON itself (for Vercel env vars).
    const json = raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf8");
    keyCache = JSON.parse(json) as ServiceAccountKey;
  }
  return keyCache;
}

export function oauthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: requireKey("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: requireKey("GOOGLE_OAUTH_CLIENT_SECRET"),
    redirectUri: `${env().APP_URL}/api/google/callback`,
  });
}

async function authFor(partnerEmail: string): Promise<JWT | OAuth2Client> {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_SERVICE_ACCOUNT_JSON } = env();
  if (GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET) {
    const refreshToken = await googleRefreshToken(partnerEmail);
    if (refreshToken) {
      const client = oauthClient();
      client.setCredentials({ refresh_token: refreshToken });
      return client;
    }
    if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
      throw new GoogleNotConnectedError(
        partnerEmail,
        `no Google connection — have them visit ${env().APP_URL}/api/google/connect`,
      );
    }
  }
  if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    const key = serviceAccountKey();
    return new JWT({ email: key.client_email, key: key.private_key, scopes: GOOGLE_SCOPES, subject: partnerEmail });
  }
  throw new GoogleNotConnectedError(
    partnerEmail,
    "no Google auth configured — set GOOGLE_OAUTH_CLIENT_ID/SECRET (preferred) or GOOGLE_SERVICE_ACCOUNT_JSON",
  );
}

/** "2026-08-05" in the given IANA timezone, for a given instant. */
export function dateInTimezone(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * The UTC offset (e.g. "-07:00") that applies to local midnight of `date` in
 * `timezone`. DST transitions happen in the early local morning, so a naive
 * noon probe lands on the wrong side of the switch; refine iteratively —
 * converges in one extra pass.
 */
function offsetFor(date: string, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
  const offsetAt = (instant: Date): string =>
    fmt
      .formatToParts(instant)
      .find((p) => p.type === "timeZoneName")
      ?.value?.match(/GMT([+-]\d{2}:\d{2})?/)?.[1] ?? "+00:00";

  let offset = offsetAt(new Date(`${date}T12:00:00Z`));
  for (let i = 0; i < 2; i++) {
    const refined = offsetAt(new Date(`${date}T00:00:00${offset}`));
    if (refined === offset) break;
    offset = refined;
  }
  return offset;
}

export interface CalendarEvent {
  gcalEventId: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  attendees: Attendee[];
  videoLink: string | null;
  organizerEmail: string | null;
  raw: unknown;
}

/** All of `date`'s events (partner-local day) for the impersonated partner. */
export async function fetchDaysEvents(partnerEmail: string, timezone: string, date?: string): Promise<CalendarEvent[]> {
  const day = date ?? dateInTimezone(timezone);
  const offset = offsetFor(day, timezone);
  const calendar = google.calendar({ version: "v3", auth: await authFor(partnerEmail) });

  // timeMin bounds event END, timeMax bounds event START (overlap semantics);
  // orderBy startTime requires singleEvents.
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: `${day}T00:00:00${offset}`,
    timeMax: `${day}T23:59:59${offset}`,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
    eventTypes: ["default"],
  });

  const events: CalendarEvent[] = [];
  for (const item of res.data.items ?? []) {
    if (item.status === "cancelled") continue;
    // Skip events the partner declined.
    const self = item.attendees?.find((a) => a.self);
    if (self?.responseStatus === "declined") continue;

    events.push({
      gcalEventId: item.id ?? "",
      title: item.summary ?? "(no title)",
      description: item.description ?? null,
      startsAt: item.start?.dateTime ?? (item.start?.date ? `${item.start.date}T00:00:00${offset}` : ""),
      endsAt: item.end?.dateTime ?? (item.end?.date ? `${item.end.date}T00:00:00${offset}` : ""),
      attendees: (item.attendees ?? []).map(
        (a: calendar_v3.Schema$EventAttendee): Attendee => ({
          email: (a.email ?? "").toLowerCase(),
          displayName: a.displayName ?? null,
          isResource: a.resource ?? false,
          isOrganizer: a.organizer ?? false,
        }),
      ),
      videoLink: item.hangoutLink ?? item.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ?? null,
      organizerEmail: item.organizer?.email?.toLowerCase() ?? null,
      raw: item,
    });
  }
  return events;
}

export interface GmailThreadSummary {
  threadId: string;
  subject: string | null;
  date: string | null;
  participants: string[];
  snippet: string | null;
  /** Attachments seen on the thread (deck candidates). */
  attachments: { filename: string; messageId: string }[];
  gmailLink: string;
}

export interface GmailContext {
  earliestThread: GmailThreadSummary | null;
  latestThread: GmailThreadSummary | null;
}

function headerOf(headers: { name?: string | null; value?: string | null }[] | undefined, name: string): string | null {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

async function threadSummary(
  gmail: ReturnType<typeof google.gmail>,
  threadId: string,
): Promise<GmailThreadSummary> {
  const t = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  const messages = t.data.messages ?? [];
  const first = messages[0];
  const headers = first?.payload?.headers ?? undefined;
  const participants = new Set<string>();
  const attachments: { filename: string; messageId: string }[] = [];
  for (const m of messages) {
    for (const h of ["From", "To", "Cc"]) {
      const v = headerOf(m.payload?.headers ?? undefined, h);
      if (v) v.split(",").forEach((p) => participants.add(p.trim()));
    }
    const walk = (parts: NonNullable<NonNullable<typeof m.payload>["parts"]> | undefined): void => {
      for (const p of parts ?? []) {
        if (p.filename && p.body?.attachmentId) attachments.push({ filename: p.filename, messageId: m.id ?? "" });
        walk(p.parts ?? undefined);
      }
    };
    walk(m.payload?.parts ?? undefined);
  }
  return {
    threadId,
    subject: headerOf(headers, "Subject"),
    date: first?.internalDate ? new Date(Number(first.internalDate)).toISOString() : null,
    participants: [...participants].slice(0, 12),
    snippet: first?.snippet ?? null,
    attachments: attachments.slice(0, 5),
    gmailLink: `https://mail.google.com/mail/u/0/#all/${threadId}`,
  };
}

/**
 * Earliest + latest thread with the company (PRD §6.4: intro path from the
 * earliest thread; recent context from the latest). Earliest is found by
 * binary-searching epoch-second `before:` bounds — Gmail can't sort ascending.
 */
export async function fetchGmailContext(partnerEmail: string, companyDomain: string): Promise<GmailContext> {
  const gmail = google.gmail({ version: "v1", auth: await authFor(partnerEmail) });
  // Brace group is Gmail's OR form; cc: included so cc-only intro threads match.
  const q = `{from:${companyDomain} to:${companyDomain} cc:${companyDomain}}`;

  const anyThreads = await gmail.users.threads.list({ userId: "me", q, maxResults: 1 });
  if (!anyThreads.data.threads?.length) return { earliestThread: null, latestThread: null };
  const latest = await threadSummary(gmail, anyThreads.data.threads[0]!.id!);

  // Binary search the smallest epoch second with a matching message before it.
  // Floor at Gmail's launch so the invariant "nothing before lo" always holds.
  let lo = Math.floor(Date.UTC(2004, 3, 1) / 1000);
  let hi = Math.floor(Date.now() / 1000);
  try {
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await gmail.users.threads.list({ userId: "me", q: `${q} before:${mid}`, maxResults: 1 });
      if (r.data.threads?.length) hi = mid;
      else lo = mid + 1;
    }
    // The earliest message lies just before `lo`; fetch a double-bounded ±1-day
    // window and resolve by internalDate (list order is not guaranteed).
    const day = 60 * 60 * 24;
    const win = await gmail.users.threads.list({
      userId: "me",
      q: `${q} after:${lo - day} before:${lo + day}`,
      maxResults: 20,
    });
    const candidates = win.data.threads ?? [];
    let earliest: GmailThreadSummary | null = null;
    for (const t of candidates) {
      const s = await threadSummary(gmail, t.id!);
      if (!earliest || (s.date && (!earliest.date || s.date < earliest.date))) earliest = s;
    }
    return { earliestThread: earliest ?? latest, latestThread: latest };
  } catch (e) {
    log.warn(`Gmail earliest-thread search failed for ${companyDomain}: ${e instanceof Error ? e.message : String(e)}`);
    return { earliestThread: null, latestThread: latest };
  }
}
