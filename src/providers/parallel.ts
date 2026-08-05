import Parallel from "parallel-web";
import { env, requireKey } from "../config";
import { log } from "../lib/log";
import type { Recorder } from "../lib/store";
import { BRIEF_OUTPUT_SCHEMA, briefTaskInput } from "../research/brief-task-spec";

/**
 * Parallel Task API: the managed structured-research pass (PRD §10). Schema in,
 * cited structured facts out. Auth is x-api-key (handled by the SDK).
 *
 * Two usage shapes:
 *  - CLI (M0): runBriefTask() creates + blocks until done.
 *  - Inngest (M1): createBriefTask() then waitForEvent on the completion
 *    webhook (or bounded polling) then fetchBriefResult() — no long blocking.
 */

let client: Parallel | null = null;

function parallel(): Parallel {
  if (!client) client = new Parallel({ apiKey: requireKey("PARALLEL_API_KEY") });
  return client;
}

/** $/run by processor tier (visibility only, never a gate). -fast variants cost the same. */
const PROCESSOR_PRICE_USD: Record<string, number> = {
  lite: 0.005,
  base: 0.01,
  core: 0.025,
  core2x: 0.05,
  pro: 0.1,
  ultra: 0.3,
  ultra2x: 0.6,
  ultra4x: 1.2,
  ultra8x: 2.4,
};

export function processorPriceUsd(processor: string): number | null {
  return PROCESSOR_PRICE_USD[processor.replace(/-fast$/, "")] ?? null;
}

export interface ParallelTaskHandle {
  runId: string;
  input: string;
  processor: string;
  createdAtMs: number;
}

export interface ParallelBriefResult {
  /** Structured fields per BRIEF_OUTPUT_SCHEMA. */
  content: Record<string, unknown>;
  /** Basis: per-field citations, reasoning, confidence. */
  basis: unknown;
  runId: string;
  processor: string;
}

export async function createBriefTask(opts: {
  domain: string;
  companyName?: string;
  attendees: string[];
  processor?: string;
  /** Inngest webhook-intake URL; Parallel POSTs task_run.status there on completion. */
  webhookUrl?: string;
}): Promise<ParallelTaskHandle> {
  const processor = opts.processor ?? env().PARALLEL_PROCESSOR_BRIEF;
  const input = briefTaskInput(opts.domain, opts.companyName, opts.attendees);
  const run = await parallel().taskRun.create({
    input,
    processor,
    task_spec: { output_schema: BRIEF_OUTPUT_SCHEMA as unknown as Parallel.TaskSpec["output_schema"] },
    metadata: { domain: opts.domain.slice(0, 512) },
    ...(opts.webhookUrl ? { webhook: { url: opts.webhookUrl, event_types: ["task_run.status"] } } : {}),
  });
  log.detail(`Parallel task ${run.run_id} (${processor}) running…`);
  return { runId: run.run_id, input, processor, createdAtMs: Date.now() };
}

/**
 * Fetch the result, blocking server-side up to `blockSeconds` if still running.
 * Throws ParallelStillRunningError when the window expires — callers decide
 * whether to loop (CLI) or let their step-retry machinery re-enter (Inngest).
 */
export class ParallelStillRunningError extends Error {
  constructor(public runId: string) {
    super(`Parallel task ${runId} still running.`);
    this.name = "ParallelStillRunningError";
  }
}

export async function fetchBriefResult(
  handle: ParallelTaskHandle,
  recorder: Recorder,
  blockSeconds = 500,
): Promise<ParallelBriefResult> {
  const started = Date.now();
  try {
    let result: Parallel.TaskRunResult;
    try {
      result = await parallel().taskRun.result(
        handle.runId,
        { timeout: blockSeconds },
        // SDK's own HTTP timeout must exceed the server blocking window
        // (default is 60s); its internal retries stay off so callers own retry accounting.
        { timeout: (blockSeconds + 20) * 1000, maxRetries: 0 },
      );
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 408 || e instanceof Parallel.APIConnectionTimeoutError) {
        throw new ParallelStillRunningError(handle.runId);
      }
      throw e;
    }
    if (result.run.status !== "completed") {
      if (result.run.is_active) throw new ParallelStillRunningError(handle.runId);
      throw new Error(`Parallel task ${handle.runId} ended with status ${result.run.status}: ${result.run.error?.message ?? "unknown error"}`);
    }

    const output = result.output as { type: string; content: unknown; basis?: unknown };
    // OpenAPI says content is a native object for type=json; one doc example
    // shows a JSON-encoded string — accept both.
    const content = (
      typeof output.content === "string" ? JSON.parse(output.content) : output.content
    ) as Record<string, unknown>;

    await recorder.record({
      provider: "parallel",
      request: { input: handle.input, processor: handle.processor, task_spec: { output_schema: BRIEF_OUTPUT_SCHEMA } },
      response: { run: result.run, output },
      model_or_processor: handle.processor,
      tokens: null,
      cost_usd: processorPriceUsd(handle.processor),
      latency_ms: Date.now() - handle.createdAtMs,
      created_at: new Date().toISOString(),
    });

    return { content, basis: output.basis ?? null, runId: handle.runId, processor: handle.processor };
  } catch (e) {
    if (e instanceof ParallelStillRunningError) throw e; // not a failure; no record yet
    // Flight recorder covers failures too. The run was created server-side and
    // is billed if it completes, so keep the cost estimate on the record.
    await recorder.record({
      provider: "parallel",
      request: { input: handle.input, processor: handle.processor, task_spec: { output_schema: BRIEF_OUTPUT_SCHEMA } },
      response: { error: e instanceof Error ? e.message : String(e), run_id: handle.runId },
      model_or_processor: handle.processor,
      tokens: null,
      cost_usd: processorPriceUsd(handle.processor),
      latency_ms: Date.now() - started,
      created_at: new Date().toISOString(),
    });
    throw e;
  }
}

/** CLI path: create + block until done (bounded overall deadline). */
export async function runBriefTask(opts: {
  domain: string;
  companyName?: string;
  attendees: string[];
  processor?: string;
  recorder: Recorder;
}): Promise<ParallelBriefResult> {
  const handle = await createBriefTask(opts);
  const MAX_WAIT_MS = 40 * 60_000;
  while (true) {
    if (Date.now() - handle.createdAtMs > MAX_WAIT_MS) {
      throw new Error(`Parallel task ${handle.runId} still running after ${Math.round(MAX_WAIT_MS / 60000)} min; giving up.`);
    }
    try {
      return await fetchBriefResult(handle, opts.recorder, 500);
    } catch (e) {
      if (e instanceof ParallelStillRunningError) continue;
      throw e;
    }
  }
}
