import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";
import { recordBatchTool } from "./tools/record-batch.js";

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
