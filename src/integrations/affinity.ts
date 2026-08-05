import { env } from "../config";
import { log } from "../lib/log";
import type { Recorder } from "../lib/store";

/**
 * Affinity CRM (read-only in v1 of daybrief — PRD §4). v1 endpoints for the
 * stable lookups (org by domain, persons, notes, lists), v2 (pinned to
 * 2026-07-15) for relationship-intelligence fields like source-of-introduction.
 * One Bearer header works for both since 2025-11.
 */

const BASE = "https://api.affinity.co";

async function affinityFetch<T>(path: string, opts: { v2?: boolean } = {}): Promise<T> {
  const key = env().AFFINITY_API_KEY;
  if (!key) throw new Error("AFFINITY_API_KEY is not set.");
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      ...(opts.v2 ? { "X-Affinity-Api-Version": "2026-07-15" } : {}),
    },
  });
  if (!res.ok) throw new Error(`Affinity ${path} → ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  return (await res.json()) as T;
}

export interface AffinityOrgContext {
  orgId: number;
  name: string;
  domain: string;
  listNames: string[];
  onPortfolioList: boolean;
  onLpList: boolean;
  firstInteraction: string | null;
  lastInteraction: string | null;
  sourceOfIntroduction: string | null;
  recentNotes: { createdAt: string; snippet: string }[];
}

interface V1Org {
  id: number;
  name: string;
  domain: string | null;
  domains: string[];
  list_entries?: { list_id: number }[];
  interaction_dates?: Record<string, string | null>;
}

let listNameCache: Map<number, string> | null = null;

async function listNames(): Promise<Map<number, string>> {
  if (!listNameCache) {
    const lists = await affinityFetch<{ id: number; name: string }[]>("/lists");
    listNameCache = new Map(lists.map((l) => [l.id, l.name]));
  }
  return listNameCache;
}

// Whole-name matches only — "Investment Pipeline"/"Potential Investments" are
// dealflow lists, not portfolio. Explicit list IDs (env) override name sniffing.
const PORTFOLIO_RE = /^\s*(?:portfolio(?:\s+(?:companies|cos))?|investments?)\s*$/i;
const LP_RE = /^\s*(?:lps?|limited partners?|fund investors?)\s*$/i;

function parseListIds(raw: string | undefined): number[] {
  return (raw ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Org context by domain. v1 term search also hits Affinity's global dataset,
 * so results are filtered to an exact domain match. Null = not in the CRM.
 */
export async function affinityOrgByDomain(domain: string, recorder?: Recorder): Promise<AffinityOrgContext | null> {
  const started = Date.now();
  try {
    // Term search is the domain lookup (no flags: with_interaction_dates on the
    // search endpoint silently omits orgs with zero interactions, and
    // list_entries only comes from the single-org fetch).
    const search = await affinityFetch<{ organizations: V1Org[] }>(`/organizations?term=${encodeURIComponent(domain)}`);
    const match = search.organizations.find(
      (o) => o.domain?.toLowerCase() === domain || o.domains?.some((d) => d.toLowerCase() === domain),
    );
    if (!match) return null;
    const org = await affinityFetch<V1Org>(`/organizations/${match.id}?with_interaction_dates=true`);

    const names = await listNames();
    const listEntries = org.list_entries ?? [];
    const orgListNames = listEntries.map((e) => names.get(e.list_id) ?? `list-${e.list_id}`);
    const portfolioIds = parseListIds(env().AFFINITY_PORTFOLIO_LIST_IDS);
    const lpIds = parseListIds(env().AFFINITY_LP_LIST_IDS);

    // Source of introduction lives in v2 relationship-intelligence fields.
    let sourceOfIntroduction: string | null = null;
    try {
      const fields = await affinityFetch<{ fields?: { id: string; value?: { data?: unknown } }[] }>(
        `/v2/companies/${org.id}?fieldTypes=relationship-intelligence`,
        { v2: true },
      );
      const src = fields.fields?.find((f) => f.id === "source-of-introduction");
      const data = src?.value?.data;
      if (typeof data === "string") sourceOfIntroduction = data;
      else if (data && typeof data === "object") sourceOfIntroduction = JSON.stringify(data).slice(0, 300);
    } catch (e) {
      log.detail(`Affinity v2 source-of-introduction unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }

    let recentNotes: { createdAt: string; snippet: string }[] = [];
    try {
      const notes = await affinityFetch<{ notes: { created_at: string; content: string }[] }>(
        `/notes?organization_id=${org.id}&page_size=5`,
      );
      recentNotes = (notes.notes ?? []).map((n) => ({
        createdAt: n.created_at,
        snippet: stripHtml(n.content ?? "").slice(0, 500),
      }));
    } catch (e) {
      log.detail(`Affinity notes fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const context: AffinityOrgContext = {
      orgId: org.id,
      name: org.name,
      domain,
      listNames: orgListNames,
      onPortfolioList: portfolioIds.length
        ? listEntries.some((e) => portfolioIds.includes(e.list_id))
        : orgListNames.some((n) => PORTFOLIO_RE.test(n)),
      onLpList: lpIds.length ? listEntries.some((e) => lpIds.includes(e.list_id)) : orgListNames.some((n) => LP_RE.test(n)),
      firstInteraction: org.interaction_dates?.first_email_date ?? org.interaction_dates?.first_event_date ?? null,
      lastInteraction: org.interaction_dates?.last_interaction_date ?? null,
      sourceOfIntroduction,
      recentNotes,
    };

    await recorder?.record({
      provider: "affinity",
      request: { lookup: "org_by_domain", domain },
      response: context,
      model_or_processor: null,
      tokens: null,
      cost_usd: null,
      latency_ms: Date.now() - started,
      created_at: new Date().toISOString(),
    });
    return context;
  } catch (e) {
    await recorder?.record({
      provider: "affinity",
      request: { lookup: "org_by_domain", domain },
      response: { error: e instanceof Error ? e.message : String(e) },
      model_or_processor: null,
      tokens: null,
      cost_usd: null,
      latency_ms: Date.now() - started,
      created_at: new Date().toISOString(),
    });
    throw e;
  }
}

/** Person lookup by email (v1 matches all email addresses). */
export async function affinityPersonByEmail(
  email: string,
): Promise<{ personId: number; name: string; organizationIds: number[] } | null> {
  const search = await affinityFetch<{ persons: { id: number; first_name: string; last_name: string; emails: string[]; organization_ids?: number[] }[] }>(
    `/persons?term=${encodeURIComponent(email)}`,
  );
  const person = search.persons.find((p) => p.emails?.some((e) => e.toLowerCase() === email.toLowerCase()));
  if (!person) return null;
  return {
    personId: person.id,
    name: `${person.first_name} ${person.last_name}`.trim(),
    organizationIds: person.organization_ids ?? [],
  };
}
