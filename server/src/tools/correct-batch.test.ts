// Manual test script for correct_batch_record tool
// Run with: npx tsx server/src/tools/correct-batch.test.ts
// Assumes DYNAMODB_LOCAL=true is set in environment

import { recordBatchTool } from "./record-batch.js";
import { correctBatchTool, CorrectBatchToolError } from "./correct-batch.js";

async function runTests() {
  console.log("=== correct_batch_record Tool Tests ===\n");

  // Use unique batchId per run to avoid collisions with DynamoDB Local persistence
  const testBatchId = `TEST-CORRECT-${Date.now()}`;
  const testProduct = "Widget-X";
  const testProducedDate = new Date().toISOString();
  const testBatchSize = 50;
  const originalLotId = `LOT-ORIGINAL-${Date.now()}`;

  // Setup: Create a batch with one ingredient lot
  console.log("Setup: Creating a batch with one ingredient lot");
  console.log("-------------------------------------------------");
  console.log("Batch ID:", testBatchId);
  console.log("Original Lot ID:", originalLotId);

  const batchInput = {
    batchId: testBatchId,
    product: testProduct,
    producedDate: testProducedDate,
    batchSize: testBatchSize,
    ingredientLots: [
      { lotId: originalLotId, quantityUsed: 25 },
    ],
  };

  try {
    const batchResult = await recordBatchTool.handler(batchInput);
    console.log("✓ Batch created successfully");

    if (batchResult.content?.[0]?.type === "text") {
      const parsed = JSON.parse(batchResult.content[0].text);
      console.log("Parsed:", parsed);
    }
  } catch (error) {
    console.log("✗ Failed to create batch:");
    console.log("Error:", error);
    return;
  }

  console.log();

  // Test 1: Correct the lot to a different lotId
  console.log("Test 1: Correct the lot to a different lotId");
  console.log("----------------------------------------------");

  const correctedLotId = `LOT-CORRECTED-${Date.now()}`;
  const correctionInput = {
    batchId: testBatchId,
    originalLotId: originalLotId,
    correctedLotId: correctedLotId,
    reason: "Wrong lot number recorded initially",
    correctedBy: "operator-jane",
  };

  try {
    const result = await correctBatchTool.handler(correctionInput);
    console.log("✓ Correction successful!");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof CorrectBatchToolError) {
      console.log("✗ Failed with CorrectBatchToolError:");
      console.log("Error:", JSON.stringify(error.error, null, 2));
    } else {
      console.log("✗ Failed with unexpected error:");
      console.log("Error:", error);
    }
  }

  console.log();

  // Test 2: Attempt to correct a batchId that doesn't exist
  console.log("Test 2: Attempt to correct a non-existent batch");
  console.log("-------------------------------------------------");

  const nonExistentInput = {
    batchId: "NON-EXISTENT-BATCH-999",
    originalLotId: "SOME-LOT",
    correctedLotId: "ANOTHER-LOT",
    reason: "Testing error handling",
    correctedBy: "test-system",
  };

  try {
    const result = await correctBatchTool.handler(nonExistentInput);
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof CorrectBatchToolError) {
      if (error.error.code === "BATCH_NOT_FOUND") {
        console.log("✓ Correctly rejected non-existent batch:");
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

  // Test 3: Attempt to correct a lot that was never linked to an existing batch
  console.log("Test 3: Attempt to correct a lot not linked to the batch");
  console.log("----------------------------------------------------------");

  const unlinkedLotInput = {
    batchId: testBatchId,
    originalLotId: "LOT-NEVER-LINKED-999",
    correctedLotId: "LOT-CORRECTED-002",
    reason: "Testing error handling for unlinked lot",
    correctedBy: "test-system",
  };

  try {
    const result = await correctBatchTool.handler(unlinkedLotInput);
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof CorrectBatchToolError) {
      if (error.error.code === "ORIGINAL_LOT_NOT_LINKED") {
        console.log("✓ Correctly rejected unlinked lot:");
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

  // Test 4: Attempt to correct the same original lot again (should fail with ORIGINAL_LOT_ALREADY_CORRECTED)
  console.log("Test 4: Attempt to correct an already-corrected lot");
  console.log("-------------------------------------------------------");

  const alreadyCorrectedInput = {
    batchId: testBatchId,
    originalLotId: originalLotId,
    correctedLotId: `LOT-CORRECTED-AGAIN-${Date.now()}`,
    reason: "Trying to correct again",
    correctedBy: "test-system",
  };

  try {
    const result = await correctBatchTool.handler(alreadyCorrectedInput);
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof CorrectBatchToolError) {
      if (error.error.code === "ORIGINAL_LOT_ALREADY_CORRECTED") {
        console.log("✓ Correctly rejected already-corrected lot:");
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
  console.log("=== Tests Complete ===");
}

runTests().catch((error) => {
  console.error("Test script failed:", error);
  process.exit(1);
});
