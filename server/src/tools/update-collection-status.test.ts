// Manual test script for update_collection_status tool
// Run with: npx tsx server/src/tools/update-collection-status.test.ts
// Assumes DynamoDB Local is running on localhost:8000

import { recordBatchTool } from "./record-batch.js";
import { registerOrderTool } from "./register-order.js";
import { updateCollectionStatusTool, UpdateCollectionStatusToolError } from "./update-collection-status.js";
import { traceLotTool } from "./trace-lot.js";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { TraceLotResult } from "@batchline/shared";

// Read an item straight from DynamoDB, to verify what the tool actually wrote
// rather than trusting its return value
async function readItem(PK: string, SK: string): Promise<Record<string, unknown> | undefined> {
  const result = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK, SK },
    })
  );
  return result.Item;
}

// List the audit trail for an order: every COLLECTION_CHANGE# item in its partition
async function listAuditItems(orderId: string): Promise<Array<Record<string, unknown>>> {
  const result = await documentClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `ORDER#${orderId}`,
        ":prefix": "COLLECTION_CHANGE#",
      },
    })
  );
  return result.Items ?? [];
}

async function runTests() {
  console.log("=== update_collection_status Tool Tests ===\n");

  // Unique IDs per run to avoid collisions with DynamoDB Local persistence
  const runId = Date.now();
  const testBatchId = `TEST-UCS-${runId}`;
  const testLotId = `LOT-UCS-${runId}`;
  const testOrderId = `ORDER-UCS-${runId}`;
  const secondOrderId = `ORDER-UCS-2-${runId}`;
  const nonexistentOrderId = `ORDER-UCS-NEVER-${runId}`;

  let failures = 0;

  // ---------------------------------------------------------------------------
  console.log("Setup: Recording a batch and registering an uncollected order");
  console.log("-------------------------------------------------------------");
  console.log("Batch ID:", testBatchId);
  console.log("Lot ID:", testLotId);
  console.log("Order ID:", testOrderId);

  try {
    await recordBatchTool.handler({
      batchId: testBatchId,
      product: "Widget-CollectionStatus",
      producedDate: new Date().toISOString(),
      batchSize: 100,
      ingredientLots: [{ lotId: testLotId, quantityUsed: 50 }],
    });
    await registerOrderTool.handler({
      orderId: testOrderId,
      customerName: "Acme Foods",
      customerContact: "orders@acme.example",
      collectionStatus: "uncollected",
      batchId: testBatchId,
    });
    console.log("✓ Setup complete (batch recorded, order registered as uncollected)");
  } catch (error) {
    console.log("✗ Setup failed:");
    console.log("Error:", error);
    process.exit(1);
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 1: Update the order to collected");
  console.log("--------------------------------------");

  try {
    const result = await updateCollectionStatusTool.handler({
      orderId: testOrderId,
      collectionStatus: "collected",
      updatedBy: "test-operator",
    });
    const parsed = JSON.parse(result.content[0].text);

    const shapeOk =
      parsed.orderId === testOrderId &&
      parsed.collectionStatus === "collected" &&
      parsed.previousStatus === "uncollected" &&
      parsed.changed === true;

    // Verify the write in DynamoDB directly, not just the return value
    const orderItem = await readItem(`ORDER#${testOrderId}`, "METADATA");
    const auditItems = await listAuditItems(testOrderId);

    const orderOk = orderItem?.collectionStatus === "collected";
    const auditOk =
      auditItems.length === 1 &&
      auditItems[0].previousStatus === "uncollected" &&
      auditItems[0].newStatus === "collected" &&
      auditItems[0].updatedBy === "test-operator" &&
      auditItems[0].entityType === "COLLECTION_CHANGE" &&
      typeof auditItems[0].changedAt === "string";

    if (shapeOk && orderOk && auditOk) {
      console.log("✓ changed:true, previousStatus 'uncollected'; METADATA updated and exactly one audit item written");
    } else {
      failures += 1;
      console.log("✗ Unexpected result:");
      console.log("  shapeOk:", shapeOk, "| orderOk:", orderOk, "| auditOk:", auditOk);
      console.log("  order item:", JSON.stringify(orderItem, null, 2));
      console.log("  audit items:", JSON.stringify(auditItems, null, 2));
    }
    console.log("Result:", JSON.stringify(parsed, null, 2));
  } catch (error) {
    failures += 1;
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
    return;
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 2: Trace the batch's lot - order must now appear as collected");
  console.log("--------------------------------------------------------------------");

  try {
    const result = await traceLotTool.handler({ lotId: testLotId });
    const parsed = JSON.parse(result.content[0].text) as TraceLotResult;

    const batch = parsed.batches.find((b) => b.batchId === testBatchId);
    const tracedOrder = batch?.orders.find((o) => o.orderId === testOrderId);

    const traceOk =
      tracedOrder?.collectionStatus === "collected" &&
      parsed.summary.collected === 1 &&
      parsed.summary.uncollected === 0 &&
      parsed.summary.incomplete === 0;

    if (traceOk) {
      console.log("✓ Trace shows the order as 'collected'; summary counts moved accordingly");
    } else {
      failures += 1;
      console.log("✗ Trace mismatch:");
      console.log("  tracedOrder:", JSON.stringify(tracedOrder));
      console.log("  summary:", JSON.stringify(parsed.summary));
    }
  } catch (error) {
    failures += 1;
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 3: Update to the same status again - honest no-op, no new audit item");
  console.log("---------------------------------------------------------------------------");

  try {
    const result = await updateCollectionStatusTool.handler({
      orderId: testOrderId,
      collectionStatus: "collected",
      updatedBy: "test-operator",
    });
    const parsed = JSON.parse(result.content[0].text);

    const noOpOk =
      parsed.changed === false &&
      parsed.previousStatus === "collected" &&
      parsed.collectionStatus === "collected";

    // Exactly one COLLECTION_CHANGE item must remain - the no-op wrote nothing
    const auditItems = await listAuditItems(testOrderId);
    const auditOk = auditItems.length === 1;

    if (noOpOk && auditOk) {
      console.log("✓ changed:false returned, no error thrown, and NO second audit item was written");
    } else {
      failures += 1;
      console.log("✗ Unexpected result:");
      console.log("  noOpOk:", noOpOk, "| auditOk (exactly one audit item):", auditOk);
      console.log("  parsed:", JSON.stringify(parsed, null, 2));
      console.log("  audit items:", JSON.stringify(auditItems, null, 2));
    }
    console.log("Result:", JSON.stringify(parsed, null, 2));
  } catch (error) {
    failures += 1;
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 4: Updating from a MISSING collectionStatus (the genuine incomplete case)");
  console.log("-------------------------------------------------------------------------------");

  try {
    await registerOrderTool.handler({
      orderId: secondOrderId,
      customerName: "Initech Catering",
      customerContact: "procurement@initech.example",
      collectionStatus: "uncollected",
      batchId: testBatchId,
    });

    // Strip the field directly in DynamoDB - how real missing data arises
    await documentClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `ORDER#${secondOrderId}`, SK: "METADATA" },
        UpdateExpression: "REMOVE collectionStatus",
      })
    );
    console.log(`✓ Registered ${secondOrderId} and stripped its collectionStatus directly in DynamoDB`);

    // Trace must surface it as incomplete
    const traceBefore = JSON.parse(
      (await traceLotTool.handler({ lotId: testLotId })).content[0].text
    ) as TraceLotResult;
    const batchBefore = traceBefore.batches.find((b) => b.batchId === testBatchId);
    const tracedSecond = batchBefore?.orders.find((o) => o.orderId === secondOrderId);

    if (tracedSecond?.collectionStatus === "incomplete" && traceBefore.summary.incomplete === 1) {
      console.log("✓ Trace shows the stripped order as 'incomplete' (summary.incomplete = 1)");
    } else {
      failures += 1;
      console.log("✗ Stripped order did not trace as incomplete:");
      console.log("  tracedSecond:", JSON.stringify(tracedSecond));
      console.log("  summary:", JSON.stringify(traceBefore.summary));
    }

    // Now update it from missing to collected
    const result = await updateCollectionStatusTool.handler({
      orderId: secondOrderId,
      collectionStatus: "collected",
      updatedBy: "test-operator",
    });
    const parsed = JSON.parse(result.content[0].text);

    const fromMissingOk =
      parsed.changed === true && parsed.previousStatus === "missing";

    const traceAfter = JSON.parse(
      (await traceLotTool.handler({ lotId: testLotId })).content[0].text
    ) as TraceLotResult;
    const batchAfter = traceAfter.batches.find((b) => b.batchId === testBatchId);
    const tracedSecondAfter = batchAfter?.orders.find((o) => o.orderId === secondOrderId);

    const traceAfterOk =
      tracedSecondAfter?.collectionStatus === "collected" &&
      traceAfter.summary.incomplete === 0 &&
      traceAfter.summary.collected === 2;

    if (fromMissingOk && traceAfterOk) {
      console.log("✓ previousStatus reported as 'missing', changed:true; trace now shows it as collected");
    } else {
      failures += 1;
      console.log("✗ Unexpected result:");
      console.log("  parsed:", JSON.stringify(parsed, null, 2));
      console.log("  tracedSecondAfter:", JSON.stringify(tracedSecondAfter));
      console.log("  summary after:", JSON.stringify(traceAfter.summary));
    }
  } catch (error) {
    failures += 1;
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 5: Updating a nonexistent order");
  console.log("-------------------------------------");
  console.log("Nonexistent Order ID:", nonexistentOrderId);

  try {
    const result = await updateCollectionStatusTool.handler({
      orderId: nonexistentOrderId,
      collectionStatus: "collected",
      updatedBy: "test-operator",
    });
    failures += 1;
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (
      error instanceof UpdateCollectionStatusToolError &&
      error.error.code === "ORDER_NOT_FOUND"
    ) {
      console.log("✓ Correctly rejected the nonexistent order:");
      console.log("Error code:", error.error.code);
      console.log("Error orderId:", error.error.orderId);
      console.log("Error message:", error.error.message);

      // The check happens before any write - nothing may exist
      const item = await readItem(`ORDER#${nonexistentOrderId}`, "METADATA");
      const auditItems = await listAuditItems(nonexistentOrderId);
      if (item === undefined && auditItems.length === 0) {
        console.log("✓ Nothing was written (no METADATA, no audit items)");
      } else {
        failures += 1;
        console.log("✗ Something was written for a nonexistent order!");
        console.log("  item:", JSON.stringify(item));
        console.log("  audit items:", JSON.stringify(auditItems));
      }
    } else {
      failures += 1;
      console.log("✗ Failed with unexpected error:");
      console.log("Error:", error);
    }
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 6: Full audit history for the first order");
  console.log("------------------------------------------------");

  try {
    const auditItems = await listAuditItems(testOrderId);
    // Sort by SK so the history reads in the order the changes happened
    const sorted = [...auditItems].sort((a, b) =>
      String(a.SK).localeCompare(String(b.SK))
    );

    console.log(`Audit trail for ${testOrderId} (${sorted.length} change${sorted.length === 1 ? "" : "s"}):`);
    for (const item of sorted) {
      console.log(
        `  ${item.SK} | ${item.previousStatus} -> ${item.newStatus} | by ${item.updatedBy} | at ${item.changedAt}`
      );
    }
    console.log("Raw items:");
    console.log(JSON.stringify(sorted, null, 2));
  } catch (error) {
    failures += 1;
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 7: Concurrent updates - two simultaneous calls race on one order");
  console.log("-----------------------------------------------------------------------");
  // One order, two simultaneous "collected" requests. The guarded transaction
  // must ensure exactly one of these outcomes:
  //   A) one changed:true, the other changed:false (sequential no-op), or
  //   B) one changed:true, the other rejected with
  //      COLLECTION_STATUS_CHANGED_CONCURRENTLY (lost the read-write race).
  // Never two changed:true, and always exactly one audit item at the end.
  const RACE_ROUNDS = 10;
  const tally: Record<string, number> = {
    "A: changed:true + changed:false": 0,
    "B: changed:true + COLLECTION_STATUS_CHANGED_CONCURRENTLY": 0,
  };

  for (let round = 1; round <= RACE_ROUNDS; round += 1) {
    const raceOrderId = `ORDER-UCS-RACE-${runId}-${round}`;
    try {
      await recordBatchTool.handler({
        batchId: `BATCH-UCS-RACE-${runId}-${round}`,
        product: "Widget-Race",
        producedDate: new Date().toISOString(),
        batchSize: 10,
        ingredientLots: [{ lotId: `LOT-UCS-RACE-${runId}-${round}`, quantityUsed: 5 }],
      });
      await registerOrderTool.handler({
        orderId: raceOrderId,
        customerName: "Race Corp",
        customerContact: "race@corp.example",
        collectionStatus: "uncollected",
        batchId: `BATCH-UCS-RACE-${runId}-${round}`,
      });
    } catch (error) {
      failures += 1;
      console.log(`✗ Round ${round}: setup failed`);
      console.log("Error:", error);
      continue;
    }

    // Fire both updates at the same instant and see how the race resolves
    const settled = await Promise.allSettled([
      updateCollectionStatusTool.handler({
        orderId: raceOrderId,
        collectionStatus: "collected",
        updatedBy: `racer-A-round-${round}`,
      }),
      updateCollectionStatusTool.handler({
        orderId: raceOrderId,
        collectionStatus: "collected",
        updatedBy: `racer-B-round-${round}`,
      }),
    ]);

    // Print both settled results so the outcome of this round is visible
    const describeOutcome = (s: PromiseSettledResult<unknown>): string => {
      if (s.status === "rejected") {
        const e = s.reason;
        if (e instanceof UpdateCollectionStatusToolError) {
          return `rejected: ${e.error.code}`;
        }
        return `rejected: ${e instanceof Error ? e.name : String(e)}`;
      }
      try {
        const text =
          (s.value as { content: Array<{ type: string; text: string }> }).content[0].text;
        const parsed = JSON.parse(text) as { changed: boolean };
        return `fulfilled: changed=${parsed.changed}`;
      } catch {
        return "fulfilled: <unreadable result>";
      }
    };
    console.log(`Round ${round}: racer-A ${describeOutcome(settled[0])} | racer-B ${describeOutcome(settled[1])}`);

    // Exactly one call must have changed:true...
    const changedTrueCount = settled.filter(
      (s) =>
        s.status === "fulfilled" &&
        JSON.parse((s.value as { content: Array<{ type: string; text: string }> }).content[0].text)
          .changed === true
    ).length;

    // ...and the other must be either an honest no-op or the typed concurrent error
    const otherOutcome = settled.find(
      (s) =>
        s.status === "rejected" ||
        JSON.parse((s.value as { content: Array<{ type: string; text: string }> }).content[0].text)
          .changed === false
    );
    const otherIsAcceptable =
      otherOutcome !== undefined &&
      (otherOutcome.status === "rejected"
        ? otherOutcome.reason instanceof UpdateCollectionStatusToolError &&
          otherOutcome.reason.error.code === "COLLECTION_STATUS_CHANGED_CONCURRENTLY"
        : true);

    if (changedTrueCount === 1 && otherIsAcceptable) {
      if (otherOutcome.status === "rejected") {
        tally["B: changed:true + COLLECTION_STATUS_CHANGED_CONCURRENTLY"] += 1;
      } else {
        tally["A: changed:true + changed:false"] += 1;
      }
    } else {
      failures += 1;
      console.log(`✗ Round ${round}: unacceptable combination!`);
      console.log("  changed:true count:", changedTrueCount, "(must be exactly 1)");
      console.log("  Settled results:", JSON.stringify(settled, null, 2));
    }

    // Post-state invariants, verified straight from DynamoDB: exactly ONE audit
    // item, and the order's final collectionStatus is "collected"
    const auditItems = await listAuditItems(raceOrderId);
    const finalItem = await readItem(`ORDER#${raceOrderId}`, "METADATA");

    const auditOk = auditItems.length === 1;
    const finalOk = finalItem?.collectionStatus === "collected";

    if (auditOk && finalOk) {
      console.log(
        `  ✓ exactly one audit item (${String(auditItems[0].previousStatus)} -> ${String(auditItems[0].newStatus)}, by ${String(auditItems[0].updatedBy)}) and final collectionStatus is 'collected'`
      );
    } else {
      failures += 1;
      console.log(`✗ Round ${round}: post-state invariant violated!`);
      console.log("  audit items:", auditItems.length, "(must be exactly 1)");
      console.log("  final collectionStatus:", String(finalItem?.collectionStatus));
      console.log("  audit items raw:", JSON.stringify(auditItems, null, 2));
    }
  }

  console.log();
  console.log(`=== Race tally over ${RACE_ROUNDS} rounds ===`);
  for (const [outcome, count] of Object.entries(tally)) {
    console.log(`  ${count}x  ${outcome}`);
  }
  const unaccounted =
    RACE_ROUNDS -
    tally["A: changed:true + changed:false"] -
    tally["B: changed:true + COLLECTION_STATUS_CHANGED_CONCURRENTLY"];
  if (unaccounted === 0) {
    console.log("(every round resolved into an acceptable combination)");
  } else {
    console.log(`(${unaccounted} round(s) hit neither bucket - see failures above)`);
  }

  console.log();
  console.log("=== Tests Complete ===");
  if (failures > 0) {
    console.log(`✗ ${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("✓ All checks passed");
  }
}

runTests().catch((error) => {
  console.error("Test script failed:", error);
  process.exit(1);
});
