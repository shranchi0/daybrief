import { normalizeDomain } from "../lib/domain";

/**
 * Company resolution (PRD §6.3): external attendee emails → strip generic
 * domains → the remaining domain is the candidate company. If only generic
 * domains remain, resolution falls back to name/title/Affinity/Exa signals
 * (wired by the caller); if nothing resolves, we do NOT guess — the meeting is
 * marked unresolved and the card shows the raw invite.
 */

const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "hey.com",
  "fastmail.com",
  "zoho.com",
  "gmx.com",
  "mail.com",
  "duck.com",
]);

export function isGenericDomain(domain: string): boolean {
  return GENERIC_EMAIL_DOMAINS.has(domain.toLowerCase());
}

export interface Attendee {
  email: string;
  displayName: string | null;
  isResource: boolean;
  isOrganizer: boolean;
}

export interface DomainResolution {
  domain: string | null;
  confidence: "high" | "medium" | "low" | "unresolved";
  method: "attendee_domain" | "fallback" | "none";
  /** External attendees considered, for downstream passes. */
  externalAttendees: Attendee[];
  note: string | null;
}

export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  try {
    return normalizeDomain(email.slice(at + 1));
  } catch {
    return null;
  }
}

export function splitAttendees(attendees: Attendee[], firmDomain: string): {
  internal: Attendee[];
  external: Attendee[];
} {
  const internal: Attendee[] = [];
  const external: Attendee[] = [];
  const firm = firmDomain.toLowerCase();
  for (const a of attendees) {
    if (a.isResource) continue; // rooms/equipment
    const domain = domainOfEmail(a.email);
    // Firm subdomains (e.g. mail.categoryvc.com aliases) count as internal.
    if (domain !== null && (domain === firm || domain.endsWith(`.${firm}`))) internal.push(a);
    else external.push(a);
  }
  return { internal, external };
}

/**
 * Fold counted domains that are dot-suffix children of another counted domain
 * into the shorter parent (jane@ibm.com + raj@us.ibm.com → ibm.com ×2). Only
 * folds when both variants co-occur, which avoids the co.uk trap.
 */
function foldSubdomains(counts: Map<string, number>): Map<string, number> {
  const folded = new Map<string, number>();
  for (const d of [...counts.keys()].sort((a, b) => a.length - b.length)) {
    const parent = [...folded.keys()].find((p) => d === p || d.endsWith(`.${p}`)) ?? d;
    folded.set(parent, (folded.get(parent) ?? 0) + (counts.get(d) ?? 0));
  }
  return folded;
}

/**
 * First-pass resolution from attendee email domains alone. The caller runs the
 * fallback (Affinity person match + Exa search on names/title) only when this
 * returns null domain.
 */
export function resolveFromAttendeeDomains(external: Attendee[]): DomainResolution {
  const rawCounts = new Map<string, number>();
  for (const a of external) {
    const domain = domainOfEmail(a.email);
    if (!domain || isGenericDomain(domain)) continue;
    rawCounts.set(domain, (rawCounts.get(domain) ?? 0) + 1);
  }
  const counts = foldSubdomains(rawCounts);

  if (counts.size === 0) {
    return { domain: null, confidence: "unresolved", method: "none", externalAttendees: external, note: "Only generic email domains among external attendees." };
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topDomain, topCount] = ranked[0]!;

  if (ranked.length === 1) {
    return { domain: topDomain, confidence: "high", method: "attendee_domain", externalAttendees: external, note: null };
  }
  // Multiple company domains (e.g. co-investor on the invite): pick the most
  // frequent; ties or scattered singles get lower confidence.
  const [, secondCount] = ranked[1]!;
  const confidence = topCount > secondCount ? "medium" : "low";
  return {
    domain: topDomain,
    confidence,
    method: "attendee_domain",
    externalAttendees: external,
    note: `Multiple external domains on invite: ${ranked.map(([d, n]) => `${d}(${n})`).join(", ")}. Chose ${topDomain}.`,
  };
}
