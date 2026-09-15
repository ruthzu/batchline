import { z } from "zod";
import { documentClient, TABLE_NAME } from "../db/client.js";
import {
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

// Input schema for the record_batch tool
export const recordBatchSchema = z.object({
  batchId: z.string().min(1, "batchId is required"),
  product: z.string().min(1, "product is required"),
  producedDate: z.string().min(1, "producedDate is required").refine(
    (date) => !isNaN(Date.parse(date)),
    "producedDate must be a valid ISO 8601 date string"
  ),
  batchSize: z
    .number()
    .positive("batchSize must be a positive number"),
  ingredientLots: z
    .array(
      z.object({
        lotId: z.string().min(1, "lotId is required"),
        quantityUsed: z.number(),
      })
    )
    .min(1, "at least one ingredient lot is required"),
});

export type RecordBatchInput = z.infer<typeof recordBatchSchema>;
export type RecordBatchResult = {
  batchId: string;
  lotsLinked: string[];
};

export type RecordBatchError = {
  code: "BATCH_ALREADY_EXISTS" | "INVALID_INGREDIENT_LOT";
  message: string;
  batchId?: string;
};

// Custom error class for typed errors
export class RecordBatchToolError extends Error {
  constructor(
    public readonly error: RecordBatchError
  ) {
    super(error.message);
    this.name = "RecordBatchToolError";
  }
}

// Check if a lot exists (read-only check, kept for placeholder lot logic)
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

// Validate ingredient lots - check for malformed entries
function validateIngredientLots(ingredientLots: RecordBatchInput["ingredientLots"]): void {
  for (const lot of ingredientLots) {
    if (!lot.lotId || typeof lot.lotId !== "string" || lot.lotId.trim().length === 0) {
      throw new RecordBatchToolError({
        code: "INVALID_INGREDIENT_LOT",
        message: "Each ingredient lot must have a non-empty lotId string",
      });
    }
    if (typeof lot.quantityUsed !== "number" || !isFinite(lot.quantityUsed)) {
      throw new RecordBatchToolError({
        code: "INVALID_INGREDIENT_LOT",
        message: "Each ingredient lot must have a valid numeric quantityUsed",
      });
    }
  }
}

export const recordBatchTool = {
  schema: recordBatchSchema,

  handler: async (input: RecordBatchInput) => {
    // Validate input
    validateIngredientLots(input.ingredientLots);

    const lotsLinked: string[] = [];

    // Build transaction write items with proper typing
    const transactItems: TransactWriteCommandInput["TransactItems"] = [];

    // 1. Create the batch metadata item with condition to enforce uniqueness atomically
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `BATCH#${input.batchId}`,
          SK: "METADATA",
          batchId: input.batchId,
          product: input.product,
          producedDate: input.producedDate,
          batchSize: input.batchSize,
          entityType: "BATCH",
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });

    // 2. For each ingredient lot, create the link item
    for (const lot of input.ingredientLots) {
      transactItems.push({
        Put: {
          TableName: TABLE_NAME,
          Item: {
            PK: `LOT#${lot.lotId}`,
            SK: `BATCH#${input.batchId}`,
            lotId: lot.lotId,
            quantityUsed: lot.quantityUsed,
            batchId: input.batchId,
            entityType: "LOT_BATCH_LINK",
            // GSI1 for querying which batches used this lot
            GSI1PK: `LOT#${lot.lotId}`,
            GSI1SK: `BATCH#${input.batchId}`,
          },
        },
      });

      lotsLinked.push(lot.lotId);
    }

    // 3. Add placeholder lot creation for any missing lots (within the same transaction)
    for (const lot of input.ingredientLots) {
      if (!await lotExists(lot.lotId)) {
        transactItems.push({
          Put: {
            TableName: TABLE_NAME,
            Item: {
              PK: `LOT#${lot.lotId}`,
              SK: "METADATA",
              lotId: lot.lotId,
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
    }

    // Execute the transaction - all or nothing
    try {
      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: transactItems,
        })
      );
    } catch (error) {
      // Check if this is a TransactionCanceledException due to the batch uniqueness condition
      if (error instanceof TransactionCanceledException) {
        // Inspect the cancellation reasons to confirm it was the batch-uniqueness condition
        // Check if the transaction was cancelled due to the batch uniqueness condition
        // We know it's a duplicate batch if:
        // 1. There's at least one ConditionalCheckFailed reason
        // 2. The first reason (batch metadata put) failed - indicating the batch already exists
        const batchUniquenessFailed =
          error.CancellationReasons?.length === 3 &&
          error.CancellationReasons[0]?.Code === "ConditionalCheckFailed";

        if (batchUniquenessFailed) {
          throw new RecordBatchToolError({
            code: "BATCH_ALREADY_EXISTS",
            message: `Batch with ID '${input.batchId}' already exists. Use correct_batch_record for corrections.`,
            batchId: input.batchId,
          });
        }
      }
      // Re-throw other errors
      throw error;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            batchId: input.batchId,
            lotsLinked,
          }, null, 2),
        },
      ],
    };
  },
};
