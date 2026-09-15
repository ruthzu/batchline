import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createDynamoDbClient } from "../src/db/client.js";

const TABLE_NAME = process.env.DYNAMODB_TABLE ?? "Batchline";

export async function provisionTable(client: DynamoDBClient = createDynamoDbClient()) {
  try {
    await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    console.log(`Table "${TABLE_NAME}" already exists`);
    return;
  } catch {}

  console.log(`Creating table "${TABLE_NAME}"...`);
  await client.send(
    new CreateTableCommand({
      TableName: TABLE_NAME,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );

  await waitForTableReady(client, TABLE_NAME);
  console.log(`Table "${TABLE_NAME}" ready`);
}

async function waitForTableReady(client: DynamoDBClient, tableName: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
    if (described.Table?.TableStatus === "ACTIVE") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Table "${tableName}" did not become ACTIVE within ${timeoutMs}ms`);
}

provisionTable().catch((error) => {
  console.error(error);
  process.exit(1);
});
