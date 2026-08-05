import { Inngest } from "inngest";

/**
 * Inngest is the pipeline's flight recorder for control flow (PRD §11): the
 * 05:00 cron, per-meeting fan-out as durable steps, retries, and concurrency
 * caps per provider — every run visible in the Inngest dashboard.
 *
 * checkpointing.maxRuntime is set to ~80% of the /api/inngest route's
 * maxDuration (300s) per Inngest's Vercel guidance.
 */
export const inngest = new Inngest({
  id: "daybrief",
  checkpointing: { maxRuntime: "240s" },
});
