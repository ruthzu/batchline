import { z } from "zod";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { CollectionStatus } from "@batchline/shared";

// Input schema for the register_order tool
export const registerOrderSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  customerName: z.string().min(1, "customerName is required"),
  customerContact: z.string().min(1, "customerContact is required"),
  // Required on purpose: an order must never be creatable without stating its
  // collection status. A silent default to "incomplete" would turn a forgotten
  // field into wrong recall-trace numbers - the choice has to be explicit.
  collectionStatus: z.enum(["collected", "uncollected", "incomplete"], {
    errorMap: () => ({
      message: "collectionStatus must be one of: collected, uncollected, incomplete",
    }),
  }),
  // Required on purpose: an order with no batch link can never show up in a
  // recall trace, so it must be linked to a batch at creation time.
  batchId: z.string().min(1, "batchId is required"),
});

export type RegisterOrderInput = z.infer<typeof registerOrderSchema>;
export type RegisterOrderResult = {
  orderId: string;
  batchId: string;
  status: string;
};

export type RegisterOrderError = {
  code: "BATCH_NOT_FOUND" | "ORDER_ALREADY_EXISTS";
  message: string;
  batchId?: string;
  orderId?: string;
};

// Custom error class for typed errors
export class RegisterOrderToolError extends Error {
  constructor(
    public readonly error: RegisterOrderError
  ) {
    super(error.message);
    this.name = "RegisterOrderToolError";
  }
}

// Verify the batch the order is being linked to actually exists.
// Returns void only when the item genuinely exists; DynamoDB errors (network,
// auth, table missing) propagate as real exceptions instead of being masked
// as "not found".
async function assertBatchExists(batchId: string): Promise<void> {
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
    throw new RegisterOrderToolError({
      code: "BATCH_NOT_FOUND",
      message: `Batch with ID '${batchId}' not found. An order can only be registered against a batch that was already recorded.`,
      batchId,
    });
  }
}

export const registerOrderTool = {
  schema: registerOrderSchema,

  handler: async (input: RegisterOrderInput) => {
    // 1. The referenced batch must exist before anything is written
    await assertBatchExists(input.batchId);

    // 2. Single transaction: the order and its batch link land together, or
    // nothing does. The condition on the order METADATA put enforces orderId
    // uniqueness atomically (same pattern as record-batch.ts).
    const transactItems: TransactWriteCommandInput["TransactItems"] = [];

    // 2a. The order's METADATA item. `status` is the recall-workflow state and
    // starts at "fulfilled" - orders are not created already on hold/notified/
    // flagged; those states are only reached via commit_approved_response.
    // `collectionStatus` is the independent physical pickup state chosen
    // explicitly at creation time.
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `ORDER#${input.orderId}`,
          SK: "METADATA",
          orderId: input.orderId,
          customerName: input.customerName,
          customerContact: input.customerContact,
          collectionStatus: input.collectionStatus,
          status: "fulfilled",
          entityType: "ORDER",
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });

    // 2b. The batch-order link. Shape matches what trace-lot.ts and
    // correct-batch.ts's getAffectedOrderIds expect to find
    // (BATCH#<batchId> / ORDER#<orderId>, SK carrying the orderId).
    // quantityAllocated is deliberately omitted: this tool has no quantity
    // input, and fabricating one would put made-up data in the ledger.
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `BATCH#${input.batchId}`,
          SK: `ORDER#${input.orderId}`,
          batchId: input.batchId,
          orderId: input.orderId,
          collectionStatus: input.collectionStatus as CollectionStatus,
          entityType: "BATCH_ORDER_LINK",
        },
      },
    });

    // Execute the transaction - all or nothing
    try {
      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: transactItems,
        })
      );
    } catch (error) {
      // Check if this is a TransactionCanceledException due to the orderId
      // uniqueness condition. We know it's a duplicate order if:
      // 1. There's at least one ConditionalCheckFailed reason
      // 2. The first reason (order metadata put) failed - indicating the
      //    orderId is already taken
      if (error instanceof TransactionCanceledException) {
        const orderUniquenessFailed =
          error.CancellationReasons?.length === 2 &&
          error.CancellationReasons[0]?.Code === "ConditionalCheckFailed";

        if (orderUniquenessFailed) {
          throw new RegisterOrderToolError({
            code: "ORDER_ALREADY_EXISTS",
            message: `Order with ID '${input.orderId}' already exists. Each orderId can only be registered once.`,
            orderId: input.orderId,
            batchId: input.batchId,
          });
        }
      }
      // Re-throw other errors - real DynamoDB problems are never masked
      throw error;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              orderId: input.orderId,
              batchId: input.batchId,
              status: "fulfilled",
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
