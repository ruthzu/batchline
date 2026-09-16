import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";
import { recordBatchTool } from "./tools/record-batch.js";
import { correctBatchTool } from "./tools/correct-batch.js";
import { traceLotTool } from "./tools/trace-lot.js";

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

async function main() {
  const port = parseInt(process.env.PORT ?? "3001", 10);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await server.connect(transport);

  const httpServer = createServer((req, res) => {
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
