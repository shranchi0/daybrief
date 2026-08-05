import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "../config";
import { normalizeDomain } from "../lib/domain";
import { log } from "../lib/log";
import { Recorder } from "../lib/store";
import { gatherResearch, synthesizeAndRender } from "../research/pipeline";

/**
 * M0 eval harness (PRD §15). Research passes (Parallel + Exa) run once per
 * company; each candidate MODEL_SYNTH then synthesizes from the same bundle, so
 * the comparison isolates the synthesizer. Results land side by side in
 * Supabase as artifacts of kind 'eval' with the model recorded in content.
 */

const evalSetSchema = z.object({
  companies: z.array(
    z.object({
      domain: z.string().transform(normalizeDomain),
      company: z.string().nullable().optional(),
      attendees: z.array(z.string()).default([]),
    }),
  ),
});

export async function runEvalCommand(opts: { file: string; models?: string[]; limit?: number }): Promise<void> {
  const raw = await readFile(opts.file, "utf8").catch(() => {
    throw new Error(`Eval set file not found: ${opts.file}. Copy eval-set.example.json to eval-set.json and fill it with real companies from recent calendars.`);
  });
  const set = evalSetSchema.parse(JSON.parse(raw));
  const companies = opts.limit ? set.companies.slice(0, opts.limit) : set.companies;
  const models = opts.models?.length
    ? opts.models
    : env().EVAL_SYNTH_MODELS.split(",").map((s) => s.trim()).filter(Boolean);

  log.step(`Eval: ${companies.length} companies × ${models.length} synth model(s) = ${companies.length * models.length} briefs`);

  // Fail fast: eval results are reviewed in Supabase; running paid research
  // and then discarding every brief would be strictly worse than not running.
  const recorder = new Recorder("eval");
  const runId = await recorder.startRun();
  if (!runId) {
    throw new Error(
      "eval requires Supabase persistence — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (results would otherwise be discarded after paid research calls).",
    );
  }

  const results: { domain: string; model: string; ok: boolean; overall?: string; error?: string }[] = [];

  for (const company of companies) {
    log.step(`Researching ${company.domain} …`);
    let bundle;
    try {
      bundle = await gatherResearch({
        domain: company.domain,
        companyName: company.company ?? undefined,
        attendees: company.attendees,
        recorder,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`  research failed for ${company.domain}: ${msg}`);
      for (const model of models) results.push({ domain: company.domain, model, ok: false, error: msg });
      continue;
    }

    for (const model of models) {
      try {
        const { brief, markdown } = await synthesizeAndRender(bundle, { model, recorder });
        await recorder.saveArtifact({
          kind: "eval",
          domain: company.domain,
          companyName: brief.company_name,
          content: { synth_model: model, brief },
          contentMd: markdown,
        });
        results.push({ domain: company.domain, model, ok: true, overall: brief.overall_confidence });
        log.ok(`  ${model}: overall_confidence=${brief.overall_confidence}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(`  ${model}: synthesis failed: ${msg}`);
        results.push({ domain: company.domain, model, ok: false, error: msg });
      }
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  await recorder.finishRun(failed === 0 ? "succeeded" : "failed", { results });

  // Side-by-side console table; the real review happens over the Supabase rows.
  process.stdout.write("\n| domain | model | ok | overall confidence |\n|---|---|---|---|\n");
  for (const r of results) {
    process.stdout.write(`| ${r.domain} | ${r.model} | ${r.ok ? "✓" : `✗ ${r.error ?? ""}`} | ${r.overall ?? "—"} |\n`);
  }
  process.stdout.write(`\nTotal spend: $${recorder.totalCostUsd.toFixed(2)}\n`);
}
