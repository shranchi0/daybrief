#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { log } from "./lib/log";

const program = new Command();

program
  .name("daybrief")
  .description("Research-grade pre-meeting briefs for a seed-stage fund (M0 CLI).");

program
  .command("research")
  .description("Run the full research path for one company and print the brief as markdown.")
  .argument("<domain>", "company domain, e.g. acme.dev")
  .option("-c, --company <name>", "company name, if known")
  .option("-a, --attendees <names>", "comma-separated attendee names (used for identity verification)")
  .option("--processor <tier>", "Parallel processor override (default: PARALLEL_PROCESSOR_BRIEF)")
  .option("--synth-model <id>", "MODEL_SYNTH override for this run")
  .option("--json", "print the brief JSON instead of markdown")
  .option("--no-store", "skip Supabase persistence even if configured")
  .action(async (domain: string, opts) => {
    const { runResearchCommand } = await import("./research/pipeline");
    try {
      await runResearchCommand(domain, {
        companyName: opts.company,
        attendees: opts.attendees ? String(opts.attendees).split(",").map((s: string) => s.trim()).filter(Boolean) : [],
        processor: opts.processor,
        synthModel: opts.synthModel,
        json: Boolean(opts.json),
        store: opts.store !== false,
      });
    } catch (e) {
      log.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

program
  .command("eval")
  .description("Run the eval set across candidate MODEL_SYNTH options; write results side by side to Supabase.")
  .option("-f, --file <path>", "eval set JSON file", "eval-set.json")
  .option("-m, --models <ids>", "comma-separated MODEL_SYNTH candidates (default: current MODEL_SYNTH only)")
  .option("--limit <n>", "only run the first n companies", (v: string) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 1) throw new InvalidArgumentError("--limit must be a positive integer");
    return n;
  })
  .action(async (opts) => {
    const { runEvalCommand } = await import("./eval/run-eval");
    try {
      await runEvalCommand({
        file: opts.file,
        models: opts.models ? String(opts.models).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
        limit: opts.limit,
      });
    } catch (e) {
      log.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

program
  .command("nightly")
  .description("Run the nightly pipeline locally (same logic the Inngest cron runs).")
  .option("-p, --partner <email>", "run for one partner only")
  .option("-d, --date <yyyy-mm-dd>", "brief a specific day (default: today in the partner's timezone)")
  .option("--dry-run", "plan + classify + resolve only; no research, no spend")
  .action(async (opts) => {
    const { log } = await import("./lib/log");
    try {
      const { activePartners } = await import("./lib/pipeline-store");
      const { runPartnerDay } = await import("./pipeline/nightly");
      const partners = (await activePartners()).filter((p) => !opts.partner || p.email === opts.partner);
      if (partners.length === 0) throw new Error(opts.partner ? `No active partner ${opts.partner}` : "No active partners.");
      for (const partner of partners) {
        const outcomes = await runPartnerDay(partner, opts.date, { dryRun: Boolean(opts.dryRun) });
        const ok = outcomes.filter((o) => o.ok).length;
        log.ok(`${partner.email}: ${opts.dryRun ? `${outcomes.length} meeting(s) planned (dry run)` : `${ok}/${outcomes.length} briefed`}`);
      }
    } catch (e) {
      log.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
