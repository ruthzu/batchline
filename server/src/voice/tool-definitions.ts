import { zodToJsonSchema } from "zod-to-json-schema";
import { recordBatchTool } from "../tools/record-batch.js";
import { correctBatchTool } from "../tools/correct-batch.js";
import { traceLotTool } from "../tools/trace-lot.js";
import { previewResponseTool } from "../tools/preview-response.js";
import { commitResponseTool } from "../tools/commit-response.js";
import { registerOrderTool } from "../tools/register-order.js";

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
] as const;

export type VoiceToolName = (typeof VOICE_TOOLS)[number]["name"];

// Groq speaks the OpenAI "tools" dialect: each entry is
// { type: "function", function: { name, description, parameters } }.
// zodToJsonSchema adds a "$schema" key that the API does not want, so it is
// stripped from the generated parameters object.
export const voiceToolDefinitions = VOICE_TOOLS.map((tool) => {
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
  const tool = VOICE_TOOLS.find((tool) => tool.name === name);
  return tool ? tool.schema : null;
}
