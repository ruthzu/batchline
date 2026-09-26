// Manual test script for register_order tool
// Run with: npx tsx server/src/tools/register-order.test.ts
// Assumes DynamoDB Local is running on localhost:8000

import { recordBatchTool } from "./record-batch.js";
import { registerOrderTool, RegisterOrderToolError } from "./register-order.js";
import { traceLotTool } from "./trace-lot.js";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
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

async function runTests() {
  console.log("=== register_order Tool Tests ===\n");

  // Unique IDs per run to avoid collisions with DynamoDB Local persistence
  const runId = Date.now();
  const testBatchId = `TEST-REG-${runId}`;
  const testLotId = `LOT-REG-${runId}`;
  const testOrderId = `ORDER-REG-${runId}`;
  const missingBatchId = `BATCH-NEVER-RECORDED-${runId}`;

  // ---------------------------------------------------------------------------
  console.log("Setup: Recording a batch via record_batch");
  console.log("-------------------------------------------");
  console.log("Batch ID:", testBatchId);
  console.log("Lot ID:", testLotId);

  try {
    await recordBatchTool.handler({
      batchId: testBatchId,
      product: "Widget-Register",
      producedDate: new Date().toISOString(),
      batchSize: 100,
      ingredientLots: [{ lotId: testLotId, quantityUsed: 50 }],
    });
    console.log("✓ Batch recorded successfully");
  } catch (error) {
    console.log("✗ Setup failed:");
    console.log("Error:", error);
    return;
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 1: Register an order against the recorded batch");
  console.log("------------------------------------------------------");
  console.log("Order ID:", testOrderId);

  try {
    const result = await registerOrderTool.handler({
      orderId: testOrderId,
      customerName: "Acme Foods",
      customerContact: "orders@acme.example",
      collectionStatus: "collected",
      batchId: testBatchId,
    });
    const parsed = JSON.parse(result.content[0].text);

    const shapeOk =
      parsed.orderId === testOrderId &&
      parsed.batchId === testBatchId &&
      parsed.status === "fulfilled";

    // Verify both items were actually written, not just echoed back
    const orderItem = await readItem(`ORDER#${testOrderId}`, "METADATA");
    const linkItem = await readItem(`BATCH#${testBatchId}`, `ORDER#${testOrderId}`);

    const orderOk =
      orderItem !== undefined &&
      orderItem.orderId === testOrderId &&
      orderItem.customerName === "Acme Foods" &&
      orderItem.customerContact === "orders@acme.example" &&
      orderItem.collectionStatus === "collected" &&
      orderItem.status === "fulfilled" &&
      orderItem.entityType === "ORDER";

    const linkOk =
      linkItem !== undefined &&
      linkItem.batchId === testBatchId &&
      linkItem.orderId === testOrderId &&
      linkItem.collectionStatus === "collected" &&
      linkItem.entityType === "BATCH_ORDER_LINK";

    if (shapeOk && orderOk && linkOk) {
      console.log("✓ Success shape correct, and both items verified in DynamoDB");
    } else {
      console.log("✗ Unexpected result:");
      console.log("  shapeOk:", shapeOk, "| orderOk:", orderOk, "| linkOk:", linkOk);
      console.log("  order item:", JSON.stringify(orderItem, null, 2));
      console.log("  link item:", JSON.stringify(linkItem, null, 2));
    }
    console.log("Result:", JSON.stringify(parsed, null, 2));
  } catch (error) {
    console.log("✗ Failed with unexpected error:");
    console.log("Error:", error);
    return;
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 2: Register the same orderId again (duplicate)");
  console.log("-----------------------------------------------------");

  try {
    const result = await registerOrderTool.handler({
      orderId: testOrderId,
      customerName: "Different Customer",
      customerContact: "other@acme.example",
      collectionStatus: "uncollected",
      batchId: testBatchId,
    });
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof RegisterOrderToolError && error.error.code === "ORDER_ALREADY_EXISTS") {
      console.log("✓ Correctly rejected the duplicate orderId:");
      console.log("Error code:", error.error.code);
      console.log("Error orderId:", error.error.orderId);
      console.log("Error message:", error.error.message);

      // The original must be untouched - a failed transaction writes nothing
      const orderItem = await readItem(`ORDER#${testOrderId}`, "METADATA");
      const untouched =
        orderItem?.customerName === "Acme Foods" &&
        orderItem?.collectionStatus === "collected";
      console.log(
        untouched
          ? "✓ Original order data untouched (no partial write)"
          : "✗ Partial write detected: original order was modified"
      );
    } else {
      console.log("✗ Failed with unexpected error:");
      console.log("Error:", error);
    }
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 3: Register an order against a nonexistent batch");
  console.log("-------------------------------------------------------");
  console.log("Missing Batch ID:", missingBatchId);

  try {
    const result = await registerOrderTool.handler({
      orderId: `ORDER-ORPHAN-${runId}`,
      customerName: "Initech Catering",
      customerContact: "procurement@initech.example",
      collectionStatus: "uncollected",
      batchId: missingBatchId,
    });
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof RegisterOrderToolError && error.error.code === "BATCH_NOT_FOUND") {
      console.log("✓ Correctly rejected the nonexistent batch:");
      console.log("Error code:", error.error.code);
      console.log("Error batchId:", error.error.batchId);
      console.log("Error message:", error.error.message);

      // No orphan order may exist - the check happens before any write
      const orphanItem = await readItem(`ORDER#ORDER-ORPHAN-${runId}`, "METADATA");
      console.log(
        orphanItem === undefined
          ? "✓ No orphan order was written"
          : "✗ Orphan order item exists:"
      );
      if (orphanItem !== undefined) {
        console.log(JSON.stringify(orphanItem, null, 2));
      }
    } else {
      console.log("✗ Failed with unexpected error:");
      console.log("Error:", error);
    }
  }

  console.log();

  // ---------------------------------------------------------------------------
  console.log("Test 4: trace_ingredient_lot finds the new order");
  console.log("--------------------------------------------------");

  try {
    const result = await traceLotTool.handler({ lotId: testLotId });
    const parsed = JSON.parse(result.content[0].text) as TraceLotResult;

    const batch = parsed.batches.find((b) => b.batchId === testBatchId);
    const tracedOrder = batch?.orders.find((o) => o.orderId === testOrderId);

    const foundAndCorrect =
      tracedOrder !== undefined &&
      tracedOrder.customerName === "Acme Foods" &&
      tracedOrder.collectionStatus === "collected";

    if (foundAndCorrect) {
      console.log("✓ New order appears in the trace with the correct collectionStatus");
    } else {
      console.log("✗ New order not found in trace, or data mismatched:");
      console.log("  tracedOrder:", JSON.stringify(tracedOrder));
    }
    console.log("Trace result:", JSON.stringify(parsed, null, 2));
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
