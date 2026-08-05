import { normalizeDomain } from "../lib/domain";
import { log } from "../lib/log";
import { Recorder } from "../lib/store";
import { peoplePass, similarityPass } from "../providers/exa";
import { runBriefTask } from "../providers/parallel";
import type { Brief, ResearchBundle } from "../types";
import { renderBriefMarkdown } from "./render";
import { synthesizeBrief } from "./synthesize";

/**
 * The M0 research path (PRD §15): Parallel Task + Exa passes run concurrently,
 * then one synthesis call merges them. Partial provider failure degrades
 * gracefully — a brief built from what succeeded beats no brief, and the
 * synthesizer marks missing fields "not found" rather than guessing.
 */

export async function gatherResearch(opts: {
  domain: string;
  companyName?: string;
  attendees: string[];
  processor?: string;
  recorder: Recorder;
  /** M1: Affinity + Gmail context; absent in M0 CLI runs. */
  internalContext?: unknown;
  /** M1: previous brief version for repeat meetings (drives whats_new). */
  previousBrief?: import("../types").Brief | null;
}): Promise<ResearchBundle> {
  log.step(`Researching ${opts.domain} (Parallel Task + Exa people/similarity passes)…`);

  const [parallelResult, exaPeople, exaCompetitors] = await Promise.allSettled([
    runBriefTask(opts),
    peoplePass(opts),
    similarityPass(opts),
  ]);

  if (parallelResult.status === "rejected") {
    log.warn(`Parallel Task failed: ${reasonOf(parallelResult)}`);
  }
  if (exaPeople.status === "rejected") {
    log.warn(`Exa people pass failed: ${reasonOf(exaPeople)}`);
  }
  if (exaCompetitors.status === "rejected") {
    log.warn(`Exa similarity pass failed: ${reasonOf(exaCompetitors)}`);
  }
  // The people pass swallows per-query errors, so "fulfilled but empty" counts as failed here.
  const peopleEmpty = exaPeople.status !== "fulfilled" || exaPeople.value.every((c) => c.results.length === 0);
  if (parallelResult.status === "rejected" && exaCompetitors.status === "rejected" && peopleEmpty) {
    throw new Error(
      `All research passes failed for ${opts.domain} — refusing to synthesize a brief from nothing. First error: ${reasonOf(parallelResult)}`,
    );
  }

  return {
    companyName: opts.companyName ?? null,
    domain: opts.domain,
    attendees: opts.attendees,
    parallelResult: parallelResult.status === "fulfilled" ? parallelResult.value : { failed: reasonOf(parallelResult) },
    exaPeople: exaPeople.status === "fulfilled" ? exaPeople.value : { failed: reasonOf(exaPeople) },
    exaCompetitors: exaCompetitors.status === "fulfilled" ? exaCompetitors.value : { failed: reasonOf(exaCompetitors) },
    internalContext: opts.internalContext ?? null,
    previousBrief: opts.previousBrief ?? null,
  };
}

function reasonOf(settled: PromiseSettledResult<unknown>): string {
  if (settled.status === "fulfilled") return "";
  const r = settled.reason;
  return r instanceof Error ? r.message : String(r);
}

export async function synthesizeAndRender(
  bundle: ResearchBundle,
  opts: { model?: string; recorder: Recorder },
): Promise<{ brief: Brief; markdown: string }> {
  log.step(`Synthesizing brief${opts.model ? ` with ${opts.model}` : ""}…`);
  const brief = await synthesizeBrief(bundle, opts);
  const markdown = renderBriefMarkdown(brief, new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC");
  return { brief, markdown };
}

/** CLI entry: daybrief research <domain>. */
export async function runResearchCommand(
  domain: string,
  opts: {
    companyName?: string;
    attendees: string[];
    processor?: string;
    synthModel?: string;
    json: boolean;
    store: boolean;
  },
): Promise<void> {
  const cleanDomain = normalizeDomain(domain);
  const recorder = new Recorder("brief");
  if (opts.store) await recorder.startRun();

  try {
    const bundle = await gatherResearch({
      domain: cleanDomain,
      companyName: opts.companyName,
      attendees: opts.attendees,
      processor: opts.processor,
      recorder,
    });
    const { brief, markdown } = await synthesizeAndRender(bundle, { model: opts.synthModel, recorder });

    if (opts.store) {
      // Persistence failure must not eat the brief we just paid for — print it anyway.
      try {
        await recorder.saveArtifact({
          kind: "brief",
          domain: cleanDomain,
          companyName: brief.company_name,
          content: { brief, bundle_summary: { attendees: bundle.attendees } },
          contentMd: markdown,
        });
        await recorder.finishRun("succeeded", { domain: cleanDomain });
      } catch (e) {
        log.warn(`Persistence failed (brief still printed): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    process.stdout.write(opts.json ? JSON.stringify(brief, null, 2) + "\n" : markdown + "\n");
    log.ok(`Done. Provider calls: ${recorder.calls.length}, spend: $${recorder.totalCostUsd.toFixed(3)}`);
  } catch (e) {
    if (opts.store) await recorder.finishRun("failed", { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
