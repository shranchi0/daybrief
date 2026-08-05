import type { Brief, SourcedField } from "../types";

/** Render a brief as scannable markdown (CLI output in M0; email/Slack later). */

const CONFIDENCE_BADGE = { high: "●●●", medium: "●●○", low: "●○○" } as const;

function badge(confidence: "high" | "medium" | "low"): string {
  return `${CONFIDENCE_BADGE[confidence]} ${confidence}`;
}

function sources(urls: string[]): string {
  if (urls.length === 0) return "";
  return "\n" + urls.map((u) => `  - <${u}>`).join("\n");
}

function field(title: string, f: SourcedField | null): string {
  if (!f) return `## ${title}\n\n_not found_\n`;
  return `## ${title}  \`${badge(f.confidence)}\`\n\n${f.text}\n${sources(f.sources)}\n`;
}

export function renderBriefMarkdown(brief: Brief, researchedAt: string): string {
  const parts: string[] = [];

  parts.push(`# ${brief.company_name} — ${brief.domain}`);
  parts.push(`> ${brief.one_liner}`);
  parts.push(`_Researched ${researchedAt} · overall confidence: ${badge(brief.overall_confidence)}_`);

  if (!brief.identity.verified) {
    parts.push(`> ⚠️ **Identity not verified.** ${brief.identity.note ?? "Company-to-attendee match could not be confirmed."}`);
  } else if (brief.identity.note) {
    parts.push(`_Identity: ${brief.identity.note}_`);
  }

  parts.push(field("What it is", brief.what_it_is));
  // PRD §7 fallback copy: internal record absent means ask, not guess.
  parts.push(
    brief.how_we_got_introduced
      ? field("How we got introduced", brief.how_we_got_introduced)
      : `## How we got introduced\n\n_No record — ask._\n`,
  );

  if (brief.founders.length === 0) {
    parts.push(`## Founders\n\n_not found_\n`);
  } else {
    const rows = brief.founders.map((f) => {
      const title = f.title ? `, ${f.title}` : "";
      const li = f.linkedin_url ? ` — [LinkedIn](${f.linkedin_url})` : " — _LinkedIn not verified_";
      const bg = f.background ?? "_Limited public background_";
      return `- **${f.name}**${title}${li} \`${badge(f.confidence)}\`\n  ${bg}${sources(f.sources)}`;
    });
    parts.push(`## Founders\n\n${rows.join("\n")}\n`);
  }

  parts.push(field("Product", brief.product));

  if (!brief.market_and_competitors) {
    parts.push(`## Market & competitors\n\n_Competitive picture unclear_\n`);
  } else {
    const m = brief.market_and_competitors;
    const comps = m.competitors
      .map((c) => `- **${c.name}** — ${c.note}${c.source ? ` ([source](${c.source}))` : ""}`)
      .join("\n");
    parts.push(
      `## Market & competitors  \`${badge(m.confidence)}\`\n\n${m.framing}\n\n${comps || "_No named competitors found_"}\n${sources(m.sources)}\n`,
    );
  }

  if (!brief.funding_history) {
    parts.push(`## Funding history\n\n_No public funding information found_\n`);
  } else {
    const rows = brief.funding_history.rounds.map((r) => {
      const bits = [r.stage, r.date, r.amount, r.lead_investors.length ? `led by ${r.lead_investors.join(", ")}` : null]
        .filter(Boolean)
        .join(" · ");
      return `- ${bits}${sources(r.sources)}`;
    });
    parts.push(`## Funding history  \`${badge(brief.funding_history.confidence)}\`\n\n${rows.join("\n")}\n`);
  }

  if (brief.recent_news.length > 0) {
    const rows = brief.recent_news
      .map((n) => `- ${n.date ? `**${n.date}** — ` : ""}${n.item}${n.source ? ` ([source](${n.source}))` : ""}`)
      .join("\n");
    parts.push(`## Recent news\n\n${rows}\n`);
  }

  if (brief.whats_new) {
    parts.push(`## What's new since our last brief\n\n${brief.whats_new}\n`);
  }

  return parts.filter(Boolean).join("\n\n");
}
