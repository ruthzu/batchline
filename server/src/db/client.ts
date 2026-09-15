import { DynamoDBClient, ListTablesCommand, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const client = new DynamoDBClient({
  region: "local",
  endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  credentials: {
    accessKeyId: "LOCALDYNAMODB",
    secretAccessKey: "LOCALDYNAMODB",
  },
});

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME ?? "batchline";

export const documentClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

export { TABLE_NAME, client, marshall, unmarshall };

export async function ensureTableExists(): Promise<void> {
  const { TableNames } = await client.send(new ListTablesCommand({}));
  if (!TableNames?.includes(TABLE_NAME)) {
    console.log(`Creating DynamoDB table '${TABLE_NAME}'...`);
    await client.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "GSI1PK", AttributeType: "S" },
          { AttributeName: "GSI1SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "GSI1PK", KeyType: "HASH" },
              { AttributeName: "GSI1SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        BillingMode: "PAY_PER_REQUEST",
      })
    );
    console.log(`Table '${TABLE_NAME}' created successfully`);
  } else {
    console.log(`Table '${TABLE_NAME}' already exists`);
  }
}
