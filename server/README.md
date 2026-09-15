# @batchline/server

MCP server for Batchline.

## Requirements

This server uses the **Streamable HTTP** transport. Legacy SSE transport is deprecated and not supported.

See the [MCP specification 2025-11-25](https://modelcontextprotocol.io/spec) for details on the Streamable HTTP transport.

## DynamoDB Local (offline development)

For local development without an AWS account, run a local DynamoDB instance:

```bash
docker compose up -d
DYNAMODB_LOCAL=true npm run provision:db
```

This starts DynamoDB Local on port 8000 and creates the `Batchline` table. Set `DYNAMODB_LOCAL=true` in your environment when running the server to point the client at the local instance with dummy credentials.
