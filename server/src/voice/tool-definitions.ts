import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { recordBatchTool } from "../tools/record-batch.js";
import { correctBatchTool } from "../tools/correct-batch.js";
import { traceLotTool } from "../tools/trace-lot.js";
import { previewResponseTool } from "../tools/preview-response.js";
import { commitResponseTool } from "../tools/commit-response.js";
import { registerOrderTool } from "../tools/register-order.js";
import { updateCollectionStatusTool } from "../tools/update-collection-status.js";

// Tool names, descriptions, and Zod schemas are the SAME ones registered on
// the MCP server in src/index.ts — they are not reinvented here. The only
// transformation is Zod -> JSON Schema, which is what Groq's
// OpenAI-compatible chat completions API expects for tool calling.
const VOICE_TOOLS = [
  {
    name: "record_batch",
    description: "Record a new production batch with its ingredient lots linked",
    schema: recordBatchTool.schema,
  },
  {
    name: "correct_batch_record",
    description: "Correct a wrong ingredient lot on an existing batch record",
    schema: correctBatchTool.schema,
  },
  {
    name: "trace_ingredient_lot",
    description: "Trace where an ingredient lot was used across batches and which customer orders those batches shipped to",
    schema: traceLotTool.schema,
  },
  {
    name: "preview_response",
    description: "Draft the customer response for a set of affected orders without changing anything, returning a previewId to approve",
    schema: previewResponseTool.schema,
  },
  {
    name: "commit_approved_response",
    description: "Execute an approved response preview, putting each order on hold, marking it notified, or flagging it, exactly once per idempotency key",
    schema: commitResponseTool.schema,
  },
  {
    name: "register_order",
    description: "Register a new customer order linked to an existing batch, with its collection status stated explicitly",
    schema: registerOrderTool.schema,
  },
  {
    name: "update_collection_status",
    description: "Mark a customer order's physical pickup state as collected or uncollected, recording who changed it",
    schema: updateCollectionStatusTool.schema,
  },
] as const;

// ---------------------------------------------------------------------------
// VOICE-LAYER CONVENIENCE TOOLS — NOT MCP TOOLS.
//
// Everything above mirrors a tool the MCP server actually registers in
// src/index.ts. The two entries below do NOT: they are never registered on
// the MCP server, never exported over the wire to MCP clients, and exist only
// so the voice conversation can span requests. Their arguments are validated
// with Zod exactly like the real ones, and their server-side resolution calls
// the REAL tools underneath (previewResponseTool / commitResponseTool) — no
// ledger behavior is reimplemented here.
// ---------------------------------------------------------------------------

// Which action to take for each collection-status bucket of the last trace.
// Every bucket is optional: the baker only ever names some of them, and the
// buckets they didn't mention are skipped, not guessed.
export const draftResponsePolicySchema = z.object({
  uncollected: z.enum(["hold", "notify", "flag"]).optional(),
  collected: z.enum(["hold", "notify", "flag"]).optional(),
  incomplete: z.enum(["hold", "notify", "flag"]).optional(),
});

export type DraftResponsePolicy = z.infer<typeof draftResponsePolicySchema>;

const VOICE_ONLY_TOOLS = [
  {
    name: "draft_response_from_trace",
    description:
      "Draft a customer response from the ingredient lot traced earlier in THIS conversation, applying one action (hold, notify or flag) to each collection-status bucket the baker mentioned. Voice-layer convenience: the server resolves the buckets against the stored trace and orders, so no order IDs are ever spoken or supplied. Changes nothing.",
    schema: draftResponsePolicySchema,
  },
  {
    name: "approve_pending_response",
    description:
      "Commit the response draft that is pending in THIS conversation, after the baker explicitly approves it (\"approve\", \"yes\", \"go ahead\"). Voice-layer convenience: takes no arguments — the preview and its order actions come from the session, and it is safe to repeat because the commit is idempotent.",
    schema: z.object({}),
  },
] as const;

export type VoiceOnlyToolName = (typeof VOICE_ONLY_TOOLS)[number]["name"];

// Everything Groq may call: the 7 real MCP tools plus the 2 voice-only ones.
const ALL_VOICE_TOOLS = [...VOICE_TOOLS, ...VOICE_ONLY_TOOLS];

export type VoiceToolName = (typeof ALL_VOICE_TOOLS)[number]["name"];

// Groq speaks the OpenAI "tools" dialect: each entry is
// { type: "function", function: { name, description, parameters } }.
// zodToJsonSchema adds a "$schema" key that the API does not want, so it is
// stripped from the generated parameters object.
export const voiceToolDefinitions = ALL_VOICE_TOOLS.map((tool) => {
  const jsonSchema = zodToJsonSchema(tool.schema, {
    $refStrategy: "none",
  }) as Record<string, unknown>;
  const { $schema: _ignored, ...parameters } = jsonSchema;

  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
  };
});

export function getVoiceToolDefinition(name: string) {
  return voiceToolDefinitions.find(
    (tool) => tool.function.name === name
  );
}

export function getVoiceToolSchema(name: string) {
  const tool = ALL_VOICE_TOOLS.find((tool) => tool.name === name);
  return tool ? tool.schema : null;
}
