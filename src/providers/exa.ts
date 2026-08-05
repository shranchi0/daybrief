import { Exa } from "exa-js";
import { requireKey } from "../config";
import { urlMatchesDomain } from "../lib/domain";
import { log } from "../lib/log";
import type { Recorder } from "../lib/store";

/**
 * Exa: semantic retrieval (PRD §10). Two jobs in the brief pipeline:
 *  - people pass: find/verify founder & attendee LinkedIn profiles
 *    (category "people"; all constraints go in the natural-language query —
 *    the people category rejects domain/date filters)
 *  - similarity pass: competitor candidates from the company's own site
 */

let client: Exa | null = null;

function exa(): Exa {
  if (!client) client = new Exa(requireKey("EXA_API_KEY"));
  return client;
}

function costOf(res: unknown): number | null {
  const cost = (res as { costDollars?: { total?: unknown } }).costDollars?.total;
  return typeof cost === "number" ? cost : null;
}

export interface ExaPersonCandidate {
  query: string;
  results: {
    title: string | null;
    url: string;
    linkedin: boolean;
    highlights?: string[];
    entities?: unknown;
  }[];
}

/**
 * People pass: one search per attendee name, plus a generic founders search.
 * Returns raw candidates; verification against the company site happens in the
 * synthesizer, which cross-checks names from the Parallel pass.
 */
export async function peoplePass(opts: {
  domain: string;
  companyName?: string;
  attendees: string[];
  recorder: Recorder;
}): Promise<ExaPersonCandidate[]> {
  const company = opts.companyName ?? opts.domain;
  const queries = [
    ...opts.attendees.map((name) => `${name}, ${company} (${opts.domain})`),
    `founder of ${company} (${opts.domain})`,
  ];

  const candidates: ExaPersonCandidate[] = [];
  for (const query of queries) {
    const started = Date.now();
    try {
      const res = await exa().search(query, {
        category: "people",
        type: "auto",
        numResults: 5,
        contents: { highlights: true },
      });
      candidates.push({
        query,
        results: res.results.map((r) => ({
          title: r.title ?? null,
          url: r.url,
          linkedin: /linkedin\.com\/in\//.test(r.url),
          highlights: (r as { highlights?: string[] }).highlights,
          entities: (r as { entities?: unknown }).entities,
        })),
      });
      await opts.recorder.record({
        provider: "exa",
        request: { endpoint: "search", category: "people", query },
        response: res,
        model_or_processor: "search:people",
        tokens: null,
        cost_usd: costOf(res),
        latency_ms: Date.now() - started,
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      log.warn(`Exa people search failed for "${query}": ${e instanceof Error ? e.message : String(e)}`);
      await opts.recorder.record({
        provider: "exa",
        request: { endpoint: "search", category: "people", query },
        response: { error: e instanceof Error ? e.message : String(e) },
        model_or_processor: "search:people",
        tokens: null,
        cost_usd: null,
        latency_ms: Date.now() - started,
        created_at: new Date().toISOString(),
      });
    }
  }
  return candidates;
}

export interface ExaCompetitorCandidates {
  method: "findSimilar" | "search";
  results: { title: string | null; url: string; highlights?: string[] }[];
}

/**
 * Similarity pass: findSimilar on the company homepage surfaces competitors
 * that keyword search structurally misses. findSimilar is deprecated (still
 * functional, Aug 2026); on failure fall back to the documented replacement —
 * a category:"company" search describing the source, self-filtering the domain.
 */
export async function similarityPass(opts: {
  domain: string;
  companyName?: string;
  /** One-line description of what the company does, if already known (improves the fallback query). */
  descriptionHint?: string;
  recorder: Recorder;
}): Promise<ExaCompetitorCandidates> {
  const started = Date.now();
  try {
    const res = await exa().findSimilar(`https://${opts.domain}`, {
      excludeSourceDomain: true,
      category: "company",
      numResults: 8,
      contents: { highlights: true },
    });
    await opts.recorder.record({
      provider: "exa",
      request: { endpoint: "findSimilar", url: `https://${opts.domain}` },
      response: res,
      model_or_processor: "findSimilar",
      tokens: null,
      cost_usd: costOf(res),
      latency_ms: Date.now() - started,
      created_at: new Date().toISOString(),
    });
    return {
      method: "findSimilar",
      results: res.results.map((r) => ({
        title: r.title ?? null,
        url: r.url,
        highlights: (r as { highlights?: string[] }).highlights,
      })),
    };
  } catch (e) {
    log.warn(`Exa findSimilar failed (${e instanceof Error ? e.message : String(e)}); falling back to company search.`);
    await opts.recorder.record({
      provider: "exa",
      request: { endpoint: "findSimilar", url: `https://${opts.domain}` },
      response: { error: e instanceof Error ? e.message : String(e) },
      model_or_processor: "findSimilar",
      tokens: null,
      cost_usd: null,
      latency_ms: Date.now() - started,
      created_at: new Date().toISOString(),
    });
  }

  const fallbackStarted = Date.now();
  const company = opts.companyName ?? opts.domain;
  const query = `companies similar to ${company}${opts.descriptionHint ? ` — ${opts.descriptionHint}` : ` (${opts.domain})`}`;
  const res = await exa().search(query, {
    category: "company",
    type: "auto",
    numResults: 10,
    contents: { highlights: true },
  });
  await opts.recorder.record({
    provider: "exa",
    request: { endpoint: "search", category: "company", query },
    response: res,
    model_or_processor: "search:company",
    tokens: null,
    cost_usd: costOf(res),
    latency_ms: Date.now() - fallbackStarted,
    created_at: new Date().toISOString(),
  });
  return {
    method: "search",
    results: res.results
      .filter((r) => !urlMatchesDomain(r.url, opts.domain))
      .map((r) => ({
        title: r.title ?? null,
        url: r.url,
        highlights: (r as { highlights?: string[] }).highlights,
      })),
  };
}
