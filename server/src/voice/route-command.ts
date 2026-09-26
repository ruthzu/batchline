import Groq from "groq-sdk";
import { z } from "zod";
import { recordBatchTool, RecordBatchToolError } from "../tools/record-batch.js";
import { correctBatchTool, CorrectBatchToolError } from "../tools/correct-batch.js";
import { traceLotTool, TraceLotToolError } from "../tools/trace-lot.js";
import { previewResponseTool, PreviewResponseToolError } from "../tools/preview-response.js";
import { commitResponseTool, CommitResponseToolError } from "../tools/commit-response.js";
import { registerOrderTool, RegisterOrderToolError } from "../tools/register-order.js";
import { getVoiceToolSchema, voiceToolDefinitions } from "./tool-definitions.js";
import type { TraceLotResult } from "@batchline/shared";

// NOTE: the originally requested "llama-3.3-70b-versatile" has been retired
// from Groq's API (404 model_not_found as of Sep 2026). openai/gpt-oss-120b is
// the strongest available chat model with tool-calling support. Override with
// GROQ_MODEL in server/.env if Groq adds new models.
const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

// What the voice client displays and speaks back to the baker.
export type VoiceCommandResult = {
  transcript: string;
  toolCalled: string | null;
  toolArgs: object | null;
  spokenResponse: string;
  raw?: object;
};

type TypedToolError = {
  code: string;
  message: string;
};

// The system prompt keeps the model narrow: pick one tool, extract exactly
// what the baker said, and prefer asking over guessing.
const SYSTEM_PROMPT = `You are the voice interface for Batchline, a bakery production ledger.

Your ONLY job is to pick the single correct tool and extract its arguments from what the baker said.

Rules:
- NEVER guess a value that was not clearly stated. If a required argument like a batchId or lotId was not spoken, do NOT invent one — instead reply asking the baker for it.
- If the transcript does not clearly map to one of the available tools, do not force a match. Reply asking the baker to rephrase.
- When you call a tool, fill only the arguments the baker actually said. Dates said as words ("today", "yesterday") should be converted to ISO 8601 (YYYY-MM-DD).
- Keep replies to one or two short spoken-style sentences.`;

// Lazy Groq client: constructing at module load would crash the whole server
// on startup when GROQ_API_KEY isn't set. This way the server still boots and
// routeVoiceCommand can return a friendly "not configured" response instead.
let groqClient: Groq | null = null;
function getGroqClient(): Groq {
  if (!groqClient) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

// One dispatch table per tool: run the REAL handler the MCP server registers,
// then turn its JSON-string content into an object, and turn its typed errors
// into spoken-style text. Nothing here re-implements tool behavior.
const TOOL_EXECUTORS: Record<
  string,
  (args: unknown) => Promise<{ parsed: object; spoken: string }>
> = {
  record_batch: async (args) => {
    const result = await recordBatchTool.handler(
      args as z.infer<typeof recordBatchTool.schema>
    );
    const parsed = JSON.parse(result.content[0].text) as {
      batchId: string;
      lotsLinked: string[];
    };
    const lots = parsed.lotsLinked.length === 1 ? "1 lot" : `${parsed.lotsLinked.length} lots`;
    return {
      parsed,
      spoken: `Batch ${parsed.batchId} recorded with ${lots}.`,
    };
  },

  correct_batch_record: async (args) => {
    const result = await correctBatchTool.handler(
      args as z.infer<typeof correctBatchTool.schema>
    );
    const parsed = JSON.parse(result.content[0].text) as {
      batchId: string;
      originalLotId: string;
      correctedLotId: string;
      affectedOrderIds: string[];
    };
    const orders = parsed.affectedOrderIds.length === 0
      ? "no customer orders were affected"
      : parsed.affectedOrderIds.length === 1
        ? `1 customer order was affected`
        : `${parsed.affectedOrderIds.length} customer orders were affected`;
    return {
      parsed,
      spoken: `On batch ${parsed.batchId}, lot ${parsed.originalLotId} is now corrected to lot ${parsed.correctedLotId}; ${orders}.`,
    };
  },

  trace_ingredient_lot: async (args) => {
    const result = await traceLotTool.handler(
      args as z.infer<typeof traceLotTool.schema>
    );
    const parsed = JSON.parse(result.content[0].text) as TraceLotResult;
    const batchCount = parsed.batches.length === 1 ? "1 batch" : `${parsed.batches.length} batches`;
    return {
      parsed,
      spoken:
        `Lot ${parsed.lotId} was used in ${batchCount}. ` +
        `${parsed.summary.collected} collected, ${parsed.summary.uncollected} awaiting pickup, ${parsed.summary.incomplete} incomplete.`,
    };
  },

  preview_response: async (args) => {
    const result = await previewResponseTool.handler(
      args as z.infer<typeof previewResponseTool.schema>
    );
    const parsed = JSON.parse(result.content[0].text) as {
      previewId: string;
      actions: { orderId: string; action: string }[];
    };
    const n = parsed.actions.length;
    return {
      parsed,
      spoken:
        `Draft ready for ${n === 1 ? "1 order" : `${n} orders`}: ` +
        parsed.actions
          .map((a) => `${a.orderId} ${a.action === "hold" ? "held" : a.action === "notify" ? "notify" : "flag"}`)
          .join(", ") +
        `. Nothing has been sent yet. Say approve, or "commit", followed by the preview ID to execute.`,
    };
  },

  register_order: async (args) => {
    const input = args as z.infer<typeof registerOrderTool.schema>;
    const result = await registerOrderTool.handler(input);
    const parsed = JSON.parse(result.content[0].text) as {
      orderId: string;
      batchId: string;
      status: string;
    };
    return {
      parsed,
      spoken: `Order ${parsed.orderId} registered for ${input.customerName}, linked to batch ${parsed.batchId}.`,
    };
  },

  commit_approved_response: async (args) => {
    const result = await commitResponseTool.handler(
      args as z.infer<typeof commitResponseTool.schema>
    );
    const parsed = JSON.parse(result.content[0].text) as {
      previewId: string;
      committed: { orderId: string; newStatus: string }[];
    };
    const n = parsed.committed.length;
    return {
      parsed,
      spoken:
        `Committed ${n === 1 ? "1 action" : `${n} actions`} from the approved preview. ` +
        parsed.committed
          .map((c) => `${c.orderId} is now ${c.newStatus.replace(/_/g, " ")}`)
          .join(", ") +
        ".",
    };
  },
};

// Typed error codes mapped to spoken-style explanations. Every code here is
// one the tools actually throw; unknown codes fall back to the message.
const SPOKEN_ERRORS: Record<string, (e: TypedToolError) => string> = {
  BATCH_ALREADY_EXISTS: (e) =>
    `Batch ${e.message.match(/'([^']+)'/)?.[1] ?? ""} is already recorded. Corrections go through correct batch record instead, so nothing was changed.`,
  BATCH_NOT_FOUND: (e) =>
    `I couldn't find that batch. ${e.message} Nothing was changed.`,
  ORIGINAL_LOT_NOT_LINKED: (e) =>
    `That ingredient lot isn't recorded on that batch, so there's nothing to correct. Double-check the lot ID and batch ID and try again.`,
  ORIGINAL_LOT_ALREADY_CORRECTED: (e) =>
    `That lot was already corrected once. Batch records can only be corrected once per lot — check the batch record for the newer lot.`,
  LOT_NOT_FOUND: (e) =>
    `I couldn't find that ingredient lot in the system. It may never have been recorded — check the lot ID and try again.`,
  ORDER_NOT_FOUND: (e) =>
    `One of the orders you named doesn't exist, so nothing was drafted or changed.`,
  DUPLICATE_ORDER_ACTION: () =>
    `You mentioned the same order more than once. Each order can only have one action — say it again with each order just once.`,
  IDEMPOTENCY_KEY_REUSED: () =>
    `That approval was already used for a different request. Say the commit again and I'll use a fresh approval key.`,
  ORDER_ALREADY_EXISTS: (e) =>
    `Order ${e.message.match(/'([^']+)'/)?.[1] ?? ""} is already registered, so nothing was changed. Orders can only be registered once — use a new order ID.`,
  INVALID_INGREDIENT_LOT: () =>
    `One of the ingredient lots was missing an ID or quantity. Say the batch again with each lot and its quantity.`,
};

function spokenErrorResponse(e: TypedToolError): string {
  const fn = SPOKEN_ERRORS[e.code];
  if (fn) return fn(e);
  return `That didn't go through: ${e.message}`;
}

// Groq's tool_call.function.arguments is a JSON string. Never trust it
// blindly: validate against the tool's REAL Zod schema before executing.
function parseAndValidateArgs(
  toolName: string,
  rawArgs: string
): { ok: true; args: object } | { ok: false; issues: string } {
  const schema = getVoiceToolSchema(toolName);
  if (!schema) return { ok: false, issues: `unknown tool ${toolName}` };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawArgs);
  } catch {
    return { ok: false, issues: "arguments were not valid JSON" };
  }

  const validated = schema.safeParse(parsedJson);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    return { ok: false, issues };
  }
  return { ok: true, args: validated.data as object };
}

export async function routeVoiceCommand(
  transcript: string
): Promise<VoiceCommandResult> {
  const trimmed = transcript.trim();

  const base: VoiceCommandResult = {
    transcript: trimmed,
    toolCalled: null,
    toolArgs: null,
    spokenResponse: "",
  };

  if (!trimmed) {
    return {
      ...base,
      spokenResponse: "I didn't catch that. What would you like to do?",
    };
  }

  if (!process.env.GROQ_API_KEY) {
    return {
      ...base,
      spokenResponse:
        "Voice routing isn't configured: the server is missing its Groq API key.",
    };
  }

  let completion: Groq.Chat.ChatCompletion;
  try {
    completion = await getGroqClient().chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: trimmed },
      ],
      tools: voiceToolDefinitions,
      tool_choice: "auto",
      temperature: 0,
    });
  } catch (error) {
    console.error("Groq API error:", error);
    return {
      ...base,
      spokenResponse:
        "Sorry, I had trouble reaching the routing service. Please try again in a moment.",
    };
  }

  const message = completion.choices[0]?.message;
  const toolCall = message?.tool_calls?.[0];

  // No tool call -> the model asked a clarifying question instead. That is the
  // desired behavior for ambiguous or under-specified transcripts.
  if (!toolCall || toolCall.type !== "function") {
    return {
      ...base,
      spokenResponse: (message?.content ?? "").trim() ||
        "I'm not sure how to route that. Could you rephrase it?",
    };
  }

  const toolName = toolCall.function.name;
  const validation = parseAndValidateArgs(toolName, toolCall.function.arguments);

  if (!validation.ok) {
    // Groq hallucinated or omitted a required field. Do NOT execute anything;
    // ask the baker for the missing piece instead of crashing or guessing.
    return {
      ...base,
      spokenResponse:
        "I heard a request but I'm missing some details. " +
        `Could you say that again, including everything needed? (Details I couldn't parse: ${validation.issues}.)`,
    };
  }

  const executor = TOOL_EXECUTORS[toolName];
  if (!executor) {
    return {
      ...base,
      spokenResponse:
        "I recognized the command but couldn't route it. Please try rephrasing.",
    };
  }

  try {
    const { parsed, spoken } = await executor(validation.args);
    return {
      ...base,
      toolCalled: toolName,
      toolArgs: validation.args,
      spokenResponse: spoken,
      raw: parsed,
    };
  } catch (error) {
    if (
      error instanceof RecordBatchToolError ||
      error instanceof CorrectBatchToolError ||
      error instanceof TraceLotToolError ||
      error instanceof PreviewResponseToolError ||
      error instanceof CommitResponseToolError ||
      error instanceof RegisterOrderToolError
    ) {
      // Typed tool error: explain it in plain spoken language, not a raw code.
      return {
        ...base,
        toolCalled: toolName,
        toolArgs: validation.args,
        spokenResponse: spokenErrorResponse(error.error as TypedToolError),
        raw: error.error as object,
      };
    }
    // Unexpected infrastructure errors — never leak internals over voice.
    console.error(`Unexpected error executing ${toolName}:`, error);
    return {
      ...base,
      toolCalled: toolName,
      toolArgs: validation.args,
      spokenResponse:
        "Something went wrong while doing that. Nothing may have changed — please try again.",
    };
  }
}
