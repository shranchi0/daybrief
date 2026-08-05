/**
 * Parallel Task API output schema for the nightly brief (PRD Appendix A1, v0).
 *
 * Parallel schema rules: root must be an object, every property listed in
 * `required` (optionality = union with null), additionalProperties false, and
 * most JSON Schema validation keywords (format, pattern, minimum, maximum…) rejected —
 * constraints and fallbacks live in the field descriptions, which act as
 * per-field prompts. Do NOT add citations/confidence fields: Parallel's Basis
 * framework supplies per-field citations, reasoning, and confidence separately.
 */
export const BRIEF_OUTPUT_SCHEMA = {
  type: "json",
  json_schema: {
    type: "object",
    description:
      "Pre-meeting research on a company a seed-stage VC partner is meeting. Research only this company (the one operating the given domain). Never guess or interpolate; when information cannot be found, use the exact fallback string the field specifies.",
    properties: {
      identity_check: {
        type: "string",
        description:
          "Confirm the company operating this domain matches the named attendees, citing the page that confirms it (site team page, LinkedIn company page, press). Beware same-named companies at other domains. If it does not match or cannot be confirmed, say so explicitly, starting with 'MISMATCH:' or 'UNCONFIRMED:'.",
      },
      what_it_is: {
        type: "string",
        description:
          "1-2 plain-English sentences on what the company is. If essentially no public presence exists, return 'Appears to be in stealth' and say what little is public.",
      },
      product: {
        type: "string",
        description:
          "A few sentences: what the product does, who buys it, how it is delivered. Note open-source/GitHub presence and traction (stars, adoption) if any — this firm invests in infrastructure and developer tooling, where GitHub and Hacker News reception are signal.",
      },
      founders: {
        type: "string",
        description:
          "For each founder: name, title, and 2-3 sentences of background (prior companies, exits, notable employers or labs). Only include people verifiably associated with this company. One founder per paragraph. If none can be verified, return 'No verifiable founder information found'.",
      },
      market_and_competitors: {
        type: "string",
        description:
          "One sentence framing the market, then 2-4 named competitors with a short clause each. If unclear, return 'Competitive picture unclear'.",
      },
      funding_history: {
        type: "string",
        description:
          "Each round on its own line: stage, date, amount, lead investors — only from citable sources (press, official announcements). Never estimate round sizes, dates, or valuations. If none found, return 'No public funding information found'.",
      },
      recent_news: {
        type: "string",
        description:
          "Up to 3 notable items from the last 6 months with dates, one per line, or 'None found'.",
      },
    },
    required: [
      "identity_check",
      "what_it_is",
      "product",
      "founders",
      "market_and_competitors",
      "funding_history",
      "recent_news",
    ],
    additionalProperties: false,
  },
} as const;

/** A1 input string: "{company_name} ({domain}) — attendees: {names}". */
export function briefTaskInput(domain: string, companyName?: string, attendees: string[] = []): string {
  const name = companyName ?? domain;
  const attendeePart = attendees.length > 0 ? ` — attendees: ${attendees.join(", ")}` : "";
  return `${name} (${domain})${attendeePart}`;
}
