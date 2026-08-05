import { z } from "zod";

/**
 * The brief schema (PRD §7 + Appendix A2).
 *
 * Contract: a field the research could not support is null, and the UI/renderer
 * shows "not found". Nothing is ever interpolated or estimated. Every factual
 * field carries source URLs and a confidence marker mapped from the research
 * provider's own confidence signals.
 */

export const confidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof confidenceSchema>;

export const sourcedFieldSchema = z.object({
  text: z.string().describe("The field content. Plain language, no hype adjectives."),
  sources: z.array(z.string()).describe("Source URLs supporting the claims in text. Empty only for internal-context fields."),
  confidence: confidenceSchema,
});
export type SourcedField = z.infer<typeof sourcedFieldSchema>;

export const founderSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  linkedin_url: z.string().nullable().describe("Verified LinkedIn profile URL, or null if not verified."),
  background: z.string().nullable().describe("2-3 sentences: prior companies, exits, notable employers/labs. Null if limited public background."),
  sources: z.array(z.string()),
  confidence: confidenceSchema,
});
export type Founder = z.infer<typeof founderSchema>;

export const competitorSchema = z.object({
  name: z.string(),
  note: z.string().describe("One short clause on what they do / how they differ."),
  source: z.string().nullable(),
});

export const fundingRoundSchema = z.object({
  stage: z.string().nullable(),
  date: z.string().nullable().describe("ISO date or human-readable date as reported. Null if not reported."),
  amount: z.string().nullable().describe("As reported, e.g. '$4.5M'. Never estimated."),
  lead_investors: z.array(z.string()),
  sources: z.array(z.string()),
});

export const briefSchema = z.object({
  company_name: z.string(),
  domain: z.string(),
  one_liner: z.string().describe("One line for the meeting card: what this company is, in passing-glance form."),

  identity: z.object({
    verified: z.boolean().describe("Whether the company at the domain was confirmed to match the attendees."),
    note: z.string().nullable().describe("If not verified or conflicting, explain what was found."),
  }),
  overall_confidence: confidenceSchema,

  what_it_is: sourcedFieldSchema.nullable(),
  how_we_got_introduced: sourcedFieldSchema
    .nullable()
    .describe("From internal context ONLY (CRM, earliest email thread). Never inferred from the web. Null when no internal record exists."),
  founders: z.array(founderSchema),
  product: sourcedFieldSchema.nullable(),
  market_and_competitors: z
    .object({
      framing: z.string().describe("One sentence framing the market."),
      competitors: z.array(competitorSchema),
      sources: z.array(z.string()),
      confidence: confidenceSchema,
    })
    .nullable(),
  funding_history: z
    .object({
      rounds: z.array(fundingRoundSchema),
      confidence: confidenceSchema,
    })
    .nullable()
    .describe("Null when no public funding information was found."),
  recent_news: z.array(
    z.object({
      date: z.string().nullable(),
      item: z.string(),
      source: z.string().nullable(),
    }),
  ),
  whats_new: z
    .string()
    .nullable()
    .describe("Repeat meetings only: concrete deltas vs the previous brief. Null on first briefs."),
});
export type Brief = z.infer<typeof briefSchema>;

/** Inputs assembled by the pipeline and handed to the synthesizer. */
export interface ResearchBundle {
  companyName: string | null;
  domain: string;
  attendees: string[];
  /** Parallel Task API result: structured fields + Basis citations/confidence. Raw. */
  parallelResult: unknown;
  /** Exa people pass: founder LinkedIn candidates. Raw. */
  exaPeople: unknown;
  /** Exa similarity pass: competitor candidates from findSimilar, verified with contents. Raw. */
  exaCompetitors: unknown;
  /** Internal context (Affinity/Gmail/Granola). Absent in M0 CLI runs. */
  internalContext: unknown | null;
  /** Previous brief version for repeat meetings. Absent in M0 CLI runs. */
  previousBrief: Brief | null;
}

/** One provider call recorded for the flight recorder (PRD §12). */
export interface ProviderCallRecord {
  provider: "openrouter" | "parallel" | "exa" | "google" | "affinity" | "granola";
  request: unknown;
  response: unknown;
  model_or_processor: string | null;
  tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  created_at: string;
}
