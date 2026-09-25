import { z } from "zod";
import { createHash } from "node:crypto";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  orderActionSchema,
  getOrderMetadata,
  assertNoDuplicateOrders,
  PreviewResponseToolError,
  type OrderAction,
  type ResponseAction,
} from "./preview-response.js";

// DynamoDB caps a transaction at 100 items; one slot is taken by the
// idempotency record, leaving 99 for order updates.
const MAX_ORDER_ACTIONS = 99;

// Idempotency records are a retry guard, not a permanent audit trail - the
// correction record on the batch is what survives. 24h covers any realistic
// retry window.
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// Input schema for the commit_approved_response tool
export const commitResponseSchema = z.object({
  previewId: z.string().min(1, "previewId is required"),
  orderActions: z
    .array(orderActionSchema)
    .min(1, "at least one order action is required")
    .max(MAX_ORDER_ACTIONS, `at most ${MAX_ORDER_ACTIONS} order actions may be committed at once`),
  idempotencyKey: z.string().min(1, "idempotencyKey is required"),
});

export type CommitResponseInput = z.infer<typeof commitResponseSchema>;

export type CommittedAction = {
  orderId: string;
  action: ResponseAction;
  newStatus: string;
};

export type CommitResponseResult = {
  previewId: string;
  committed: CommittedAction[];
  committedAt: string;
};

export type CommitResponseError = {
  code: "ORDER_NOT_FOUND" | "DUPLICATE_ORDER_ACTION" | "IDEMPOTENCY_KEY_REUSED";
  message: string;
  orderId?: string;
};

// Custom error class for typed errors
export class CommitResponseToolError extends Error {
  constructor(
    public readonly error: CommitResponseError
  ) {
    super(error.message);
    this.name = "CommitResponseToolError";
  }
}

// The status each action writes onto the order's METADATA item
const ACTION_STATUS: Record<ResponseAction, string> = {
  hold: "on_hold",
  notify: "notified",
  flag: "flagged_incomplete",
};

// Fingerprint of what was approved. Stored on the idempotency record so a
// replay can prove it is the *same* request coming back, rather than a
// different request reusing the key. Order-insensitive: a client retry that
// reorders the array is still the same approved set of actions.
function computeRequestHash(previewId: string, orderActions: OrderAction[]): string {
  const normalized = [...orderActions]
    .map((a) => ({ orderId: a.orderId, action: a.action }))
    .sort((a, b) => a.orderId.localeCompare(b.orderId));

  return createHash("sha256")
    .update(JSON.stringify({ previewId, orderActions: normalized }))
    .digest("hex");
}

// Look up a prior commit by idempotency key.
// Returns null only when the record genuinely doesn't exist; DynamoDB errors propagate.
async function getIdempotencyRecord(idempotencyKey: string): Promise<{
  requestHash?: string;
  result?: unknown;
} | null> {
  const lookup = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `IDEMPOTENCY#${idempotencyKey}`,
        SK: "METADATA",
      },
    })
  );
  if (!lookup.Item) {
    return null;
  }
  return {
    requestHash: lookup.Item.requestHash as string | undefined,
    result: lookup.Item.result,
  };
}

// Return a previous commit's stored result verbatim - nothing is re-executed.
// Refuses if the key is being reused for a different request, since handing back
// another request's result would silently misreport what was committed.
function replayStoredResult(
  record: { requestHash?: string; result?: unknown },
  expectedHash: string,
  idempotencyKey: string
) {
  if (record.requestHash !== expectedHash) {
    throw new CommitResponseToolError({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: `Idempotency key '${idempotencyKey}' was already used for a different previewId or set of orderActions. Use a fresh idempotencyKey for a different request.`,
    });
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(record.result, null, 2),
      },
    ],
  };
}

export const commitResponseTool = {
  schema: commitResponseSchema,

  handler: async (input: CommitResponseInput) => {
    const requestHash = computeRequestHash(input.previewId, input.orderActions);

    // 1. Idempotency check FIRST, before any reads or writes. A retried request
    // returns the original result and never sends a second round of notices.
    const existingRecord = await getIdempotencyRecord(input.idempotencyKey);
    if (existingRecord) {
      return replayStoredResult(existingRecord, requestHash, input.idempotencyKey);
    }

    // 2. Reject a list DynamoDB could not write atomically anyway
    try {
      assertNoDuplicateOrders(input.orderActions);
    } catch (error) {
      // Re-type the shared guard's error so callers of this tool only ever see
      // CommitResponseToolError
      if (error instanceof PreviewResponseToolError) {
        throw new CommitResponseToolError({
          code: "DUPLICATE_ORDER_ACTION",
          message: error.error.message,
          orderId: error.error.orderId,
        });
      }
      throw error;
    }

    // 3. Verify every referenced order exists, so a bad orderId is reported by
    // name rather than as an opaque transaction cancellation.
    // DynamoDB errors propagate as real exceptions.
    for (const orderAction of input.orderActions) {
      const orderMetadata = await getOrderMetadata(orderAction.orderId);
      if (!orderMetadata) {
        throw new CommitResponseToolError({
          code: "ORDER_NOT_FOUND",
          message: `Order with ID '${orderAction.orderId}' was not found. Cannot commit a response action for an order that does not exist.`,
          orderId: orderAction.orderId,
        });
      }
    }

    // 4. Build the transaction: every order update plus the idempotency record
    // land together, or nothing does.
    const committedAt = new Date().toISOString();
    const transactItems: TransactWriteCommandInput["TransactItems"] = [];
    const committed: CommittedAction[] = [];

    // Order updates occupy indices 0..n-1 of the transaction, which lets a
    // cancellation reason be mapped back to the order that caused it.
    for (const orderAction of input.orderActions) {
      const newStatus = ACTION_STATUS[orderAction.action];
      const isNotify = orderAction.action === "notify";

      transactItems.push({
        Update: {
          TableName: TABLE_NAME,
          Key: {
            PK: `ORDER#${orderAction.orderId}`,
            SK: "METADATA",
          },
          // "notify" records the state change as if a notice went out; no
          // email/SMS is actually sent in this demo.
          UpdateExpression: isNotify
            ? "SET #status = :status, notifiedAt = :committedAt"
            : "SET #status = :status",
          // "status" is a DynamoDB reserved word
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: isNotify
            ? { ":status": newStatus, ":committedAt": committedAt }
            : { ":status": newStatus },
          // Guards the gap between the existence check above and this write
          ConditionExpression: "attribute_exists(PK)",
        },
      });

      committed.push({
        orderId: orderAction.orderId,
        action: orderAction.action,
        newStatus,
      });
    }

    const result: CommitResponseResult = {
      previewId: input.previewId,
      committed,
      committedAt,
    };

    // The idempotency record is the final transaction item (index n)
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `IDEMPOTENCY#${input.idempotencyKey}`,
          SK: "METADATA",
          idempotencyKey: input.idempotencyKey,
          requestHash,
          previewId: input.previewId,
          orderActions: input.orderActions,
          result,
          executedAt: committedAt,
          ttl: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
          entityType: "IDEMPOTENCY",
        },
        // Loses the race to a concurrent request carrying the same key
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

        // An order's attribute_exists guard failed: it was deleted between the
        // check above and the write
        for (let i = 0; i < input.orderActions.length; i += 1) {
          if (reasons[i]?.Code === "ConditionalCheckFailed") {
            const orderId = input.orderActions[i].orderId;
            throw new CommitResponseToolError({
              code: "ORDER_NOT_FOUND",
              message: `Order with ID '${orderId}' no longer exists. No response actions were committed.`,
              orderId,
            });
          }
        }

        // The idempotency guard failed: a concurrent request with the same key
        // committed first. Return its result rather than retrying the writes.
        if (reasons[input.orderActions.length]?.Code === "ConditionalCheckFailed") {
          const concurrentRecord = await getIdempotencyRecord(input.idempotencyKey);
          if (concurrentRecord) {
            return replayStoredResult(concurrentRecord, requestHash, input.idempotencyKey);
          }
        }
      }
      // Re-throw other errors
      throw error;
    }

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
