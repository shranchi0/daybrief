import { RetryAfterError, cron } from "inngest";
import { env } from "../config";
import { dateInTimezone } from "../integrations/google";
import { briefBlocks, dmPartner, postOps } from "../integrations/slack";
import {
  activePartners,
  artifactIdByRunId,
  claimMeeting,
  companyIdByDomain,
  latestBrief,
  setMeetingOutcome,
  type Partner,
} from "../lib/pipeline-store";
import { Recorder } from "../lib/store";
import { peoplePass, similarityPass } from "../providers/exa";
import {
  createBriefTask,
  fetchBriefResult,
  ParallelStillRunningError,
  type ParallelTaskHandle,
} from "../providers/parallel";
import { gatherInternalContext, hasInternalSignal } from "../pipeline/internal-context";
import {
  handleGoogleAuthFailure,
  planPartnerDay,
  redeliveryOutcomes,
  type MeetingBriefOutcome,
  type PlannedMeeting,
} from "../pipeline/nightly";
import { synthesizeAndRender } from "../research/pipeline";
import type { ResearchBundle } from "../types";
import { inngest } from "./client";

/**
 * Three functions (PRD §6):
 *  - nightly cron (05:00 PT weekdays + 06:45 recheck) → fan out per partner
 *  - partner-day → plan, invoke a brief per external meeting, deliver the
 *    morning Slack digest (one durable step per DM) + ops summary
 *  - meeting-brief → durable per-meeting steps with a DB claim up front, the
 *    paid synthesis isolated in its own memoized step, idempotent artifact
 *    save, and a mark-failed path so nothing sticks in pending/running.
 */

export const meetingBrief = inngest.createFunction(
  {
    id: "meeting-brief",
    retries: 6,
    // Global cap on concurrently executing steps → bounds provider load.
    concurrency: { limit: 4 },
    triggers: [{ event: "daybrief/meeting-brief.requested" }],
  },
  async ({ event, step }) => {
    const item = event.data.item as PlannedMeeting;
    const domain = item.resolution.domain;
    const base = {
      meetingId: item.meetingId,
      domain,
      title: item.event.title,
      startsAt: item.event.startsAt,
      classification: item.classification.classification,
    };
    if (!item.briefable || !domain) {
      return { ...base, ok: false, error: "not briefable", costUsd: 0 } satisfies MeetingBriefOutcome;
    }

    // DB-level claim: a concurrent run (06:45 recheck, manual rerun) cannot
    // double-brief — the conditional UPDATE only succeeds once per 2h window.
    const claimed = await step.run("claim-meeting", async () => claimMeeting(item.meetingId));
    if (!claimed) {
      return { ...base, ok: false, error: "not briefable (claimed by another run)", costUsd: 0 } satisfies MeetingBriefOutcome;
    }

    const runId = await step.run("create-run", async () => {
      const recorder = new Recorder("brief");
      return await recorder.startRun();
    });
    const attach = () => {
      const recorder = new Recorder("brief");
      if (runId) recorder.attachRun(runId);
      return recorder;
    };

    const attendees = item.resolution.externalAttendees
      .map((a) => a.displayName ?? a.email.split("@")[0] ?? "")
      .filter(Boolean);

    try {
      // Parallel task is created exactly once (memoized step) — retries never
      // create (and pay for) a second run.
      const handle = await step.run("create-parallel-task", async () =>
        createBriefTask({
          domain,
          companyName: item.affinity?.name,
          attendees,
          webhookUrl: env().PARALLEL_WEBHOOK_URL,
        }),
      );

      // The waitForEvent must register in the same step plan as task creation —
      // registering it after the other steps complete would miss completion
      // events that arrive while they run (fast processors, step retries).
      const [internal, exa] = await Promise.all([
        step.run("internal-context", async () => {
          const recorder = attach();
          const [ctx, prev] = await Promise.all([
            gatherInternalContext({ partnerEmail: item.partner.email, domain, recorder }),
            latestBrief(domain).catch(() => null),
          ]);
          return { ctx, prev, costUsd: recorder.totalCostUsd };
        }),
        step.run("exa-passes", async () => {
          const recorder = attach();
          const [people, competitors] = await Promise.allSettled([
            peoplePass({ domain, companyName: item.affinity?.name, attendees, recorder }),
            similarityPass({ domain, companyName: item.affinity?.name, recorder }),
          ]);
          return {
            people: people.status === "fulfilled" ? people.value : { failed: String(people.reason) },
            competitors: competitors.status === "fulfilled" ? competitors.value : { failed: String(competitors.reason) },
            costUsd: recorder.totalCostUsd,
          };
        }),
        ...(env().PARALLEL_WEBHOOK_URL
          ? [
              step.waitForEvent("parallel-complete", {
                event: "parallel/task_run.status",
                timeout: "30m",
                if: `async.data.run_id == "${(handle as ParallelTaskHandle).runId}"`,
              }),
            ]
          : []),
      ]);

      const research = await step.run("fetch-parallel-result", async () => {
        const recorder = attach();
        try {
          const result = await fetchBriefResult(handle as ParallelTaskHandle, recorder, 240);
          return { result, costUsd: recorder.totalCostUsd };
        } catch (e) {
          if (e instanceof ParallelStillRunningError) {
            throw new RetryAfterError(`Parallel task still running (${e.runId})`, "15s");
          }
          throw e;
        }
      });

      // The paid model call is its own memoized step: a later persistence
      // failure retries persistence, never re-bills synthesis.
      const synth = await step.run("synthesize", async () => {
        const recorder = attach();
        const bundle: ResearchBundle = {
          companyName: item.affinity?.name ?? null,
          domain,
          attendees,
          parallelResult: research.result,
          exaPeople: exa.people,
          exaCompetitors: exa.competitors,
          internalContext: hasInternalSignal(internal.ctx) ? internal.ctx : null,
          previousBrief: internal.prev,
        };
        const { brief, markdown } = await synthesizeAndRender(bundle, { recorder });
        return { brief, markdown, costUsd: recorder.totalCostUsd };
      });

      const artifactId = await step.run("save-artifact", async () => {
        // Idempotent across step retries: the run id is stable, so re-check
        // whether this run already saved its artifact before inserting.
        if (runId) {
          const existing = await artifactIdByRunId(runId);
          if (existing) return existing;
        }
        const recorder = attach();
        return await recorder.saveArtifact({
          kind: "brief",
          domain,
          companyName: synth.brief.company_name,
          content: { brief: synth.brief, meeting_id: item.meetingId, partner_email: item.partner.email },
          contentMd: synth.markdown,
        });
      });

      return await step.run("finalize", async (): Promise<MeetingBriefOutcome> => {
        const totalCostUsd = internal.costUsd + exa.costUsd + research.costUsd + synth.costUsd;
        const companyId = await companyIdByDomain(domain);
        await setMeetingOutcome(item.meetingId, { status: "briefed", briefArtifactId: artifactId, companyId });
        await attach().finishRun("succeeded", { domain, meeting_id: item.meetingId }, totalCostUsd);
        return { ...base, ok: true, brief: synth.brief, artifactId, costUsd: totalCostUsd };
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await step.run("mark-failed", async () => {
        await setMeetingOutcome(item.meetingId, { status: "failed" }).catch(() => {});
        await attach()
          .finishRun("failed", { domain, error: message })
          .catch(() => {});
      });
      return { ...base, ok: false, error: message, costUsd: 0 } satisfies MeetingBriefOutcome;
    }
  },
);

export const partnerDay = inngest.createFunction(
  {
    id: "partner-day",
    retries: 2,
    concurrency: { limit: 3 },
    triggers: [{ event: "daybrief/partner-day.requested" }],
  },
  async ({ event, step }) => {
    const { partnerId, date } = event.data as { partnerId: string; date?: string };

    const plan = await step.run("plan", async () => {
      const partner = (await activePartners()).find((p) => p.id === partnerId);
      if (!partner) throw new Error(`Partner ${partnerId} not found or inactive.`);
      const day = date ?? dateInTimezone(partner.timezone);
      try {
        const planned = await planPartnerDay(partner, day);
        return { partner, day, planned, authError: null as string | null };
      } catch (e) {
        // Connect problems are permanent-until-reconnect — don't burn step
        // retries. Transient errors (incl. SA invalid_grant) rethrow and retry.
        const failure = await handleGoogleAuthFailure(partner, e);
        if (failure === null) throw e;
        if (failure.saFallback) {
          // Dead token was cleared — retry takes the service-account path.
          const planned = await planPartnerDay(partner, day);
          return { partner, day, planned, authError: null as string | null };
        }
        return { partner, day, planned: [] as PlannedMeeting[], authError: failure.message };
      }
    });
    const partner = plan.partner as Partner;

    if (plan.authError) {
      await step.run("ops-auth-skip", async () => {
        await postOps(`daybrief ${plan.day} · ${partner.email}: SKIPPED — Google not connected`);
      });
      return { day: plan.day, briefed: 0, failed: 0, deliveryError: null, authError: plan.authError };
    }

    const briefable = plan.planned.filter((p) => p.briefable);
    const outcomes: MeetingBriefOutcome[] = await Promise.all(
      briefable.map((item) =>
        step
          .invoke(`brief-${item.meetingId}`, {
            function: meetingBrief,
            data: { item },
            timeout: "50m",
          })
          .then((r) => r as MeetingBriefOutcome)
          .catch(
            (e): MeetingBriefOutcome => ({
              meetingId: item.meetingId,
              domain: item.resolution.domain,
              title: item.event.title,
              startsAt: item.event.startsAt,
              classification: item.classification.classification,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
              costUsd: 0,
            }),
          ),
      ),
    );

    const redelivered = await step.run("load-redeliveries", async () => redeliveryOutcomes(plan.planned as PlannedMeeting[]));
    const all = [...outcomes, ...redelivered];
    const briefed = all.filter((o) => o.ok && o.brief);
    const failed = all.filter((o) => !o.ok && !o.error?.startsWith("not briefable"));

    // One durable step per DM: a retry resends at most one message, and a
    // delivery failure never blocks the ops summary.
    let deliveryError: string | null = null;
    if (briefed.length > 0 || failed.length > 0) {
      try {
        await step.run("dm-header", async () => {
          await dmPartner(partner.email, `daybrief · ${plan.day}: ${briefed.length} brief(s)${failed.length ? `, ${failed.length} failed` : ""}`);
        });
        for (const o of briefed) {
          await step.run(`dm-${o.meetingId}`, async () => {
            const time = o.startsAt
              ? new Intl.DateTimeFormat("en-US", { timeZone: partner.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(o.startsAt))
              : null;
            const sent = await dmPartner(
              partner.email,
              `${o.brief!.company_name}: ${o.brief!.one_liner}`,
              briefBlocks(o.brief!, { time, videoLink: null, classification: o.classification }),
            );
            if (sent) await setMeetingOutcome(o.meetingId, { status: "delivered" }).catch(() => {});
          });
        }
      } catch (e) {
        deliveryError = e instanceof Error ? e.message : String(e);
      }
    }

    await step.run("ops-summary", async () => {
      const spend = all.reduce((s, o) => s + o.costUsd, 0);
      const skipped = plan.planned.length - briefable.length;
      await postOps(
        `daybrief ${plan.day} · ${partner.email}: ${briefed.length}/${all.length} briefed, ${skipped} skipped, $${spend.toFixed(2)} spend` +
          (failed.length ? ` — failures: ${failed.map((o) => o.domain ?? o.title).join(", ")}` : "") +
          (deliveryError ? ` — DELIVERY FAILED: ${deliveryError}` : ""),
      );
    });

    return { day: plan.day, briefed: briefed.length, failed: failed.length, deliveryError };
  },
);

export const nightly = inngest.createFunction(
  {
    id: "nightly",
    retries: 2,
    triggers: [
      cron("TZ=America/Los_Angeles 0 5 * * 1-5"),
      // Light re-check for calendar changes; the DB claim + status machine make
      // it incapable of re-briefing or re-paying.
      cron("TZ=America/Los_Angeles 45 6 * * 1-5"),
      { event: "daybrief/nightly.requested" },
    ],
  },
  async ({ event, step }) => {
    const date = (event?.data as { date?: string } | undefined)?.date;
    const partners = await step.run("partners", async () => activePartners());
    if (partners.length === 0) return { partners: 0 };
    await step.sendEvent(
      "fan-out-partners",
      partners.map((p) => ({
        name: "daybrief/partner-day.requested",
        data: { partnerId: p.id, date: date ?? dateInTimezone(p.timezone) },
      })),
    );
    return { partners: partners.length };
  },
);

export const functions = [nightly, partnerDay, meetingBrief];
