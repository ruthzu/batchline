import { z } from "zod";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  TraceLotResult,
  TracedBatch,
  TracedOrder,
} from "@batchline/shared";

// Input schema for the trace_ingredient_lot tool
export const traceLotSchema = z.object({
  lotId: z.string().min(1, "lotId is required"),
});

export type TraceLotInput = z.infer<typeof traceLotSchema>;

// TracedOrder / TracedBatch / TraceLotResult are defined in @batchline/shared
// so the server and the dashboard share one authoritative definition instead
// of two copies that can drift apart. Re-exported here so existing imports
// from this module keep working.
export type { TraceLotResult, TracedBatch, TracedOrder };

export type TraceLotError = {
  code: "LOT_NOT_FOUND";
  message: string;
  lotId?: string;
};

// Custom error class for typed errors
export class TraceLotToolError extends Error {
  constructor(
    public readonly error: TraceLotError
  ) {
    super(error.message);
    this.name = "TraceLotToolError";
  }
}

// Query all batch link items for a lot (LOT#<lotId> / BATCH#<batchId>)
// Returns only ACTIVE links - links with a supersededBy field have been
// corrected away, so a different lot is now authoritative for that batch.
// DynamoDB errors propagate to the caller — only empty results are treated as "no data".
async function getActiveBatchIdsForLot(lotId: string): Promise<string[]> {
  const batchIds: string[] = [];

  const queryResult = await documentClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": `LOT#${lotId}`,
        ":skPrefix": "BATCH#",
      },
    })
  );

  if (queryResult.Items) {
    for (const item of queryResult.Items) {
      // Skip superseded links - they were corrected away, so this lot is no
      // longer the authoritative lot for that batch
      if (item.supersededBy) {
        continue;
      }
      if (item.SK && typeof item.SK === "string" && item.SK.startsWith("BATCH#")) {
        const batchId = item.SK.replace("BATCH#", "");
        batchIds.push(batchId);
      }
    }
  }

  return batchIds;
}

// Fetch batch metadata (product, producedDate).
// Returns null only when the item genuinely doesn't exist; DynamoDB errors propagate.
async function getBatchMetadata(batchId: string): Promise<{
  product?: string;
  producedDate?: string;
} | null> {
  const result = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `BATCH#${batchId}`,
        SK: "METADATA",
      },
    })
  );
  if (!result.Item) {
    return null;
  }
  return {
    product: result.Item.product as string | undefined,
    producedDate: result.Item.producedDate as string | undefined,
  };
}

// Query for order links on a batch (BATCH#<batchId> / ORDER#<orderId>)
// Same query style as getAffectedOrderIds in correct-batch.ts.
// DynamoDB errors propagate to the caller.
async function getOrderIdsForBatch(batchId: string): Promise<string[]> {
  const orderIds: string[] = [];

  const queryResult = await documentClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": `BATCH#${batchId}`,
        ":skPrefix": "ORDER#",
      },
    })
  );

  if (queryResult.Items) {
    for (const item of queryResult.Items) {
      if (item.SK && typeof item.SK === "string" && item.SK.startsWith("ORDER#")) {
        const orderId = item.SK.replace("ORDER#", "");
        orderIds.push(orderId);
      }
    }
  }

  return orderIds;
}

// Fetch order metadata (customerName, customerContact, collectionStatus).
// Returns null only when the item genuinely doesn't exist; DynamoDB errors propagate.
async function getOrderMetadata(orderId: string): Promise<{
  customerName?: string;
  customerContact?: string;
  collectionStatus?: string;
} | null> {
  const result = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `ORDER#${orderId}`,
        SK: "METADATA",
      },
    })
  );
  if (!result.Item) {
    return null;
  }
  return {
    customerName: result.Item.customerName as string | undefined,
    customerContact: result.Item.customerContact as string | undefined,
    collectionStatus: result.Item.collectionStatus as string | undefined,
  };
}

export const traceLotTool = {
  schema: traceLotSchema,

  handler: async (input: TraceLotInput) => {
    // Step 0: Verify the lot exists at all - if the lot was never recorded in
    // the system in any form, that's a genuine NOT_FOUND error.
    // DynamoDB errors (network, auth, table missing) propagate as real exceptions.
    const lotResult = await documentClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `LOT#${input.lotId}`,
          SK: "METADATA",
        },
      })
    );

    if (!lotResult.Item) {
      throw new TraceLotToolError({
        code: "LOT_NOT_FOUND",
        message: `Lot with ID '${input.lotId}' was never recorded in the system.`,
        lotId: input.lotId,
      });
    }

    // Step 1: Find all ACTIVE batch links for this lot (skip superseded ones)
    const activeBatchIds = await getActiveBatchIdsForLot(input.lotId);

    // Step 2 & 3: For each active batch, fetch its metadata and orders
    const batches: TracedBatch[] = [];
    const summary = {
      collected: 0,
      uncollected: 0,
      incomplete: 0,
    };

    for (const batchId of activeBatchIds) {
      const batchMetadata = await getBatchMetadata(batchId);

      const tracedOrders: TracedOrder[] = [];
      const orderIds = await getOrderIdsForBatch(batchId);

      for (const orderId of orderIds) {
        const orderMetadata = await getOrderMetadata(orderId);

        // If the order link exists but the order's METADATA item is missing,
        // surface it as "incomplete" rather than erroring out
        let collectionStatus: TracedOrder["collectionStatus"];
        if (!orderMetadata) {
          collectionStatus = "incomplete";
        } else if (
          orderMetadata.collectionStatus === "collected" ||
          orderMetadata.collectionStatus === "uncollected"
        ) {
          collectionStatus = orderMetadata.collectionStatus;
        } else {
          collectionStatus = "incomplete";
        }

        summary[collectionStatus] += 1;

        tracedOrders.push({
          orderId,
          customerName: orderMetadata?.customerName,
          collectionStatus,
        });
      }

      batches.push({
        batchId,
        product: batchMetadata?.product,
        producedDate: batchMetadata?.producedDate,
        orders: tracedOrders,
      });
    }

    const result: TraceLotResult = {
      lotId: input.lotId,
      batches,
      summary,
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
};
