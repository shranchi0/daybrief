import { serve } from "inngest/next";
import { inngest } from "../../../src/inngest/client";
import { functions } from "../../../src/inngest/functions";

// Vercel: raise to 800 on Pro (fluid compute + streaming) — long Parallel
// fetch steps benefit from the headroom.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
  streaming: true,
});
