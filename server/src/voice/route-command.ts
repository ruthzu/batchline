import Groq from "groq-sdk";
import { z } from "zod";
import { recordBatchTool, RecordBatchToolError } from "../tools/record-batch.js";
import { correctBatchTool, CorrectBatchToolError } from "../tools/correct-batch.js";
import { traceLotTool, TraceLotToolError } from "../tools/trace-lot.js";
import { previewResponseTool, PreviewResponseToolError } from "../tools/preview-response.js";
import { commitResponseTool, CommitResponseToolError } from "../tools/commit-response.js";
import { registerOrderTool, RegisterOrderToolError } from "../tools/register-order.js";
import {
  updateCollectionStatusTool,
  UpdateCollectionStatusToolError,
} from "../tools/update-collection-status.js";
import {
  getVoiceToolSchema,
  voiceToolDefinitions,
  type DraftResponsePolicy,
} from "./tool-definitions.js";
import { getSession, setSession } from "./session-store.js";
import type { TraceLotResult } from "@batchline/shared";
import type {
  OrderAction,
  PreviewResponseResult,
  ResponseAction,
} from "../tools/preview-response.js";
import type { CommitResponseResult } from "../tools/commit-response.js";

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
- NEVER produce, invent, guess or read out order IDs. You do not know any order IDs, and none are needed: the server resolves orders from this conversation's trace. If a reply would need an order ID, call a tool instead.
- Keep replies to one or two short spoken-style sentences.

Conversation flow (the server remembers context across turns in this session):
- After a successful trace, when the baker asks to respond, react, draft, hold, notify or flag the affected orders, call draft_response_from_trace. Give one action ("hold", "notify" or "flag") per collection-status bucket the baker actually named — uncollected, collected, incomplete — and OMIT every bucket they did not mention. Do not list orders yourself; the server expands the policy against the stored trace. It drafts and changes nothing.
- When a draft is ready (the reply says nothing has been changed yet), and the baker then says "yes", "approve", "go ahead", "commit" or similar, call approve_pending_response with NO arguments. It commits the draft prepared earlier in this conversation. If they approve again afterwards, approving is safe — it will simply report there is nothing pending.
- If the baker asks for a response before any trace exists in this session, call draft_response_from_trace anyway: the server will ask them to trace a lot first.`;

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

// Per-request context handed to every executor. sessionId is optional: no
// sessionId means the request is stateless and the session store is never
// touched — behavior identical to a server with no conversation memory.
type VoiceExecutionContext = { sessionId?: string };

// ---------------------------------------------------------------------------
// Resolvers for the two voice-only, session-scoped convenience tools.
// Exported so session-flow.test.ts can drive them directly (no Groq involved);
// in production they are reached through the dispatch table below.
// ---------------------------------------------------------------------------

export type VoiceResolverResult = { parsed: object; spoken: string };

// Deterministic bucket order so spoken summaries and stored previews are
// reproducible regardless of how the model ordered the policy it extracted.
const POLICY_BUCKETS = ["uncollected", "collected", "incomplete"] as const;

/**
 * Expand a per-bucket policy against a stored trace into concrete order
 * actions. DEDUPLICATES by orderId: the seeded data links ORDER-2026-0002 to
 * two batches, and preview_response rejects duplicate orderIds, so the same
 * order appearing in several traced batches must yield exactly one action.
 * Buckets the baker did not mention (policy[bucket] undefined) are skipped.
 */
export function expandTraceToActions(
  trace: TraceLotResult,
  policy: DraftResponsePolicy
): OrderAction[] {
  const seen = new Set<string>();
  const actions: OrderAction[] = [];

  for (const bucket of POLICY_BUCKETS) {
    const action = policy[bucket];
    if (!action) continue;

    for (const batch of trace.batches) {
      for (const order of batch.orders) {
        if (order.collectionStatus !== bucket) continue;
        if (seen.has(order.orderId)) continue;
        seen.add(order.orderId);
        actions.push({ orderId: order.orderId, action });
      }
    }
  }

  return actions;
}

// "3 orders on hold, 2 marked notified, 1 order flagged incomplete" — counts
// only, never order IDs: IDs are unreadable over speech and must never be
// model-generated either.
function speakActionCounts(orderActions: OrderAction[]): string {
  const counts: Record<ResponseAction, number> = { hold: 0, notify: 0, flag: 0 };
  for (const { action } of orderActions) counts[action] += 1;

  const parts: string[] = [];
  if (counts.hold > 0) {
    parts.push(`${counts.hold} ${counts.hold === 1 ? "order" : "orders"} on hold`);
  }
  if (counts.notify > 0) {
    parts.push(`${counts.notify} ${counts.notify === 1 ? "order" : "orders"} marked notified`);
  }
  if (counts.flag > 0) {
    parts.push(`${counts.flag} ${counts.flag === 1 ? "order" : "orders"} flagged incomplete`);
  }
  return parts.join(", ");
}

/**
 * draft_response_from_trace — resolve the baker's per-bucket policy against
 * the trace stored earlier in this session and draft it via the REAL
 * previewResponseTool (read-only: nothing is changed).
 */
export async function resolveDraftResponseFromTrace(
  policy: DraftResponsePolicy,
  sessionId?: string
): Promise<VoiceResolverResult> {
  const trace = sessionId ? getSession(sessionId)?.lastTrace?.trace : undefined;

  if (!trace) {
    // No trace in this session (never traced, or the entry expired). Call
    // nothing — there is nothing to draft from.
    return {
      parsed: { traced: false },
      spoken:
        "I don't have a traced ingredient lot in this conversation yet. " +
        "Trace a lot first, then ask me to draft a response from it.",
    };
  }

  const orderActions = expandTraceToActions(trace, policy);

  if (orderActions.length === 0) {
    return {
      parsed: { traced: true, lotId: trace.lotId, orderActions: [] },
      spoken:
        "None of the orders in that trace match the buckets you mentioned, " +
        "so there's nothing to draft. Tell me what to do with the uncollected, " +
        "collected, or incomplete orders.",
    };
  }

  // The REAL preview tool: same Zod validation, same duplicate guard (already
  // satisfied by expandTraceToActions), same previewId a human will approve.
  const result = await previewResponseTool.handler({ orderActions });
  const preview = JSON.parse(result.content[0].text) as PreviewResponseResult;

  if (sessionId) {
    setSession(sessionId, {
      pendingPreview: { preview, orderActions, createdAt: Date.now() },
    });
  }

  return {
    parsed: preview,
    spoken:
      `Draft ready: ${speakActionCounts(orderActions)}. ` +
      "Nothing has been changed yet — say approve when you want me to commit it.",
  };
}

/**
 * approve_pending_response — commit the pending preview in this session via
 * the REAL commitResponseTool, with an idempotencyKey built server-side so a
 * repeated "approve" can never commit twice.
 */
export async function resolveApprovePendingResponse(
  sessionId?: string
): Promise<VoiceResolverResult> {
  const pending = sessionId
    ? getSession(sessionId)?.pendingPreview
    : undefined;

  if (!pending) {
    // Nothing pending: speak that and call nothing.
    return {
      parsed: { pendingPreview: null },
      spoken:
        "There's no draft response waiting for approval in this conversation. " +
        "Trace a lot and ask me to draft one first.",
    };
  }

  const result = await commitResponseTool.handler({
    previewId: pending.preview.previewId,
    orderActions: pending.orderActions,
    // Built here, never spoken or typed by anyone: the baker only says
    // "approve". Repeating it replays the same commit instead of redoing it.
    idempotencyKey: `voice-${pending.preview.previewId}`,
  });
  const committed = JSON.parse(result.content[0].text) as CommitResponseResult;

  // Cleared only after a successful commit, so a failed commit stays pending
  // and can be retried.
  if (sessionId) setSession(sessionId, { pendingPreview: undefined });

  return {
    parsed: committed,
    spoken:
      `Done — ${speakActionCounts(
        committed.committed.map((c) => ({ orderId: c.orderId, action: c.action }))
      )}. That's committed.`,
  };
}

// One dispatch table per tool: run the REAL handler the MCP server registers
// (or, for the two voice-only conveniences, the session resolver above), then
// turn its JSON-string content into an object, and turn its typed errors
// into spoken-style text. Nothing here re-implements tool behavior.
const TOOL_EXECUTORS: Record<
  string,
  (args: unknown, ctx: VoiceExecutionContext) => Promise<{ parsed: object; spoken: string }>
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

  trace_ingredient_lot: async (args, ctx) => {
    const result = await traceLotTool.handler(
      args as z.infer<typeof traceLotTool.schema>
    );
    const parsed = JSON.parse(result.content[0].text) as TraceLotResult;
    // Remember the trace for this conversation: the next turn ("draft a
    // response from it") resolves against this, not against a re-trace.
    if (ctx.sessionId) {
      setSession(ctx.sessionId, {
        lastTrace: { trace: parsed, tracedAt: Date.now() },
      });
    }
    const batchCount = parsed.batches.length === 1 ? "1 batch" : `${parsed.batches.length} batches`;
    return {
      parsed,
      spoken:
        `Lot ${parsed.lotId} was used in ${batchCount}. ` +
        `${parsed.summary.collected} collected, ${parsed.summary.uncollected} awaiting pickup, ${parsed.summary.incomplete} incomplete.`,
    };
  },

  preview_response: async (args, ctx) => {
    const input = args as z.infer<typeof previewResponseTool.schema>;
    const result = await previewResponseTool.handler(input);
    const parsed = JSON.parse(result.content[0].text) as PreviewResponseResult;
    // Store the preview together with EXACTLY the orderActions it was built
    // from, so a later "approve" commits what this preview actually showed.
    if (ctx.sessionId) {
      setSession(ctx.sessionId, {
        pendingPreview: {
          preview: parsed,
          orderActions: input.orderActions,
          createdAt: Date.now(),
        },
      });
    }
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

  update_collection_status: async (args) => {
    const result = await updateCollectionStatusTool.handler(
      args as z.infer<typeof updateCollectionStatusTool.schema>
    );
    const parsed = JSON.parse(result.content[0].text) as {
      orderId: string;
      collectionStatus: string;
      changed: boolean;
    };
    return {
      parsed,
      // "changed: false" is not an error - the order was already in the
      // requested state, and the baker should hear that nothing happened.
      spoken: parsed.changed
        ? `Order ${parsed.orderId} is now marked as ${parsed.collectionStatus}.`
        : `Order ${parsed.orderId} was already marked as ${parsed.collectionStatus}; nothing changed.`,
    };
  },

  // --- The two VOICE-ONLY conveniences (not MCP tools) ---
  draft_response_from_trace: (args, ctx) =>
    resolveDraftResponseFromTrace(args as DraftResponsePolicy, ctx.sessionId),

  approve_pending_response: (_args, ctx) =>
    resolveApprovePendingResponse(ctx.sessionId),

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
    `That order doesn't exist in the system, so nothing was changed. Check the order ID and try again.`,
  DUPLICATE_ORDER_ACTION: () =>
    `You mentioned the same order more than once. Each order can only have one action — say it again with each order just once.`,
  IDEMPOTENCY_KEY_REUSED: () =>
    `That approval was already used for a different request. Say the commit again and I'll use a fresh approval key.`,
  ORDER_ALREADY_EXISTS: (e) =>
    `Order ${e.message.match(/'([^']+)'/)?.[1] ?? ""} is already registered, so nothing was changed. Orders can only be registered once — use a new order ID.`,
  COLLECTION_STATUS_CHANGED_CONCURRENTLY: (e) =>
    `Someone else changed that order's pickup status while I was working. ${e.message} Please say it again and I'll check the current status.`,
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
  transcript: string,
  sessionId?: string
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
    const { parsed, spoken } = await executor(validation.args, { sessionId });
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
      error instanceof RegisterOrderToolError ||
      error instanceof UpdateCollectionStatusToolError
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
