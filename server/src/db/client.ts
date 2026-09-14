import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export function createDynamoDbClient(): DynamoDBClient {
  if (process.env.DYNAMODB_LOCAL === "true") {
    return new DynamoDBClient({
      region: "us-east-1",
      endpoint: "http://localhost:8000",
      credentials: {
        accessKeyId: "dummy",
        secretAccessKey: "dummy",
      },
    });
  }

  return new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
  });
}
