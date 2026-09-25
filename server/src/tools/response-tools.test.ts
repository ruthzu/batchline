// Manual test script for preview_response and commit_approved_response tools
// Run with: npx tsx server/src/tools/response-tools.test.ts
// Assumes DYNAMODB_LOCAL=true is set in environment

import { recordBatchTool } from "./record-batch.js";
import { previewResponseTool, PreviewResponseToolError } from "./preview-response.js";
import { commitResponseTool, CommitResponseToolError } from "./commit-response.js";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

// Read an order's METADATA item straight from DynamoDB, to verify what the
// tools actually wrote rather than trusting their return values
async function readOrder(orderId: string): Promise<Record<string, unknown> | undefined> {
  const result = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORDER#${orderId}`, SK: "METADATA" },
    })
  );
  return result.Item;
}

async function seedOrder(
  orderId: string,
  customerName: string,
  collectionStatus: string
): Promise<void> {
  await documentClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ORDER#${orderId}`,
        SK: "METADATA",
        orderId,
        customerName,
        customerContact: `${orderId.toLowerCase()}@example.test`,
        status: "fulfilled",
        collectionStatus,
        entityType: "ORDER",
      },
    })
  );
}

async function runTests() {
  console.log("=== preview_response / commit_approved_response Tool Tests ===\n");

  // Unique IDs per run to avoid collisions with DynamoDB Local persistence
  const runId = Date.now();
  const testBatchId = `TEST-RESP-${runId}`;
  const testLotId = `LOT-RESP-${runId}`;
  const orderHold = `ORDER-RESP-HOLD-${runId}`;
  const orderNotify = `ORDER-RESP-NOTIFY-${runId}`;
  const orderFlag = `ORDER-RESP-FLAG-${runId}`;
  const orderMissing = `ORDER-RESP-MISSING-${runId}`;
  const idempotencyKey = `IDEM-RESP-${runId}`;

  // ---------------------------------------------------------------------------
  console.log("Setup: Recording a batch and seeding three orders");
  console.log("--------------------------------------------------");
  console.log("Batch ID:", testBatchId);
  console.log("Orders:", orderHold, "|", orderNotify, "|", orderFlag);

  try {
    await recordBatchTool.handler({
      batchId: testBatchId,
      product: "Widget-Response",
      producedDate: new Date().toISOString(),
      batchSize: 120,
      ingredientLots: [{ lotId: testLotId, quantityUsed: 60 }],
    });
    console.log("✓ Batch recorded successfully");

    // Orders are assumed to originate elsewhere in the real system - there is no
    // order-creation tool yet, so seed METADATA items directly
    await seedOrder(orderHold, "Acme Foods", "uncollected");
    await seedOrder(orderNotify, "Globex Cafe", "collected");
    await seedOrder(orderFlag, "Initech Catering", "incomplete");

    // Link the orders to the batch, matching how a real recall trace would find them
    for (const orderId of [orderHold, orderNotify, orderFlag]) {
      await documentClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: `BATCH#${testBatchId}`,
            SK: `ORDER#${orderId}`,
            batchId: testBatchId,
            orderId,
            quantityAllocated: 40,
            entityType: "BATCH_ORDER_LINK",
          },
        })
      );
    }
    console.log("✓ Three orders seeded and linked to the batch");
  } catch (error) {
    console.log("✗ Setup failed:");
    console.log("Error:", error);
    return;
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 1: preview_response with a mix of hold/notify/flag");
  console.log("--------------------------------------------------------");

  const plannedActions = [
    { orderId: orderHold, action: "hold" as const },
    { orderId: orderNotify, action: "notify" as const },
    { orderId: orderFlag, action: "flag" as const },
  ];

  let previewId = "";

  try {
    const result = await previewResponseTool.handler({ orderActions: plannedActions });
    const parsed = JSON.parse(result.content[0].text);
    previewId = parsed.previewId;

    const byId = new Map<string, any>(
      parsed.actions.map((a: { orderId: string }) => [a.orderId, a])
    );

    const hasPreviewId = typeof parsed.previewId === "string" && parsed.previewId.length > 0;
    const hasTimestamp = !isNaN(Date.parse(parsed.generatedAt));
    const notifyHasMessage =
      typeof byId.get(orderNotify)?.draftMessage === "string" &&
      byId.get(orderNotify).draftMessage.length > 0;
    // draftMessage must be absent entirely, not just empty
    const holdHasNoMessage = !("draftMessage" in (byId.get(orderHold) ?? {}));
    const flagHasNoMessage = !("draftMessage" in (byId.get(orderFlag) ?? {}));
    const customerNamesOk =
      byId.get(orderHold)?.customerName === "Acme Foods" &&
      byId.get(orderNotify)?.customerName === "Globex Cafe" &&
      byId.get(orderFlag)?.customerName === "Initech Catering";

    if (hasPreviewId && hasTimestamp && notifyHasMessage && holdHasNoMessage && flagHasNoMessage && customerNamesOk) {
      console.log("✓ Draft shape correct; draftMessage present only for 'notify'");
    } else {
      console.log("✗ Unexpected draft shape:");
      console.log("  hasPreviewId:", hasPreviewId, "| hasTimestamp:", hasTimestamp);
      console.log("  notifyHasMessage:", notifyHasMessage, "| holdHasNoMessage:", holdHasNoMessage, "| flagHasNoMessage:", flagHasNoMessage);
      console.log("  customerNamesOk:", customerNamesOk);
    }
    console.log("Result:", JSON.stringify(parsed, null, 2));
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
    return;
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 1b: preview_response performs no writes");
  console.log("---------------------------------------------");

  try {
    const stillFulfilled = await Promise.all(
      [orderHold, orderNotify, orderFlag].map(async (orderId) => {
        const item = await readOrder(orderId);
        return item?.status === "fulfilled" && item?.notifiedAt === undefined;
      })
    );

    if (stillFulfilled.every(Boolean)) {
      console.log("✓ All three orders still have status 'fulfilled' - preview wrote nothing");
    } else {
      console.log("✗ Preview mutated order state:", stillFulfilled);
    }
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 2: commit_approved_response with a fresh idempotencyKey");
  console.log("-------------------------------------------------------------");
  console.log("Preview ID:", previewId);
  console.log("Idempotency Key:", idempotencyKey);

  let firstCommitJson = "";

  try {
    const result = await commitResponseTool.handler({
      previewId,
      orderActions: plannedActions,
      idempotencyKey,
    });
    firstCommitJson = result.content[0].text;
    const parsed = JSON.parse(firstCommitJson);

    // Verify against DynamoDB directly, not against the tool's own return value
    const holdItem = await readOrder(orderHold);
    const notifyItem = await readOrder(orderNotify);
    const flagItem = await readOrder(orderFlag);

    const statusesOk =
      holdItem?.status === "on_hold" &&
      notifyItem?.status === "notified" &&
      flagItem?.status === "flagged_incomplete";
    const notifiedAtOk = typeof notifyItem?.notifiedAt === "string";
    // notifiedAt belongs only to the notify action
    const noStrayNotifiedAt =
      holdItem?.notifiedAt === undefined && flagItem?.notifiedAt === undefined;
    const previewIdEchoed = parsed.previewId === previewId;

    if (statusesOk && notifiedAtOk && noStrayNotifiedAt && previewIdEchoed) {
      console.log("✓ All three order statuses changed in DynamoDB as expected");
    } else {
      console.log("✗ Unexpected post-commit state:");
      console.log("  statusesOk:", statusesOk, "| notifiedAtOk:", notifiedAtOk);
      console.log("  noStrayNotifiedAt:", noStrayNotifiedAt, "| previewIdEchoed:", previewIdEchoed);
    }
    console.log("Result:", JSON.stringify(parsed, null, 2));
    console.log("DynamoDB order state after commit:");
    console.log("  ", orderHold, "->", JSON.stringify({ status: holdItem?.status, notifiedAt: holdItem?.notifiedAt }));
    console.log("  ", orderNotify, "->", JSON.stringify({ status: notifyItem?.status, notifiedAt: notifyItem?.notifiedAt }));
    console.log("  ", orderFlag, "->", JSON.stringify({ status: flagItem?.status, notifiedAt: flagItem?.notifiedAt }));
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
    return;
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 2b: the idempotency record was written with a TTL");
  console.log("-------------------------------------------------------");

  try {
    const record = await documentClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `IDEMPOTENCY#${idempotencyKey}`, SK: "METADATA" },
      })
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = record.Item?.ttl as number | undefined;
    // ~24h out, allowing a minute of slack either side
    const ttlOk =
      typeof ttl === "number" &&
      ttl > nowSeconds + 24 * 60 * 60 - 60 &&
      ttl <= nowSeconds + 24 * 60 * 60;
    const shapeOk =
      record.Item?.idempotencyKey === idempotencyKey &&
      typeof record.Item?.requestHash === "string" &&
      Array.isArray(record.Item?.orderActions) &&
      typeof record.Item?.executedAt === "string" &&
      record.Item?.result !== undefined;

    if (ttlOk && shapeOk) {
      console.log("✓ Idempotency record matches the IdempotencyRecord shape, ttl ~24h out");
    } else {
      console.log("✗ Unexpected idempotency record: ttlOk:", ttlOk, "| shapeOk:", shapeOk);
    }
    console.log("Record:", JSON.stringify(record.Item, null, 2));
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 3: replay with the SAME idempotencyKey does not re-execute");
  console.log("----------------------------------------------------------------");

  try {
    // Plant a sentinel status. If the replay re-ran the transaction, the sentinel
    // would be overwritten with "on_hold" again - so if it survives, the
    // transaction provably did not run a second time.
    const sentinel = `SENTINEL_NOT_REEXECUTED_${runId}`;
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `ORDER#${orderHold}`,
          SK: "METADATA",
          orderId: orderHold,
          customerName: "Acme Foods",
          customerContact: `${orderHold.toLowerCase()}@example.test`,
          status: sentinel,
          collectionStatus: "uncollected",
          entityType: "ORDER",
        },
      })
    );
    console.log("Planted sentinel status on", orderHold, "->", sentinel);

    const result = await commitResponseTool.handler({
      previewId,
      orderActions: plannedActions,
      idempotencyKey,
    });
    const replayJson = result.content[0].text;

    const holdItemAfter = await readOrder(orderHold);
    const sentinelSurvived = holdItemAfter?.status === sentinel;

    // Compare semantically, not by serialized string. The stored result
    // round-trips through a DynamoDB map, which preserves every value but NOT
    // key order inside each item - so JSON.stringify comparisons fail
    // spuriously even when the content is identical. Sort array elements by
    // orderId, then compare each entry field by field.
    const first = JSON.parse(firstCommitJson);
    const replayed = JSON.parse(replayJson);

    const sortById = (a: any, b: any) => a.orderId.localeCompare(b.orderId);
    const firstCommitted = [...first.committed].sort(sortById);
    const replayedCommitted = [...replayed.committed].sort(sortById);

    const committedEqual =
      firstCommitted.length === replayedCommitted.length &&
      firstCommitted.every((entry: any, i: number) => {
        const other = replayedCommitted[i];
        return (
          entry.orderId === other.orderId &&
          entry.action === other.action &&
          entry.newStatus === other.newStatus
        );
      });

    const sameResult =
      replayed.previewId === first.previewId &&
      replayed.committedAt === first.committedAt &&
      committedEqual;

    if (sentinelSurvived && sameResult) {
      console.log("✓ Replay returned the identical stored result and re-executed nothing");
      console.log("  Sentinel survived:", holdItemAfter?.status);
      console.log("  committedAt is still the original:", replayed.committedAt);
    } else {
      console.log("✗ Replay behaved unexpectedly:");
      console.log("  sentinelSurvived:", sentinelSurvived, "(status is now", holdItemAfter?.status, ")");
      console.log("  sameResult:", sameResult);
      if (!committedEqual) {
        console.log("  first   committed:", JSON.stringify(firstCommitted));
        console.log("  replayed committed:", JSON.stringify(replayedCommitted));
      }
    }
    console.log("Replayed result:", replayJson);
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 4: preview_response with a non-existent orderId");
  console.log("-----------------------------------------------------");
  console.log("Missing Order ID:", orderMissing);

  try {
    const result = await previewResponseTool.handler({
      orderActions: [
        { orderId: orderNotify, action: "notify" },
        { orderId: orderMissing, action: "hold" },
      ],
    });
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof PreviewResponseToolError && error.error.code === "ORDER_NOT_FOUND") {
      console.log("✓ Correctly rejected the missing order:");
      console.log("Error code:", error.error.code);
      console.log("Error orderId:", error.error.orderId);
      console.log("Error message:", error.error.message);
    } else {
      console.log("✗ Failed with unexpected error:");
      console.log("Error:", error);
    }
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 5: commit_approved_response with a non-existent orderId");
  console.log("-------------------------------------------------------------");

  try {
    const result = await commitResponseTool.handler({
      previewId,
      orderActions: [
        { orderId: orderNotify, action: "notify" },
        { orderId: orderMissing, action: "hold" },
      ],
      idempotencyKey: `IDEM-RESP-MISSING-${runId}`,
    });
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof CommitResponseToolError && error.error.code === "ORDER_NOT_FOUND") {
      console.log("✓ Correctly rejected the missing order:");
      console.log("Error code:", error.error.code);
      console.log("Error orderId:", error.error.orderId);
      console.log("Error message:", error.error.message);
    } else {
      console.log("✗ Failed with unexpected error:");
      console.log("Error:", error);
    }
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 5b: the failed commit wrote nothing at all");
  console.log("------------------------------------------------");

  try {
    const notifyItem = await readOrder(orderNotify);
    const orphanRecord = await documentClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `IDEMPOTENCY#IDEM-RESP-MISSING-${runId}`, SK: "METADATA" },
      })
    );

    // orderNotify was the valid half of that request; it must be untouched
    const untouched = notifyItem?.status === "notified";
    const noIdempotencyRecord = orphanRecord.Item === undefined;

    if (untouched && noIdempotencyRecord) {
      console.log("✓ Valid order untouched and no idempotency record written");
    } else {
      console.log("✗ Partial write detected: untouched:", untouched, "| noIdempotencyRecord:", noIdempotencyRecord);
      console.log("  ", orderNotify, "status:", notifyItem?.status);
    }
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 6: reusing an idempotencyKey for DIFFERENT actions is refused");
  console.log("-------------------------------------------------------------------");

  try {
    const result = await commitResponseTool.handler({
      previewId,
      // Same key as Test 2, but orderFlag now gets "hold" instead of "flag"
      orderActions: [
        { orderId: orderHold, action: "hold" },
        { orderId: orderNotify, action: "notify" },
        { orderId: orderFlag, action: "hold" },
      ],
      idempotencyKey,
    });
    console.log("✗ Unexpected success - should have refused the mismatched replay");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof CommitResponseToolError && error.error.code === "IDEMPOTENCY_KEY_REUSED") {
      console.log("✓ Correctly refused to return another request's result:");
      console.log("Error code:", error.error.code);
      console.log("Error message:", error.error.message);
    } else {
      console.log("✗ Failed with unexpected error:");
      console.log("Error:", error);
    }
  }

  console.log();
  console.log("=== Tests Complete ===");
}

runTests().catch((error) => {
  console.error("Test script failed:", error);
  process.exit(1);
});
