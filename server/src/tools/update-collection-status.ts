import { z } from "zod";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

// Input schema for the update_collection_status tool
export const updateCollectionStatusSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  // Deliberately NOT accepting "incomplete": "incomplete" means the field is
  // MISSING from the order (lost data), which is a state to be detected, not
  // one a person can set. Only physical reality - picked up or not - may be
  // recorded here.
  collectionStatus: z.enum(["collected", "uncollected"], {
    errorMap: () => ({
      message: "collectionStatus must be one of: collected, uncollected",
    }),
  }),
  // Who asked for the change. If omitted, the literal string "unspecified" is
  // stored - a name is never invented on the caller's behalf.
  updatedBy: z.string().min(1).optional(),
});

export type UpdateCollectionStatusInput = z.infer<typeof updateCollectionStatusSchema>;

// previousStatus is the literal string "missing" when the order carried no
// collectionStatus at all (the genuine incomplete-data case)
export type UpdateCollectionStatusResult = {
  orderId: string;
  collectionStatus: "collected" | "uncollected";
  previousStatus: string;
  changed: boolean;
};

export type UpdateCollectionStatusError = {
  code: "ORDER_NOT_FOUND" | "COLLECTION_STATUS_CHANGED_CONCURRENTLY";
  message: string;
  orderId?: string;
};

// Custom error class for typed errors
export class UpdateCollectionStatusToolError extends Error {
  constructor(
    public readonly error: UpdateCollectionStatusError
  ) {
    super(error.message);
    this.name = "UpdateCollectionStatusToolError";
  }
}

export const updateCollectionStatusTool = {
  schema: updateCollectionStatusSchema,

  handler: async (input: UpdateCollectionStatusInput) => {
    // 1. Read the order's current state first, so the write can be guarded
    // against a concurrent change between this read and the transaction below
    // (same check-then-write race discipline as record-batch.ts).
    // DynamoDB errors (network, auth, table missing) propagate as real
    // exceptions instead of being masked as "not found".
    const current = await documentClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: `ORDER#${input.orderId}`,
          SK: "METADATA",
        },
      })
    );

    if (!current.Item) {
      throw new UpdateCollectionStatusToolError({
        code: "ORDER_NOT_FOUND",
        message: `Order with ID '${input.orderId}' was not found. Cannot update the collection status of an order that does not exist.`,
        orderId: input.orderId,
      });
    }

    // The field may be genuinely absent - that is the "incomplete" case, and
    // updating it from missing to a real value is a valid, expected path.
    const currentStatus =
      typeof current.Item.collectionStatus === "string"
        ? current.Item.collectionStatus
        : undefined;
    const previousStatus = currentStatus ?? "missing";

    // 2. Already in the requested state: write nothing, throw nothing, and say
    // so honestly so the caller can tell a no-op from a change.
    if (currentStatus === input.collectionStatus) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                orderId: input.orderId,
                collectionStatus: input.collectionStatus,
                previousStatus,
                changed: false,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // 3. One transaction: the guarded status update and its audit record land
    // together, or nothing does.
    const changedAt = new Date().toISOString();
    const updatedBy = input.updatedBy ?? "unspecified";

    const transactItems: TransactWriteCommandInput["TransactItems"] = [];

    // 3a. The status update, with a ConditionExpression closing the race
    // window opened by the read in step 1: the order must still exist AND its
    // collectionStatus must still be exactly what was read (or still absent,
    // when it was read as missing).
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: {
          PK: `ORDER#${input.orderId}`,
          SK: "METADATA",
        },
        UpdateExpression: "SET #cs = :newStatus",
        ExpressionAttributeNames: { "#cs": "collectionStatus" },
        ConditionExpression:
          currentStatus === undefined
            ? "attribute_exists(PK) AND attribute_not_exists(#cs)"
            : "attribute_exists(PK) AND #cs = :previousStatus",
        ExpressionAttributeValues:
          currentStatus === undefined
            ? { ":newStatus": input.collectionStatus }
            : {
                ":newStatus": input.collectionStatus,
                ":previousStatus": currentStatus,
              },
      },
    });

    // 3b. The audit record. Immutable history: items are only ever Put with a
    // fresh timestamp key and a not-exists guard - never overwritten, never
    // deleted. (Two changes within the same millisecond would lose the race
    // here and surface as a raw cancellation rather than a silent overwrite.)
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `ORDER#${input.orderId}`,
          SK: `COLLECTION_CHANGE#${changedAt}`,
          orderId: input.orderId,
          previousStatus: previousStatus,
          newStatus: input.collectionStatus,
          updatedBy,
          changedAt,
          entityType: "COLLECTION_CHANGE",
        },
        ConditionExpression: "attribute_not_exists(PK)",
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
      if (error instanceof TransactionCanceledException) {
        const reasons = error.CancellationReasons ?? [];

        // Index 0 is the guarded Update (3a): its condition failing means the
        // collection status (or the order itself) changed between the read
        // and the write. Never silently retry or overwrite - tell the caller
        // to re-read the order and try again.
        if (reasons[0]?.Code === "ConditionalCheckFailed") {
          throw new UpdateCollectionStatusToolError({
            code: "COLLECTION_STATUS_CHANGED_CONCURRENTLY",
            message: `Order '${input.orderId}' collection status changed concurrently between read and write. Nothing was written - re-read the order to get its current status, then retry.`,
            orderId: input.orderId,
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
              collectionStatus: input.collectionStatus,
              previousStatus,
              changed: true,
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
