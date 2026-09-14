import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

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

async function main() {
  const transport = new StreamableHTTPServerTransport({
    port: parseInt(process.env.PORT ?? "3001", 10),
  });

  await server.connect(transport);
  console.log("Batchline MCP server listening on port", transport.port);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
