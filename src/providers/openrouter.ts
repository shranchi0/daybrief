import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { requireKey } from "../config";

/**
 * All chat/agent model calls go through OpenRouter (PRD §10) via the AI SDK
 * provider. Model IDs come from env slots in config.ts — never hard-coded.
 */

let provider: ReturnType<typeof createOpenRouter> | null = null;

export function openrouter() {
  if (!provider) {
    provider = createOpenRouter({ apiKey: requireKey("OPENROUTER_API_KEY") });
  }
  return provider;
}

export function chatModel(modelId: string) {
  return openrouter().chat(modelId);
}

/**
 * OpenRouter always returns request cost in usage now (usage:{include} is a
 * deprecated no-op). Via the AI SDK it surfaces in providerMetadata; the AI
 * SDK's own result.usage has normalized token counts only.
 */
export function extractOpenRouterCost(providerMetadata: unknown): number | null {
  const usage = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage;
  return typeof usage?.cost === "number" ? usage.cost : null;
}
