import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";
import { recordBatchTool } from "./tools/record-batch.js";
import { correctBatchTool } from "./tools/correct-batch.js";
import { traceLotTool, TraceLotToolError } from "./tools/trace-lot.js";
import { previewResponseTool } from "./tools/preview-response.js";
import { commitResponseTool } from "./tools/commit-response.js";

import type {
  Lot,
  Batch,
  Order,
  BatchIngredientLink,
  BatchOrderLink,
  CorrectionRecord,
  IdempotencyRecord,
} from "@batchline/shared";

const server = new McpServer({
  name: "batchline",
  version: "0.1.0",
});

server.tool(
  "ping",
  "Health check endpoint",
  {},
  async () => {
    return {
      content: [{ type: "text", text: "pong" }],
    };
  },
);

server.registerTool(
  "record_batch",
  {
    description: "Record a new production batch with its ingredient lots linked",
    inputSchema: recordBatchTool.schema,
  },
  recordBatchTool.handler,
);

server.registerTool(
  "correct_batch_record",
  {
    description: "Correct a wrong ingredient lot on an existing batch record",
    inputSchema: correctBatchTool.schema,
  },
  correctBatchTool.handler,
);

server.registerTool(
  "trace_ingredient_lot",
  {
    description: "Trace where an ingredient lot was used across batches and which customer orders those batches shipped to",
    inputSchema: traceLotTool.schema,
  },
  traceLotTool.handler,
);

server.registerTool(
  "preview_response",
  {
    description: "Draft the customer response for a set of affected orders without changing anything, returning a previewId to approve",
    inputSchema: previewResponseTool.schema,
  },
  previewResponseTool.handler,
);

server.registerTool(
  "commit_approved_response",
  {
    description: "Execute an approved response preview, putting each order on hold, marking it notified, or flagging it, exactly once per idempotency key",
    inputSchema: commitResponseTool.schema,
  },
  commitResponseTool.handler,
);

// --- REST API routes (coexist with MCP transport on the same HTTP server) ---

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";

function setCorsHeaders(res: any): void {
  res.setHeader("Access-Control-Allow-Origin", DASHBOARD_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: any, status: number, body: object): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function parseQuery(reqUrl: string): Record<string, string> {
  const params = new URLSearchParams(reqUrl.split("?")[1] ?? "");
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    out[key] = value;
  }
  return out;
}

async function handleTraceLot(req: any, res: any): Promise<void> {
  // CORS: the dashboard (localhost:3000) fetches this endpoint cross-origin,
  // so EVERY response — success or error — must carry the allow-origin headers,
  // not just the OPTIONS preflight, or the browser blocks the body and fetch
  // rejects with "Failed to fetch".
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { code: "METHOD_NOT_ALLOWED", message: "Use GET" });
    return;
  }

  const query = parseQuery(req.url);
  const lotId = query.lotId;

  if (!lotId || typeof lotId !== "string" || lotId.trim().length === 0) {
    sendJson(res, 400, { code: "BAD_REQUEST", message: "lotId query parameter is required" });
    return;
  }

  try {
    // Call the SAME handler the MCP tool uses — same Zod validation, same logic.
    const result = await traceLotTool.handler({ lotId });
    // The MCP handler returns { content: [{ type: "text", text: "<json>" }] }.
    // Strip the MCP wrapper and return the raw JSON.
    const body = JSON.parse(result.content[0].text);
    sendJson(res, 200, body);
  } catch (error) {
    if (error instanceof TraceLotToolError) {
      if (error.error.code === "LOT_NOT_FOUND") {
        sendJson(res, 404, { code: error.error.code, message: error.error.message });
        return;
      }
      // Other typed TraceLotToolError codes — treat as 500.
      sendJson(res, 500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred" });
      return;
    }
    // Unexpected errors — never leak internals.
    console.error("Unexpected error in /api/trace-lot:", error);
    sendJson(res, 500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred" });
  }
}

async function main() {
  const port = parseInt(process.env.PORT ?? "3001", 10);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    // Intercept REST API paths before handing off to the MCP transport.
    if (req.url?.startsWith("/api/")) {
      if (req.url.startsWith("/api/trace-lot")) {
        handleTraceLot(req, res);
        return;
      }
      // Unknown /api/* — 404, don't pass to MCP transport.
      sendJson(res, 404, { code: "NOT_FOUND", message: "Unknown API endpoint" });
      return;
    }
    // Everything else: MCP Streamable HTTP transport.
    transport.handleRequest(req, res);
  });

  httpServer.listen(port, () => {
    console.log("Batchline MCP server listening on port", port);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
