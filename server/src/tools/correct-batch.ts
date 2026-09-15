import { z } from "zod";
import { documentClient, TABLE_NAME } from "../db/client.js";
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

// Input schema for the correct_batch_record tool
export const correctBatchSchema = z.object({
  batchId: z.string().min(1, "batchId is required"),
  originalLotId: z.string().min(1, "originalLotId is required"),
  correctedLotId: z.string().min(1, "correctedLotId is required"),
  reason: z.string().min(1, "reason is required"),
  correctedBy: z.string().min(1, "correctedBy is required"),
});

export type CorrectBatchInput = z.infer<typeof correctBatchSchema>;
export type CorrectBatchResult = {
  batchId: string;
  originalLotId: string;
  correctedLotId: string;
  affectedOrderIds: string[];
};

export type CorrectBatchError = {
  code: "BATCH_NOT_FOUND" | "ORIGINAL_LOT_NOT_LINKED" | "ORIGINAL_LOT_ALREADY_CORRECTED";
  message: string;
  batchId?: string;
};

// Custom error class for typed errors
export class CorrectBatchToolError extends Error {
  constructor(
    public readonly error: CorrectBatchError
  ) {
    super(error.message);
    this.name = "CorrectBatchToolError";
  }
}

// Check if a batch exists
async function batchExists(batchId: string): Promise<boolean> {
  try {
    const result = await documentClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `BATCH#${batchId}`,
          SK: "METADATA",
        },
      })
    );
    return !!result.Item;
  } catch {
    return false;
  }
}

// Check if a lot-batch link exists
async function lotLinkExists(lotId: string, batchId: string): Promise<boolean> {
  try {
    const result = await documentClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `LOT#${lotId}`,
          SK: `BATCH#${batchId}`,
        },
      })
    );
    return !!result.Item;
  } catch {
    return false;
  }
}

// Fetch the original lot-batch link to get quantityUsed and check superseded status
async function getOriginalLotLink(lotId: string, batchId: string): Promise<{
  quantityUsed: number;
  supersededBy?: string;
} | null> {
  try {
    const result = await documentClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `LOT#${lotId}`,
          SK: `BATCH#${batchId}`,
        },
      })
    );
    if (!result.Item) {
      return null;
    }
    return {
      quantityUsed: result.Item.quantityUsed as number,
      supersededBy: (result.Item as any).supersededBy as string | undefined,
    };
  } catch {
    return null;
  }
}

// Check if a lot exists
async function lotExists(lotId: string): Promise<boolean> {
  try {
    const result = await documentClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `LOT#${lotId}`,
          SK: "METADATA",
        },
      })
    );
    return !!result.Item;
  } catch {
    return false;
  }
}

// Query for affected orders (batch-order links)
async function getAffectedOrderIds(batchId: string): Promise<string[]> {
  const orderIds: string[] = [];

  // Use Query to find all batch-order links
  try {
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
  } catch {
    // Ignore query errors - no orders is fine
  }

  return orderIds;
}

export const correctBatchTool = {
  schema: correctBatchSchema,

  handler: async (input: CorrectBatchInput) => {
    // 1. Verify the batch exists
    const batchFound = await batchExists(input.batchId);
    if (!batchFound) {
      throw new CorrectBatchToolError({
        code: "BATCH_NOT_FOUND",
        message: `Batch with ID '${input.batchId}' not found. Cannot correct a non-existent batch.`,
        batchId: input.batchId,
      });
    }

    // 2. Verify the original lot is linked to this batch and fetch its data
    const originalLink = await getOriginalLotLink(input.originalLotId, input.batchId);
    if (!originalLink) {
      throw new CorrectBatchToolError({
        code: "ORIGINAL_LOT_NOT_LINKED",
        message: `Lot '${input.originalLotId}' is not linked to batch '${input.batchId}'. Cannot correct a lot that was never recorded on this batch.`,
        batchId: input.batchId,
      });
    }

    // Check if the original lot was already corrected
    if (originalLink.supersededBy) {
      throw new CorrectBatchToolError({
        code: "ORIGINAL_LOT_ALREADY_CORRECTED",
        message: `Lot '${input.originalLotId}' was already corrected to '${originalLink.supersededBy}'. Please refer to that correction instead of correcting this lot again.`,
        batchId: input.batchId,
      });
    }

    // 3. Find all affected orders
    const affectedOrderIds = await getAffectedOrderIds(input.batchId);

    // 4. Create transact items
    const transactItems: TransactWriteCommandInput["TransactItems"] = [];
    const correctedAt = new Date().toISOString();

    // Store the quantityUsed from the original link for the new corrected lot link
    const quantityUsed = originalLink.quantityUsed;

    // 4a. Mark the original link as superseded via Update
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: {
          PK: `LOT#${input.originalLotId}`,
          SK: `BATCH#${input.batchId}`,
        },
        UpdateExpression: "SET supersededBy = :supersededBy, supersededAt = :supersededAt",
        ExpressionAttributeValues: {
          ":supersededBy": input.correctedLotId,
          ":supersededAt": correctedAt,
        },
      },
    });

    // 4b. Put the new corrected lot link (with same quantityUsed as original)
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `LOT#${input.correctedLotId}`,
          SK: `BATCH#${input.batchId}`,
          lotId: input.correctedLotId,
          quantityUsed: quantityUsed,
          batchId: input.batchId,
          entityType: "LOT_BATCH_LINK",
          correctedFrom: input.originalLotId,
          // GSI1 for querying which batches used this lot
          GSI1PK: `LOT#${input.correctedLotId}`,
          GSI1SK: `BATCH#${input.batchId}`,
        },
      },
    });

    // 4c. Create placeholder lot for correctedLotId if it doesn't exist
    if (!await lotExists(input.correctedLotId)) {
      transactItems.push({
        Put: {
          TableName: TABLE_NAME,
          Item: {
            PK: `LOT#${input.correctedLotId}`,
            SK: "METADATA",
            lotId: input.correctedLotId,
            ingredientName: "unknown",
            supplier: "unknown",
            receivedDate: "",
            quantity: 0,
            entityType: "LOT",
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    }

    // 4d. Put the correction record
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `BATCH#${input.batchId}`,
          SK: `CORRECTION#${correctedAt}`,
          originalLotId: input.originalLotId,
          correctedLotId: input.correctedLotId,
          reason: input.reason,
          correctedBy: input.correctedBy,
          affectedOrderIds: affectedOrderIds,
          correctedAt: correctedAt,
        },
      },
    });

    // Execute the transaction - all or nothing
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: transactItems,
      })
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            batchId: input.batchId,
            originalLotId: input.originalLotId,
            correctedLotId: input.correctedLotId,
            affectedOrderIds,
          }, null, 2),
        },
      ],
    };
  },
};
