import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import ws from "ws";
import { env } from "../config";
import { log } from "./log";
import type { ProviderCallRecord } from "../types";

/**
 * Persistence + flight recorder (PRD §12). Every provider request/response is
 * kept verbatim so any brief can be traced to exactly what every provider
 * returned. Two backends behind one small interface:
 *  - supabase-js Data API when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
 *    (the M1+ path — same client the jobs/realtime layers use)
 *  - direct Postgres via DATABASE_URL otherwise (works with just the database
 *    password, no API secret key needed)
 * With neither configured, records stay in memory, the CLI still prints the
 * brief, and a warning notes that nothing persists.
 */

interface Db {
  createRun(kind: string): Promise<string>;
  insertProviderCall(runId: string, call: ProviderCallRecord): Promise<void>;
  upsertCompany(domain: string, name: string | null): Promise<string>;
  nextArtifactVersion(companyId: string, kind: string): Promise<number>;
  insertArtifact(row: {
    runId: string;
    companyId: string;
    kind: string;
    version: number;
    content: unknown;
    contentMd: string;
  }): Promise<string>;
  finishRun(runId: string, status: string, costUsd: number, summary: unknown): Promise<void>;
}

class SupabaseDb implements Db {
  constructor(private client: SupabaseClient) {}

  async createRun(kind: string): Promise<string> {
    const { data, error } = await this.client.from("runs").insert({ kind, status: "running" }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  async insertProviderCall(runId: string, call: ProviderCallRecord): Promise<void> {
    const { error } = await this.client.from("provider_calls").insert({
      run_id: runId,
      provider: call.provider,
      request: sanitizeJson(call.request),
      response: sanitizeJson(call.response),
      model_or_processor: call.model_or_processor,
      tokens: call.tokens,
      cost_usd: call.cost_usd,
      latency_ms: call.latency_ms,
    });
    if (error) throw new Error(error.message);
  }

  async upsertCompany(domain: string, name: string | null): Promise<string> {
    const { data, error } = await this.client
      .from("companies")
      .upsert({ domain, ...(name ? { name } : {}) }, { onConflict: "domain" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  async nextArtifactVersion(companyId: string, kind: string): Promise<number> {
    const { data, error } = await this.client
      .from("artifacts")
      .select("version")
      .eq("company_id", companyId)
      .eq("kind", kind)
      .order("version", { ascending: false })
      .limit(1);
    // A swallowed error here would silently reset versions to 1; fail the save instead.
    if (error) throw new Error(`version lookup failed: ${error.message}`);
    return (data?.[0]?.version ?? 0) + 1;
  }

  async insertArtifact(row: Parameters<Db["insertArtifact"]>[0]): Promise<string> {
    const { data, error } = await this.client
      .from("artifacts")
      .insert({
        run_id: row.runId,
        company_id: row.companyId,
        kind: row.kind,
        version: row.version,
        content: sanitizeJson(row.content),
        content_md: row.contentMd,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  async finishRun(runId: string, status: string, costUsd: number, summary: unknown): Promise<void> {
    const { error } = await this.client
      .from("runs")
      .update({ status, finished_at: new Date().toISOString(), cost_usd: costUsd, summary: sanitizeJson(summary) })
      .eq("id", runId);
    if (error) throw new Error(error.message);
  }
}

class PostgresDb implements Db {
  private sql: ReturnType<typeof postgres>;

  constructor(databaseUrl: string) {
    // idle_timeout lets the CLI process exit naturally once writes finish.
    this.sql = postgres(databaseUrl, { ssl: "require", max: 3, connect_timeout: 15, idle_timeout: 5 });
  }

  async createRun(kind: string): Promise<string> {
    const [row] = await this.sql`insert into runs (kind, status) values (${kind}, 'running') returning id`;
    return row!.id;
  }

  async insertProviderCall(runId: string, call: ProviderCallRecord): Promise<void> {
    await this.sql`insert into provider_calls
      (run_id, provider, request, response, model_or_processor, tokens, cost_usd, latency_ms)
      values (${runId}, ${call.provider}, ${this.sql.json(sanitizeJson(call.request) as never)},
              ${this.sql.json(sanitizeJson(call.response) as never)}, ${call.model_or_processor},
              ${call.tokens}, ${call.cost_usd}, ${call.latency_ms})`;
  }

  async upsertCompany(domain: string, name: string | null): Promise<string> {
    const [row] = await this.sql`insert into companies (domain, name) values (${domain}, ${name})
      on conflict (domain) do update set name = coalesce(excluded.name, companies.name)
      returning id`;
    return row!.id;
  }

  async nextArtifactVersion(companyId: string, kind: string): Promise<number> {
    const [row] = await this.sql`select coalesce(max(version), 0) + 1 as next
      from artifacts where company_id = ${companyId} and kind = ${kind}`;
    return Number(row!.next);
  }

  async insertArtifact(row: Parameters<Db["insertArtifact"]>[0]): Promise<string> {
    const [inserted] = await this.sql`insert into artifacts
      (run_id, company_id, kind, version, content, content_md)
      values (${row.runId}, ${row.companyId}, ${row.kind}, ${row.version},
              ${this.sql.json(sanitizeJson(row.content) as never)}, ${row.contentMd})
      returning id`;
    return inserted!.id;
  }

  async finishRun(runId: string, status: string, costUsd: number, summary: unknown): Promise<void> {
    await this.sql`update runs set status = ${status}, finished_at = now(),
      cost_usd = ${costUsd}, summary = ${this.sql.json(sanitizeJson(summary) as never)}
      where id = ${runId}`;
  }
}

function makeDb(): Db | null {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL } = env();
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseDb(
      createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        // Node 20 lacks native WebSocket; supabase-js initializes realtime even
        // when unused. Harmless on Node 22+.
        realtime: { transport: ws as never },
      }),
    );
  }
  if (DATABASE_URL) return new PostgresDb(DATABASE_URL);
  return null;
}

export class Recorder {
  readonly calls: ProviderCallRecord[] = [];
  private runId: string | null = null;
  private db: Db | null;
  private warned = false;

  constructor(private kind: "brief" | "deep_dive" | "eval" | "nightly") {
    this.db = makeDb();
  }

  get totalCostUsd(): number {
    return this.calls.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0);
  }

  /**
   * Attach to a run row created elsewhere (Inngest steps run in separate
   * invocations; the run row is created once, then each step attaches).
   */
  attachRun(runId: string): void {
    this.runId = runId;
  }

  /**
   * Null only when persistence is unconfigured (CLI without a database).
   * A configured database that fails THROWS — callers (Inngest steps) must see
   * the failure and retry rather than silently memoizing a null run id.
   */
  async startRun(): Promise<string | null> {
    if (!this.db) {
      if (!this.warned) {
        log.warn("No persistence configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or DATABASE_URL.");
        this.warned = true;
      }
      return null;
    }
    this.runId = await this.db.createRun(this.kind);
    return this.runId;
  }

  /** Record a provider call in memory and (best-effort) in the database. Never throws. */
  async record(call: ProviderCallRecord): Promise<void> {
    this.calls.push(call);
    if (!this.db || !this.runId) return;
    try {
      await this.db.insertProviderCall(this.runId, call);
    } catch (e) {
      log.warn(`provider_calls insert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Throws on persistence failure (callers own retry semantics); retries the
   * version race internally — concurrent regenerations of the same company hit
   * the artifacts_version_uniq index and just re-read the version.
   */
  async saveArtifact(opts: {
    kind: "brief" | "deep_dive" | "eval";
    domain: string;
    companyName: string | null;
    content: unknown;
    contentMd: string;
  }): Promise<string | null> {
    if (!this.db || !this.runId) return null;
    const companyId = await this.db.upsertCompany(opts.domain, opts.companyName);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = await this.db.nextArtifactVersion(companyId, opts.kind);
      try {
        return await this.db.insertArtifact({
          runId: this.runId,
          companyId,
          kind: opts.kind,
          version,
          content: opts.content,
          contentMd: opts.contentMd,
        });
      } catch (e) {
        lastError = e;
        const message = e instanceof Error ? e.message : String(e);
        if (!/artifacts_version_uniq|duplicate key|23505/i.test(message)) throw e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * costOverrideUsd: the Inngest path spreads provider calls across step-local
   * Recorder instances, so the final step passes the summed cost explicitly.
   */
  async finishRun(status: "succeeded" | "failed", summary?: unknown, costOverrideUsd?: number): Promise<void> {
    if (!this.db || !this.runId) return;
    try {
      await this.db.finishRun(this.runId, status, Number((costOverrideUsd ?? this.totalCostUsd).toFixed(4)), summary ?? null);
    } catch (e) {
      log.warn(`run update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Strip undefineds / non-serializable values so jsonb inserts never fail. */
function sanitizeJson(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { unserializable: String(value) };
  }
}
