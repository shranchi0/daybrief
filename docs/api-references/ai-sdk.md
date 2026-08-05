# Vercel AI SDK — v7 Reference (verified live from ai-sdk.dev, npm registry — 2026-08-05)

Everything below was verified against live docs (`ai-sdk.dev`) and the npm registry on
2026-08-05 unless explicitly marked **UNVERIFIED**.

---

## 1. Version & packages

| Package | Current version | Notes |
|---|---|---|
| `ai` | **7.0.52** | Core SDK. ESM-only (`"type": "module"`), engines `node >= 22`. |
| `@ai-sdk/openai` | 4.0.30 | First-party provider example. |
| `@ai-sdk/otel` | 1.0.52 | OpenTelemetry integration (new in v7; telemetry moved out of core). |
| `@openrouter/ai-sdk-provider` | 3.0.0 | Community provider; peerDeps `ai: ^7.0.0`. |
| `zod` | peer: `^3.25.76 \|\| ^4.1.8` | Both zod 3 (>=3.25.76) and zod 4 (>=4.1.8) work. Import `import { z } from 'zod'`. |

- **Current major: AI SDK 7** ("v7 (Latest)" on ai-sdk.dev; migration guide at `/docs/migration-guides/migration-guide-7-0`).
- Internal deps of `ai@7.0.52`: `@ai-sdk/gateway@4.0.41`, `@ai-sdk/provider@4.0.5`, `@ai-sdk/provider-utils@5.0.21`.
- **ESM-only**: `require()` is not supported. Use `import` and `"type": "module"` in package.json. Node.js **22+** required.
- Install (from official Node.js getting-started):
  ```bash
  pnpm add ai zod dotenv
  pnpm add -D @types/node tsx typescript
  ```
- **Model parameter accepts plain strings** like `model: "xai/grok-4.5"` or `model: 'openai/text-embedding-3-small'` — these route through the **Vercel AI Gateway**, authenticated via the `AI_GATEWAY_API_KEY` env var. Provider instances (`openai('gpt-4o')`, `openrouter.chat('...')`) bypass the gateway and use the provider's own key.
- Codemods for migrating older code: `npx @ai-sdk/codemod v7`.

### Renames you must know (v7 migration guide, verified)

| Old (v4/v5/v6) | v7 |
|---|---|
| `generateObject` / `streamObject` | **Removed.** Use `generateText` / `streamText` + `output: Output.object(...)` |
| tool `parameters` (v4) | `inputSchema` (since v5, still current in v7) |
| `maxSteps` (v4) | `stopWhen` (since v5) |
| `stepCountIs` (v5/v6) | **`isStepCount`** |
| `system` option | **`instructions`** |
| `experimental_output` | `output` |
| `experimental_telemetry` | `telemetry` (requires `@ai-sdk/otel` registration) |
| `onFinish` / `onStepFinish` | `onEnd` / `onStepEnd` |
| `result.fullStream` (streamText) | `result.stream` |
| `result.totalUsage` | deprecated — `result.usage` is now aggregated across ALL steps |
| final-step-only data | moved to `result.finalStep` |
| `usage.cachedInputTokens` | `usage.inputTokenDetails.cacheReadTokens` |
| `usage.reasoningTokens` | `usage.outputTokenDetails.reasoningTokens` |
| `experimental_prepareStep` | `prepareStep` |
| `experimental_activeTools` | `activeTools` |
| `ToolCallOptions` type | `ToolExecutionOptions` |
| `Agent` class (v5/v6) | `ToolLoopAgent` (an `Agent` *interface* still exists at `/docs/reference/ai-sdk-core/agent`) |

Also: **system messages inside `prompt`/`messages` are rejected by default** in v7 — put system text in top-level `instructions`, or pass `allowSystemInMessages: true`.

---

## 2. Structured output (the old `generateObject`)

`generateObject` **no longer exists in v7**. Structured generation is unified into
`generateText`/`streamText` via the `output` option and the `Output` helpers
(`import { Output } from 'ai'`).

### Basic usage (verified example from docs)

```ts
import { generateText, Output } from 'ai';
import { z } from 'zod';

const { output } = await generateText({
  model: "xai/grok-4.5",
  output: Output.object({
    schema: z.object({
      recipe: z.object({
        name: z.string(),
        ingredients: z.array(
          z.object({ name: z.string(), amount: z.string() }),
        ),
        steps: z.array(z.string()),
      }),
    }),
  }),
  prompt: 'Generate a lasagna recipe.',
});
// `output` is fully typed to the zod schema.
```

The result property is **`result.output`** (not `result.object`).

### Output variants (all verified)

- `Output.text()` — plain text (default behavior).
- `Output.object({ schema, name?, description? })` — schema: zod, JSON Schema, or custom (`FlexibleSchema<OBJECT>`); `name`/`description` are optional provider-level guidance.
- `Output.array({ element, name?, description? })` — validates each element; with `streamText` use `result.elementStream` to iterate complete validated elements.
- `Output.choice({ options: ['sunny','rainy','snowy'] as const })` — enum classification; output typed as the union.
- `Output.json()` — arbitrary JSON, validity only, no schema enforcement.

### How schema descriptions reach the model

`.describe()` on zod fields is passed to the model as property-level guidance (docs
show this as the canonical way to steer field content):

```ts
output: Output.object({
  schema: z.object({
    name: z.string().describe('The name of the recipe'),
    ingredients: z
      .array(z.object({
        name: z.string(),
        amount: z.string().describe('The amount (grams or ml)'),
      }))
      .describe('List of ingredients with amounts'),
    steps: z.array(z.string()).describe('Step-by-step instructions'),
  }),
}),
```

`Output.object`'s optional top-level `name` and `description` params provide
schema-level guidance to providers that support it.

### Error handling — `NoObjectGeneratedError` (error name `AI_NoObjectGeneratedError`)

Thrown when the provider "fails to generate a parsable object that conforms to the
schema": (1) no response, (2) unparsable response, (3) schema validation failure.

Properties (verified from the error reference page):
- `message` — defaults to `'No object generated.'`
- `text?` — raw text (or tool-call text) the model produced
- `response` — response metadata (id, timestamp, model)
- `usage` — request token usage
- `finishReason?` — e.g. `'length'` when the model hit max tokens
- `cause?` — e.g. the underlying JSON parse error

```ts
import { generateText, NoObjectGeneratedError, Output } from 'ai';

try {
  const result = await generateText({ model, output: Output.object({ schema }), prompt });
  console.log(result.output);
} catch (error) {
  if (NoObjectGeneratedError.isInstance(error)) {
    console.log('Cause:', error.cause);
    console.log('Text:', error.text);
    console.log('Response:', error.response);
    console.log('Usage:', error.usage);
    console.log('Finish Reason:', error.finishReason);
  }
}
```

Docs also export a `NoOutputGeneratedError` (seen in the structured-data guide's
import list). Exact trigger conditions for it: **UNVERIFIED**.

---

## 3. generateText with tools

### `tool()` helper (verified reference)

The schema field is **`inputSchema`** (NOT `parameters` — that was AI SDK 4.x).

```ts
import { tool } from 'ai';
import { z } from 'zod';

export const weatherTool = tool({
  description: 'Get the weather in a location',
  inputSchema: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async ({ location }) => ({
    location,
    temperature: 72 + Math.floor(Math.random() * 21) - 10,
  }),
});
```

Full property list:
- `description` — string, or a function deriving from context.
- `inputSchema` — required; zod or JSON schema. Use `.describe()` on fields so the model understands inputs.
- `execute?` — `async (input, options: ToolExecutionOptions<CONTEXT>) => RESULT | Promise<RESULT> | AsyncIterable<RESULT>`. `options` contains `toolCallId`, `messages`, `abortSignal`, `context`, `experimental_sandbox`. A tool WITHOUT `execute` halts the loop (client-executed tools).
- `outputSchema?` — type inference for the tool result.
- `contextSchema?` — types the tool-specific `context` passed via call options.
- `toModelOutput?` — converts the tool result into model-facing output format.

Tool approval: `needsApproval` on the tool definition is deprecated in v7 → use
`toolApproval` in call options.

### Multi-step loops: `stopWhen` + `isStepCount` (verified)

- **There is no `maxSteps` parameter** in v7. Loop control is `stopWhen`.
- `generateText` default: `stopWhen: isStepCount(1)` (single step unless you raise it).
- `ToolLoopAgent` default: `isStepCount(20)` (safety cap).
- Built-in stop conditions (import from `'ai'`):
  - `isStepCount(count)` — stop after N steps
  - `hasToolCall(...toolNames)` — stop when any named tool is called
  - `isLoopFinished()` — never triggers; run until naturally finished
- `stopWhen` accepts a single condition or an array (any match stops).
- The loop also stops when: finish reason is anything other than `tool-calls`, an
  invoked tool has no `execute` function, or a tool call needs approval.

```ts
import { generateText, isStepCount, hasToolCall } from 'ai';

const result = await generateText({
  model: "xai/grok-4.5",
  instructions: 'You are a helpful research agent.',   // NOT `system` in v7
  tools: { weather: weatherTool, calculator: calculatorTool },
  toolChoice: 'auto', // 'auto' | 'none' | 'required' | { type: 'tool', toolName: '...' }
  stopWhen: [isStepCount(10), hasToolCall('done')],
  prompt: 'What is the weather in NYC and what is 100 * 25?',
});
```

### `prepareStep` — per-step reconfiguration (verified)

Runs before each step; receives `{ stepNumber, messages, initialMessages, responseMessages }`;
return partial overrides: `model`, call settings (`maxOutputTokens`, `temperature`, `topP`,
`topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, `reasoning`),
`activeTools`, `toolChoice`, `instructions`, `messages`.

```ts
prepareStep: async ({ stepNumber }) => {
  if (stepNumber <= 2) {
    return { activeTools: ['search'], toolChoice: 'required' };
  }
  return {};
},
```

### Reading the result (verified from generate-text reference)

```ts
result.text            // concatenation of text parts of the FINAL step
result.content         // ContentPart[] accumulated across ALL steps (v7 change)
result.toolCalls       // TypedToolCall[] — accumulated across ALL steps (v7 change)
result.toolResults     // TypedToolResult[] — accumulated across ALL steps
result.usage           // LanguageModelUsage — aggregated across ALL steps (v7 change;
                       //   totalUsage is deprecated)
result.finishReason    // 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'
result.steps           // StepResult[] — one per step
result.finalStep       // shortcut for steps.at(-1) (final-step-only data lives here)
result.output          // structured output when an Output spec was given
result.responseMessages // ResponseMessage[] accumulated during generation
result.response        // { id, modelId, timestamp, messages: ResponseMessage[] }
```

`StepResult` fields: `stepNumber`, `model: { provider, modelId }`, `content`, `text`,
`finishReason`, `usage` (per-step), `toolCalls`, `toolResults`, `performance`
(`StepResultPerformance` — internal shape UNVERIFIED), `response`, `warnings?`.

`LanguageModelUsage`:
```ts
{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: LanguageModelInputTokenDetails;   // e.g. .cacheReadTokens
  outputTokenDetails?: LanguageModelOutputTokenDetails; // e.g. .reasoningTokens
  raw?: object;                                         // provider-raw usage
}
```

Multi-turn conversation loop: push `result.responseMessages` back onto your
`ModelMessage[]` history (docs' manual-loop example does exactly this).

### `ToolLoopAgent` — reusable agent (verified reference)

```ts
import { ToolLoopAgent, isStepCount } from 'ai';

const assistant = new ToolLoopAgent({
  model: "xai/grok-4.5",
  instructions: 'You are a helpful assistant.',
  tools: { weather: weatherTool, calculator: calculatorTool },
  stopWhen: isStepCount(3),        // default isStepCount(20)
  // also: toolChoice, toolOrder, activeTools, toolApproval, output (Output spec)
});

const result = await assistant.generate({
  prompt: 'What is the weather in NYC and what is 100 * 25?',
});
console.log(result.text, result.steps);
```

Methods: `generate()` → `GenerateTextResult`; `stream()` → `StreamTextResult`.

---

## 4. streamText (brief — for dashboards)

```ts
import { streamText } from 'ai';

const result = streamText({            // NOT awaited — returns immediately
  model: "xai/grok-4.5",
  prompt: 'Explain quantum computing',
});

// 1) Text-only consumption
for await (const delta of result.textStream) process.stdout.write(delta);

// 2) Full typed part stream (v7: `stream`, formerly `fullStream`)
for await (const chunk of result.stream) {
  if (chunk.type === 'text-delta') console.log(chunk.text);
  // other part types: tool calls, reasoning, etc.
}

// 3) Promises that resolve when the stream finishes
const usage = await result.usage;      // aggregated LanguageModelUsage
const output = await result.output;    // when using Output.object()/array()/...
```

- Callbacks: `onChunk` (per part; awaiting it applies backpressure — "the stream
  processing will pause until the callback promise is resolved"), `onStepEnd`
  (StepResult per step), `onEnd` (final; includes `totalUsage`/accumulated results).
- With `Output.array({ element })`, use `result.elementStream` to iterate complete
  validated elements. Partial streamed objects are NOT schema-validated mid-stream.
- UI helpers (`toUIMessageStreamResponse` etc.) exist in the UI layer: exact v7 names
  **UNVERIFIED** here — check `/docs/reference/ai-sdk-ui` before using.

---

## 5. OpenRouter community provider

Package: **`@openrouter/ai-sdk-provider@3.0.0`** — peerDeps `ai: ^7.0.0`,
`zod ^3.25.76 || ^4.1.8`, Node >= 22, ESM. (v3 is the v7-compatible line; older
`@openrouter/ai-sdk-provider` majors target older `ai` majors.)

```bash
pnpm add @openrouter/ai-sdk-provider
```

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, Output, isStepCount } from 'ai';

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY, // from https://openrouter.ai/keys
});

const result = await generateText({
  model: openrouter.chat('anthropic/claude-3.5-sonnet'), // chat models
  // openrouter.completion('meta-llama/llama-3.1-405b-instruct') for completion models
  tools: { weather: weatherTool },
  stopWhen: isStepCount(5),
  output: Output.object({ schema }),   // works like any other provider model
  prompt: '...',
});
```

- A provider-model instance drops in anywhere `model:` is accepted (generateText,
  streamText, ToolLoopAgent).
- Default env var: the docs example passes `apiKey` explicitly; whether the provider
  auto-reads `OPENROUTER_API_KEY` when `apiKey` is omitted: **UNVERIFIED** (pass it
  explicitly to be safe).
- Extra settings (reasoning params, usage accounting passthrough): exist per
  OpenRouter's own docs but exact v3 option names **UNVERIFIED** here.

---

## 6. Embeddings

```ts
import { embed, embedMany } from 'ai';

// Single value
const { embedding, usage } = await embed({
  model: 'openai/text-embedding-3-small',   // gateway string, or
  // model: openai.embeddingModel('text-embedding-3-small')
  value: 'sunny day at the beach',
});
// embedding: number[];  usage.tokens: number

// Batch — auto-chunks past provider limits, preserves input order
const { embeddings } = await embedMany({
  model: 'openai/text-embedding-3-small',
  values: [
    'sunny day at the beach',
    'rainy afternoon in the city',
    'snowy night in the mountains',
  ],
  maxParallelCalls: 2,   // optional; default Infinity
});
// embeddings: number[][] — same order as `values`
```

- `embed` returns: `embedding: number[]`, `value`, `usage: EmbeddingModelUsage`
  (**`usage.tokens`** = input token count), `providerMetadata?`, `response?`.
- `embedMany` returns: `embeddings: number[][]`, `values`, `usage`, `providerMetadata?`.
- Both accept `maxRetries`, `abortSignal`, `headers`, `providerOptions`, `telemetry`.
- Provider embedding-model accessor in v7: `openai.embeddingModel('...')`
  (older `openai.embedding('...')` / `.textEmbeddingModel(...)` naming: superseded).

---

## 7. Telemetry & token usage

### Where usage lives on results

| Call | Where |
|---|---|
| `generateText` | `result.usage` (aggregated across all steps); per-step in `result.steps[i].usage`; final step in `result.finalStep.usage`. `result.totalUsage` is deprecated. |
| `streamText` | `await result.usage` (promise); `onEnd` callback receives `totalUsage`; `onStepEnd` receives per-step usage. |
| structured output failure | `NoObjectGeneratedError.usage` |
| `embed`/`embedMany` | `result.usage.tokens` |

Usage shape: `{ inputTokens?, outputTokens?, totalTokens?, inputTokenDetails? (.cacheReadTokens), outputTokenDetails? (.reasoningTokens), raw? }`.

### OpenTelemetry (v7 architecture — verified)

Telemetry moved out of core into **`@ai-sdk/otel`**. It is **off by default** and
enabled by registering the integration once at startup:

```ts
import { registerTelemetry } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';

registerTelemetry(new OpenTelemetry());
// custom tracer: pass it to the OpenTelemetry constructor (the old `tracer`
// per-call option was removed)
```

Per-call option (renamed from `experimental_telemetry`):

```ts
const result = await generateText({
  model: "xai/grok-4.5",
  prompt: 'Write a short story about a cat.',
  telemetry: {
    functionId: 'story-agent',
    isEnabled: true,
    // recordInputs: false, recordOutputs: false  — both recorded by default
  },
});
```

Spans follow GenAI Semantic Conventions:
1. `invoke_agent {modelId}` — root span for the whole operation
2. `chat {modelId}` — one per LLM provider call (step)
3. `execute_tool {toolName}` — nested tool executions

Each span captures model, usage, finish reason, and (unless disabled) input/output
messages.

---

## 8. Gotchas checklist

1. **`generateObject`/`streamObject` are GONE in v7** — use `generateText`/`streamText` + `output: Output.object({ schema })`; read `result.output`.
2. Tool schema field is **`inputSchema`** (v4's `parameters` is long gone).
3. Step limiting is **`stopWhen: isStepCount(n)`** — `maxSteps` doesn't exist, and v5/v6's `stepCountIs` was renamed to `isStepCount` in v7.
4. **`system` → `instructions`**; system-role messages inside `messages` throw unless `allowSystemInMessages: true`.
5. `result.usage` is now the ALL-steps aggregate; final-step data is under `result.finalStep`; `totalUsage` deprecated.
6. streamText's full part stream is `result.stream` (was `fullStream`).
7. Callbacks renamed: `onFinish`→`onEnd`, `onStepFinish`→`onStepEnd`.
8. ESM-only + Node 22+ — CommonJS `require('ai')` fails.
9. Telemetry needs `@ai-sdk/otel` + `registerTelemetry(...)`; the option is `telemetry` not `experimental_telemetry`.
10. Cached/reasoning token counts moved into `usage.inputTokenDetails.cacheReadTokens` / `usage.outputTokenDetails.reasoningTokens`.
11. Request/response bodies are excluded from results by default; opt in via `include: { requestBody: true, responseBody: true }`.
12. Bare-string model ids (`"xai/grok-4.5"`) go through Vercel AI Gateway and need `AI_GATEWAY_API_KEY`; use a provider instance (e.g. OpenRouter) to avoid the gateway.
13. `@openrouter/ai-sdk-provider` must be **v3.x** for `ai@7`; v2 targets older majors.
14. Migration codemods: `npx @ai-sdk/codemod v7`.
