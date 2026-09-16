// Manual test script for trace_ingredient_lot tool
// Run with: npx tsx server/src/tools/trace-lot.test.ts
// Assumes DYNAMODB_LOCAL=true is set in environment

import { recordBatchTool } from "./record-batch.js";
import { correctBatchTool } from "./correct-batch.js";
import { traceLotTool, TraceLotToolError } from "./trace-lot.js";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

async function runTests() {
  console.log("=== trace_ingredient_lot Tool Tests ===\n");

  // Use unique IDs per run to avoid collisions with DynamoDB Local persistence
  const runId = Date.now();
  const testBatchId = `TEST-TRACE-${runId}`;
  const originalLotId = `LOT-TRACE-ORIGINAL-${runId}`;
  const otherLotId = `LOT-TRACE-OTHER-${runId}`;
  const correctedLotId = `LOT-TRACE-CORRECTED-${runId}`;
  const neverUsedLotId = `LOT-TRACE-NEVER-USED-${runId}`;

  // Setup: Record a batch with two ingredient lots, then correct one of them
  console.log("Setup: Recording a batch with two ingredient lots");
  console.log("--------------------------------------------------");
  console.log("Batch ID:", testBatchId);
  console.log("Original Lot ID:", originalLotId);
  console.log("Corrected Lot ID:", correctedLotId);

  try {
    await recordBatchTool.handler({
      batchId: testBatchId,
      product: "Widget-Trace",
      producedDate: new Date().toISOString(),
      batchSize: 75,
      ingredientLots: [
        { lotId: originalLotId, quantityUsed: 40 },
        { lotId: otherLotId, quantityUsed: 35 },
      ],
    });
    console.log("✓ Batch recorded successfully");
  } catch (error) {
    console.log("✗ Failed to record batch:");
    console.log("Error:", error);
    return;
  }

  console.log();

  console.log("Setup: Correcting one lot to a third lotId");
  console.log("------------------------------------------");

  const finalLotId = `LOT-TRACE-FINAL-${runId}`;

  try {
    await correctBatchTool.handler({
      batchId: testBatchId,
      originalLotId,
      correctedLotId: finalLotId,
      reason: "Wrong lot number recorded initially",
      correctedBy: "operator-jane",
    });
    console.log("✓ Correction successful:", originalLotId, "->", finalLotId);
  } catch (error) {
    console.log("✗ Failed to correct batch:");
    console.log("Error:", error);
    return;
  }

  console.log();

  // Test 1: Trace the ORIGINAL lot - the corrected-away batch usage should NOT appear
  console.log("Test 1: Trace the original lot (corrected-away link excluded)");
  console.log("--------------------------------------------------------------");

  try {
    const result = await traceLotTool.handler({ lotId: originalLotId });
    const parsed = JSON.parse(result.content[0].text);
    const batchIds = parsed.batches.map((b: { batchId: string }) => b.batchId);

    if (batchIds.includes(testBatchId)) {
      console.log("✗ Unexpected: batch appears in original lot trace");
      console.log("Result:", JSON.stringify(parsed, null, 2));
    } else {
      console.log("✓ Correctly excluded the superseded batch link");
      console.log("Result:", JSON.stringify(parsed, null, 2));
    }
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // Test 2: Trace the CORRECTED lot - the batch SHOULD appear
  // (the originalLotId link was superseded; finalLotId received the corrected link)
  console.log("Test 2: Trace the final (corrected-to) lot");
  console.log("-------------------------------------------");

  try {
    const result = await traceLotTool.handler({ lotId: finalLotId });
    const parsed = JSON.parse(result.content[0].text);
    const batchIds = parsed.batches.map((b: { batchId: string }) => b.batchId);

    if (batchIds.includes(testBatchId)) {
      console.log("✓ Correctly found the batch via the corrected lot");
      console.log("Result:", JSON.stringify(parsed, null, 2));
    } else {
      console.log("✗ Unexpected: batch missing from corrected lot trace");
      console.log("Result:", JSON.stringify(parsed, null, 2));
    }
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();

  // Test 3: Trace a completely unused, never-recorded lotId -> LOT_NOT_FOUND
  console.log("Test 3: Trace a never-recorded lot (expect LOT_NOT_FOUND)");
  console.log("----------------------------------------------------------");

  try {
    const result = await traceLotTool.handler({ lotId: neverUsedLotId });
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof TraceLotToolError) {
      if (error.error.code === "LOT_NOT_FOUND") {
        console.log("✓ Correctly rejected never-recorded lot:");
        console.log("Error code:", error.error.code);
        console.log("Error message:", error.error.message);
      } else {
        console.log("✗ Wrong error type:");
        console.log("Error:", JSON.stringify(error.error, null, 2));
      }
    } else {
      console.log("✗ Failed with unexpected error:");
      console.log("Error:", error);
    }
  }

  console.log();

  // Test 4: Trace a lot that has a METADATA record but zero ACTIVE batch links
  // (one of the placeholder lots created as a side effect of record_batch)
  console.log("Test 4: Trace a placeholder lot with no active batch links");
  console.log("-----------------------------------------------------------");
  console.log("Placeholder Lot ID:", originalLotId);

  try {
    const result = await traceLotTool.handler({ lotId: originalLotId });
    const parsed = JSON.parse(result.content[0].text);

    const isEmptyTrace =
      Array.isArray(parsed.batches) &&
      parsed.batches.length === 0 &&
      parsed.summary.collected === 0 &&
      parsed.summary.uncollected === 0 &&
      parsed.summary.incomplete === 0;

    if (isEmptyTrace) {
      console.log("✓ Correctly returned an empty trace (not an error)");
      console.log("Result:", JSON.stringify(parsed, null, 2));
    } else {
      console.log("✗ Unexpected: expected empty batches and zero summary counts");
      console.log("Result:", JSON.stringify(parsed, null, 2));
    }
  } catch (error) {
    console.log("✗ Failed with unexpected error - placeholder lot should NOT error:");
    console.log("Error:", error);
  }

  console.log();

  // Test 5: Orders on the traced batch appear with customer info and summary counts
  console.log("Test 5: Orders appear in the trace with summary counts");
  console.log("-------------------------------------------------------");

  const orderIdCollected = `ORDER-TRACE-COLLECTED-${runId}`;
  const orderIdUncollected = `ORDER-TRACE-UNCOLLECTED-${runId}`;
  const orderIdMissingMetadata = `ORDER-TRACE-NOMETADATA-${runId}`;

  try {
    // Seed batch-order links and order metadata directly (read-only tool under
    // test; no order-recording tool exists yet)
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `BATCH#${testBatchId}`,
          SK: `ORDER#${orderIdCollected}`,
          batchId: testBatchId,
          orderId: orderIdCollected,
          quantityAllocated: 25,
          entityType: "BATCH_ORDER_LINK",
        },
      })
    );
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `BATCH#${testBatchId}`,
          SK: `ORDER#${orderIdUncollected}`,
          batchId: testBatchId,
          orderId: orderIdUncollected,
          quantityAllocated: 25,
          entityType: "BATCH_ORDER_LINK",
        },
      })
    );
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `BATCH#${testBatchId}`,
          SK: `ORDER#${orderIdMissingMetadata}`,
          batchId: testBatchId,
          orderId: orderIdMissingMetadata,
          quantityAllocated: 25,
          entityType: "BATCH_ORDER_LINK",
        },
      })
    );
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `ORDER#${orderIdCollected}`,
          SK: "METADATA",
          orderId: orderIdCollected,
          customerName: "Acme Foods",
          customerContact: "orders@acme.example",
          status: "fulfilled",
          collectionStatus: "collected",
          entityType: "ORDER",
        },
      })
    );
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `ORDER#${orderIdUncollected}`,
          SK: "METADATA",
          orderId: orderIdUncollected,
          customerName: "Globex Cafe",
          customerContact: "hello@globex.example",
          status: "fulfilled",
          collectionStatus: "uncollected",
          entityType: "ORDER",
        },
      })
    );
    // NOTE: no METADATA item for orderIdMissingMetadata on purpose

    const result = await traceLotTool.handler({ lotId: finalLotId });
    const parsed = JSON.parse(result.content[0].text);

    const orders = parsed.batches?.[0]?.orders ?? [];
    const byId = new Map<string, { collectionStatus: string; customerName?: string }>(
      orders.map((o: { orderId: string; collectionStatus: string; customerName?: string }) => [o.orderId, o])
    );

    const collectedOk =
      byId.get(orderIdCollected)?.collectionStatus === "collected" &&
      byId.get(orderIdCollected)?.customerName === "Acme Foods";
    const uncollectedOk = byId.get(orderIdUncollected)?.collectionStatus === "uncollected";
    const missingMetadataOk = byId.get(orderIdMissingMetadata)?.collectionStatus === "incomplete";
    const summaryOk =
      parsed.summary.collected === 1 &&
      parsed.summary.uncollected === 1 &&
      parsed.summary.incomplete === 1;

    if (collectedOk && uncollectedOk && missingMetadataOk && summaryOk) {
      console.log("✓ Orders traced correctly, missing order metadata surfaced as 'incomplete'");
      console.log("Result:", JSON.stringify(parsed, null, 2));
    } else {
      console.log("✗ Unexpected trace result:");
      console.log(JSON.stringify(parsed, null, 2));
    }
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
  }

  console.log();
  console.log("=== Tests Complete ===");
}

runTests().catch((error) => {
  console.error("Test script failed:", error);
  process.exit(1);
});
