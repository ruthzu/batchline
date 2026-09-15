// Manual test script for record_batch tool
// Run with: npx tsx server/src/tools/record-batch.test.ts
// Assumes DYNAMODB_LOCAL=true is set in environment

import { recordBatchTool, RecordBatchToolError } from "./record-batch.js";

async function runTests() {
  console.log("=== record_batch Tool Tests ===\n");

  // Test 1: Record a batch with two ingredient lots
  console.log("Test 1: Recording a batch with two ingredient lots");
  console.log("---------------------------------------------------");

  const testBatchId = "TEST-001";
  const testProduct = "Widget-A";
  const testProducedDate = new Date().toISOString();
  const testBatchSize = 100;

  const input = {
    batchId: testBatchId,
    product: testProduct,
    producedDate: testProducedDate,
    batchSize: testBatchSize,
    ingredientLots: [
      { lotId: "LOT-001", quantityUsed: 50 },
      { lotId: "LOT-002", quantityUsed: 50 },
    ],
  };

  try {
    const result = await recordBatchTool.handler(input);
    console.log("✓ Success!");
    console.log("Result:", JSON.stringify(result, null, 2));
    // Parse the text content to get the structured result
    if (result.content?.[0]?.type === "text") {
      console.log("Parsed:", JSON.parse(result.content[0].text));
    }
  } catch (error) {
    if (error instanceof RecordBatchToolError) {
      console.log("✗ Failed with RecordBatchToolError:");
      console.log("Error:", JSON.stringify(error.error, null, 2));
    } else {
      console.log("✗ Failed with unexpected error:");
      console.log("Error:", error);
    }
  }

  console.log();

  // Test 2: Attempt to record the same batchId again (should fail)
  console.log("Test 2: Attempting to record the same batchId again");
  console.log("----------------------------------------------------");

  try {
    const result = await recordBatchTool.handler(input);
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof RecordBatchToolError) {
      if (error.error.code === "BATCH_ALREADY_EXISTS") {
        console.log("✓ Correctly rejected duplicate batch:");
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

  // Test 3: Attempt to record with malformed ingredient lots (should fail)
  console.log("Test 3: Attempting to record with malformed ingredient lots");
  console.log("-------------------------------------------------------------");

  const malformedInput = {
    batchId: "TEST-002",
    product: "Widget-B",
    producedDate: new Date().toISOString(),
    batchSize: 50,
    ingredientLots: [
      { lotId: "", quantityUsed: 25 }, // Empty lotId - should fail validation
    ],
  };

  try {
    const result = await recordBatchTool.handler(malformedInput);
    console.log("✗ Unexpected success - should have thrown an error");
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof RecordBatchToolError) {
      if (error.error.code === "INVALID_INGREDIENT_LOT") {
        console.log("✓ Correctly rejected malformed ingredient lot:");
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
