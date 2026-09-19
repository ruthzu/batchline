import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * SERVER-SIDE ONLY.
 *
 * This module reads AWS settings from environment variables and must never be
 * imported by a "use client" component — only by API routes and Server
 * Components. It mirrors the pattern in server/src/db/client.ts:
 *
 * - DYNAMODB_LOCAL=true -> DynamoDB Local on localhost:8000 with throwaway
 *   credentials (the local endpoint only accepts the dummy credentials below).
 * - Anything else       -> a real AWS environment: region comes from
 *   AWS_REGION, credentials/endpoint from the ambient AWS config chain.
 *
 * TABLE_NAME matches the server's single-table design (see database.md).
 */
const isLocal = process.env.DYNAMODB_LOCAL === "true";

const client = new DynamoDBClient(
  isLocal
    ? {
        region: process.env.AWS_REGION ?? "local",
        endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
        credentials: {
          accessKeyId: "LOCALDYNAMODB",
          secretAccessKey: "LOCALDYNAMODB",
        },
      }
    : {
        region: process.env.AWS_REGION ?? "us-east-1",
        // credentials and endpoint resolve through the default AWS SDK chain
      },
);

export const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME ?? "batchline";

export const documentClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});
