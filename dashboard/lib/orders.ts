import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { Order } from "@batchline/shared";
import { documentClient, TABLE_NAME } from "./db";

/**
 * Server-side only: read every order from the single table.
 *
 * Order items follow the single-table design (see database.md and the item
 * shapes written by the server tools / test seeds):
 *
 *   PK: ORDER#<orderId>   SK: METADATA   entityType: "ORDER"
 *
 * Attributes carried by a complete ORDER METADATA item:
 *   orderId, customerName, customerContact, status, collectionStatus
 *
 * There is no shared ORDER# partition to Query (each order is its own
 * partition), so this is a Scan with an entityType filter, paginated via
 * LastEvaluatedKey. Fine at dashboard scale; revisit if this ever grows.
 *
 * Orders only mutate through the MCP server's commit_approved_response tool
 * (status: fulfilled -> on_hold | notified | flagged_incomplete), so results
 * must never be cached — the page renders this on every request.
 */
export async function getAllOrders(): Promise<Order[]> {
  const orders: Order[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;

  do {
    const result = await documentClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "#entityType = :entityType",
        ExpressionAttributeNames: { "#entityType": "entityType" },
        ExpressionAttributeValues: { ":entityType": "ORDER" },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of result.Items ?? []) {
      // Skip anything that isn't a complete ORDER METADATA item rather than
      // rendering a broken row.
      if (
        typeof item.orderId === "string" &&
        typeof item.customerName === "string" &&
        typeof item.customerContact === "string" &&
        typeof item.status === "string" &&
        (item.collectionStatus === "collected" ||
          item.collectionStatus === "uncollected" ||
          item.collectionStatus === "incomplete")
      ) {
        orders.push({
          orderId: item.orderId,
          customerName: item.customerName,
          customerContact: item.customerContact,
          status: item.status,
          collectionStatus: item.collectionStatus,
        });
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return orders;
}
