import { z } from "zod";
import "dotenv/config";

/**
 * All model IDs and provider choices live here as env slots (PRD §10) —
 * never hard-code model IDs elsewhere. Which concrete models fill the slots
 * is answered by `daybrief eval`, not by this file.
 */

const envSchema = z.object({
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  PARALLEL_API_KEY: z.string().min(1).optional(),
  EXA_API_KEY: z.string().min(1).optional(),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  /** Direct Postgres fallback for persistence when the Data API secret key isn't configured. */
  DATABASE_URL: z.string().min(1).optional(),

  /** Embeddings for M3 recall — OpenRouter doesn't serve embedding models. */
  OPENAI_API_KEY: z.string().min(1).optional(),

  MODEL_FAST: z.string().default("anthropic/claude-haiku-4.5"),
  MODEL_SYNTH: z.string().default("anthropic/claude-sonnet-5"),
  MODEL_DEEP: z.string().default("anthropic/claude-opus-5"),
  EMBEDDING_MODEL: z.string().default("openai/text-embedding-3-large"),

  /** Parallel processor tier for nightly briefs (PRD A1: pro; core if latency bites). */
  PARALLEL_PROCESSOR_BRIEF: z.string().default("pro"),
  /** Parallel processor tier for deep-dive pass 1 (PRD §9: ultra-class). */
  PARALLEL_PROCESSOR_DEEP: z.string().default("ultra"),

  /** Default generic web-search tool: "parallel" or "exa" (PRD §10). Both stay wired. */
  SEARCH_DEFAULT: z.enum(["parallel", "exa"]).default("exa"),

  /** Candidate MODEL_SYNTH list `daybrief eval` compares when --models isn't given. */
  EVAL_SYNTH_MODELS: z.string().default("anthropic/claude-sonnet-5"),

  // --- M1 nightly pipeline ---
  /** The firm's Workspace domain; attendees on it are internal. */
  FIRM_DOMAIN: z.string().default("categoryvc.com"),
  /**
   * Preferred Google auth: per-partner OAuth. Create an OAuth client (type Web,
   * Internal audience) in Google Cloud; partners connect at /api/google/connect.
   */
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  /** Base URL of the deployed app (redirect URI host), e.g. https://daybrief.vercel.app */
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Alternative: service-account JSON key with domain-wide delegation. */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  AFFINITY_API_KEY: z.string().min(1).optional(),
  /** Comma-separated Affinity list IDs — beats name-based portfolio/LP detection when set. */
  AFFINITY_PORTFOLIO_LIST_IDS: z.string().optional(),
  AFFINITY_LP_LIST_IDS: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  /** Channel ID for the ops run-summary (e.g. C0123456789). */
  SLACK_OPS_CHANNEL: z.string().min(1).optional(),
  /** Default partner timezone for "today" windows (per-partner override in DB later). */
  PARTNER_TIMEZONE: z.string().default("America/Los_Angeles"),
  /**
   * Inngest webhook-intake URL (https://inn.gs/e/...) that transforms Parallel
   * task_run.status callbacks into events. When set, the meeting function
   * waits on the webhook instead of polling.
   */
  PARALLEL_WEBHOOK_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    // .env templates leave unused keys as `KEY=`; treat empty strings as unset
    // so optional slots stay optional.
    const cleaned = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
    const parsed = envSchema.safeParse(cleaned);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Throw a clear, actionable error when a required key is missing for a code path. */
export function requireKey<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env()[key];
  if (value === undefined || value === "") {
    throw new Error(`${key} is not set. Add it to .env (see .env.example).`);
  }
  return value as NonNullable<Env[K]>;
}
