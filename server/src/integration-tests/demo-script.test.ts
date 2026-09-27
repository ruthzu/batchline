// End-to-end integration test: the project's full demo script, played out
// against real tool handlers and DynamoDB Local.
// Run with (from server/): npm run test:demo
//   equivalently: npx tsx src/integration-tests/demo-script.test.ts
// Assumes DynamoDB Local is running on localhost:8000 (docker compose up -d)
// and the table exists (npm run provision:db).
//
// Unlike the per-tool test files, this walks the entire demo narrative in
// order — record a batch, register orders, trace the lot, preview + commit a
// controlled response, prove the commit is idempotent, then correct a wrong
// lot — calling the real tool handlers directly (no curl, no voice layer) and
// asserting correctness at every step. Any failed assertion aborts the run
// loudly with a clear ✗ instead of silently continuing.
//
// All IDs are Date.now()-suffixed per run, so repeated runs never collide with
// data left behind by earlier runs (or with a real demo done via the voice
// interface, whose phrasing these steps mirror).

import { recordBatchTool, type RecordBatchResult } from "../tools/record-batch.js";
import { registerOrderTool, type RegisterOrderResult } from "../tools/register-order.js";
import { traceLotTool } from "../tools/trace-lot.js";
import {
  previewResponseTool,
  type PreviewResponseResult,
  type OrderAction,
} from "../tools/preview-response.js";
import { commitResponseTool, type CommitResponseResult } from "../tools/commit-response.js";
import { correctBatchTool, type CorrectBatchResult } from "../tools/correct-batch.js";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { TraceLotResult, TracedOrder, CollectionStatus } from "@batchline/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Unwrap a tool result's text content into the structured object the handler
// returned (the handlers serialize their result as JSON text)
function parseToolText<T>(result: { content: Array<{ type: string; text: string }> }): T {
  const block = result.content?.[0];
  if (!block || block.type !== "text") {
    throw new Error("Expected tool result with text content, got none");
  }
  return JSON.parse(block.text) as T;
}

// Loud assertion: throws with the message (plus optional details dump), which
// the step runner below reports as a clear ✗ for the step. Declared as an
// assertion function so passing checks also narrow the asserted value.
function assert(condition: boolean, message: string, details?: unknown): asserts condition {
  if (!condition) {
    const suffix =
      details === undefined
        ? ""
        : `\n  Details: ${typeof details === "string" ? details : JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

// Read an item straight from DynamoDB, to verify what the tools actually wrote
// rather than trusting their return values
async function readItem(PK: string, SK: string): Promise<Record<string, unknown> | undefined> {
  const result = await documentClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK, SK } })
  );
  return result.Item;
}

async function readOrder(orderId: string): Promise<Record<string, unknown> | undefined> {
  return readItem(`ORDER#${orderId}`, "METADATA");
}

function sortById<T extends { orderId: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.orderId.localeCompare(b.orderId));
}

// The demo's response policy: uncollected orders are held, collected ones get
// a drafted notice, incomplete ones are flagged for human follow-up
const ACTION_FOR_STATUS: Record<CollectionStatus, "hold" | "notify" | "flag"> = {
  uncollected: "hold",
  collected: "notify",
  incomplete: "flag",
};

// The status commit_approved_response writes for each action (mirrors
// ACTION_STATUS in commit-response.ts, spelled out here so the assertions
// pin the actual mapping)
const STATUS_FOR_ACTION: Record<OrderAction["action"], string> = {
  hold: "on_hold",
  notify: "notified",
  flag: "flagged_incomplete",
};

// Step runner: labels each demo step, reports ✓/✗ loudly, and records the
// outcome for the final summary. Every assertion failure throws up into here.
type StepOutcome = { label: string; ok: boolean; error?: unknown };
const outcomes: StepOutcome[] = [];

async function runStep(label: string, fn: () => Promise<void>): Promise<boolean> {
  console.log(`\n${label}`);
  console.log("=".repeat(label.length));
  try {
    await fn();
    console.log("✓ PASSED");
    outcomes.push({ label, ok: true });
    return true;
  } catch (error) {
    console.log("✗ FAILED");
    console.log(error instanceof Error ? `  ${error.message}` : `  ${error}`);
    outcomes.push({ label, ok: false, error });
    return false;
  }
}

// ---------------------------------------------------------------------------
// The demo script
// ---------------------------------------------------------------------------

async function runDemo(): Promise<void> {
  // Unique IDs per run so this is safely re-runnable against persistent Local data
  const runId = Date.now();
  const batchId = `BATCH-DEMO-${runId}`;
  const flourLotId = `F17-${runId}`; // the lot the demo "misrecords" and later corrects
  const butterLotId = `B08-${runId}`;
  const correctedFlourLotId = `F22-${runId}`; // the right flour lot, set in step 5
  const idempotencyKey = `IDEM-DEMO-${runId}`;

  const orders = {
    collected1: { id: `ORDER-DEMO-C1-${runId}`, name: "Acme Bakery", contact: "orders@acme.example" },
    collected2: { id: `ORDER-DEMO-C2-${runId}`, name: "Globex Cafe", contact: "hello@globex.example" },
    uncollected1: { id: `ORDER-DEMO-U1-${runId}`, name: "Initech Catering", contact: "procurement@initech.example" },
    uncollected2: { id: `ORDER-DEMO-U2-${runId}`, name: "Umbrella Bistro", contact: "kitchen@umbrella.example" },
    // Registered with a real collectionStatus, then stripped below - a real
    // "incomplete" order is one whose collectionStatus went missing, not one
    // that was created with the literal string "incomplete"
    incomplete1: { id: `ORDER-DEMO-I1-${runId}`, name: "Stark Sandwiches", contact: "deli@stark.example" },
  };
  const allOrderIds = Object.values(orders).map((o) => o.id);
  const expectedSummary: Record<CollectionStatus, number> = {
    collected: 2,
    uncollected: 2,
    incomplete: 1,
  };

  console.log("=== Batchline Demo Script — End-to-End Integration Test ===");
  console.log();
  console.log(`Run ID: ${runId} (all IDs suffixed with it, so re-runs never collide)`);
  console.log(`Batch:            ${batchId}`);
  console.log(`Flour lot:        ${flourLotId}  -> corrected to ${correctedFlourLotId} in step 5`);
  console.log(`Butter lot:       ${butterLotId}`);
  console.log(`Collected orders: ${orders.collected1.id}, ${orders.collected2.id}`);
  console.log(`Uncollected:      ${orders.uncollected1.id}, ${orders.uncollected2.id}`);
  console.log(`Incomplete:       ${orders.incomplete1.id} (collectionStatus stripped after registration)`);
  console.log(`Idempotency key:  ${idempotencyKey}`);

  recapContext = {
    batchId,
    flourLotId,
    butterLotId,
    correctedFlourLotId,
    orders: Object.values(orders).map((order) => ({
      id: order.id,
      name: order.name,
      collectionStatus: "",
    })),
  };

  // -------------------------------------------------------------------------
  console.log('\nVoice-equivalent: "Batch 24 used flour lot F17 and butter lot B08"');

  let ok = await runStep(
    "STEP 1: RECORD A BATCH (record_batch)",
    async () => {
      const result = parseToolText<RecordBatchResult>(
        await recordBatchTool.handler({
          batchId,
          product: "Sourdough Loaf",
          producedDate: new Date().toISOString(),
          batchSize: 120,
          ingredientLots: [
            { lotId: flourLotId, quantityUsed: 80 },
            { lotId: butterLotId, quantityUsed: 40 },
          ],
        })
      );

      assert(result.batchId === batchId, "Result batchId mismatch", result);
      assert(
        sortById(result.lotsLinked.map((lotId) => ({ orderId: lotId }))).length === 2 &&
          result.lotsLinked.includes(flourLotId) &&
          result.lotsLinked.includes(butterLotId),
        "lotsLinked should contain exactly the two ingredient lots",
        result
      );
      console.log("Result:", JSON.stringify(result, null, 2));
    }
  );
  if (!ok) return finishSummary();

  // -------------------------------------------------------------------------
  ok = await runStep(
    "STEP 2: REGISTER ORDERS (register_order) — collected, uncollected, and one genuinely incomplete",
    async () => {
      // collected + uncollected orders
      const registrations: Array<{ input: typeof orders[keyof typeof orders]; collectionStatus: CollectionStatus }> = [
        { input: orders.collected1, collectionStatus: "collected" },
        { input: orders.collected2, collectionStatus: "collected" },
        { input: orders.uncollected1, collectionStatus: "uncollected" },
        { input: orders.uncollected2, collectionStatus: "uncollected" },
        // Registered with a real status; the field is stripped right after to
        // produce the incomplete case the way real missing data arises
        { input: orders.incomplete1, collectionStatus: "collected" },
      ];

      for (const { input, collectionStatus } of registrations) {
        const result = parseToolText<RegisterOrderResult>(
          await registerOrderTool.handler({
            orderId: input.id,
            customerName: input.name,
            customerContact: input.contact,
            collectionStatus,
            batchId,
          })
        );
        assert(
          result.orderId === input.id && result.batchId === batchId && result.status === "fulfilled",
          `Registration success shape mismatch for ${input.id}`,
          result
        );
        console.log(`✓ Registered ${input.id} (${input.name}) as ${collectionStatus}`);
      }

      // Produce the genuinely incomplete order: strip collectionStatus from
      // the order METADATA item directly in DynamoDB, exactly like a partial
      // write / lost field would leave it in production
      await documentClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `ORDER#${orders.incomplete1.id}`, SK: "METADATA" },
          UpdateExpression: "REMOVE collectionStatus",
        })
      );

      const stripped = await readOrder(orders.incomplete1.id);
      assert(
        stripped !== undefined && stripped.collectionStatus === undefined,
        `Expected collectionStatus to be gone from ${orders.incomplete1.id} after the REMOVE`,
        stripped
      );
      console.log(
        `✓ Stripped collectionStatus from ${orders.incomplete1.id} directly in DynamoDB (genuine missing-data case)`
      );
    }
  );
  if (!ok) return finishSummary();

  // -------------------------------------------------------------------------
  let firstTrace: TraceLotResult;
  let tracedBatch: TraceLotResult["batches"][number] | undefined;

  ok = await runStep(
    `STEP 3: TRACE THE LOT (trace_ingredient_lot) — voice-equivalent: "Trace flour lot ${flourLotId}"`,
    async () => {
      const result = parseToolText<TraceLotResult>(
        await traceLotTool.handler({ lotId: flourLotId })
      );
      firstTrace = result;

      const batch = result.batches.find((b) => b.batchId === batchId);
      assert(batch !== undefined, "Our batch should appear in the trace", result);
      tracedBatch = batch;

      // All five orders from step 2 appear
      const byId = new Map<string, TracedOrder>(batch.orders.map((o) => [o.orderId, o]));
      for (const orderId of allOrderIds) {
        assert(byId.has(orderId), `Order ${orderId} missing from the trace`, batch.orders);
      }
      assert(batch.orders.length === 5, "Trace should list exactly 5 orders", batch.orders);

      // Per-order collectionStatus matches how each order was set up
      const expectedStatus: Record<string, CollectionStatus> = {
        [orders.collected1.id]: "collected",
        [orders.collected2.id]: "collected",
        [orders.uncollected1.id]: "uncollected",
        [orders.uncollected2.id]: "uncollected",
        // The stripped order must surface as incomplete, not crash the trace
        [orders.incomplete1.id]: "incomplete",
      };
      for (const [orderId, status] of Object.entries(expectedStatus)) {
        assert(
          byId.get(orderId)?.collectionStatus === status,
          `Order ${orderId} should trace as '${status}'`,
          byId.get(orderId)
        );
      }

      // Summary counts exactly match what was set up
      assert(
        result.summary.collected === expectedSummary.collected &&
          result.summary.uncollected === expectedSummary.uncollected &&
          result.summary.incomplete === expectedSummary.incomplete,
        "Summary counts should exactly match the setup (2 collected / 2 uncollected / 1 incomplete)",
        result.summary
      );

      console.log("Trace result:", JSON.stringify(result, null, 2));

      // This is the exact data the demo script has Alexa+ speak aloud
      const list = (status: CollectionStatus) =>
        batch.orders
          .filter((o) => o.collectionStatus === status)
          .map((o) => `${o.orderId} (${o.customerName ?? "unknown customer"})`)
          .join(", ");
      console.log("\n--- What Alexa+ speaks aloud (from this exact trace data) ---");
      console.log(
        `"Batch ${batchId} (${batch.product}) used flour lot ${flourLotId}. ` +
          `It reached ${batch.orders.length} orders: ` +
          `${result.summary.collected} collected, ` +
          `${result.summary.uncollected} uncollected, and ` +
          `${result.summary.incomplete} with incomplete records. ` +
          `Collected: ${list("collected")}. ` +
          `Uncollected: ${list("uncollected")}. ` +
          `Incomplete: ${list("incomplete")}."`
      );
      console.log("--------------------------------------------------------------");
    }
  );
  if (!ok) return finishSummary();
  assert(tracedBatch !== undefined, "Step 3 must have traced the batch");

  // -------------------------------------------------------------------------
  // Response policy derived from the step-3 trace: hold uncollected, notify
  // collected, flag incomplete — the same derivation the voice flow performs
  const plannedActions: OrderAction[] = tracedBatch.orders.map((o) => ({
    orderId: o.orderId,
    action: ACTION_FOR_STATUS[o.collectionStatus],
  }));

  let previewId = "";
  let firstCommit: CommitResponseResult;

  ok = await runStep(
    'STEP 4a: PREVIEW THE RESPONSE (preview_response) — voice-equivalent: "put uncollected orders on hold, draft notices for collected ones, flag incomplete ones, don\'t send anything yet"',
    async () => {
      const result = parseToolText<PreviewResponseResult>(
        await previewResponseTool.handler({ orderActions: plannedActions })
      );
      previewId = result.previewId;

      assert(typeof previewId === "string" && previewId.length > 0, "previewId should be present", result);
      assert(!isNaN(Date.parse(result.generatedAt)), "generatedAt should be a valid timestamp", result);
      assert(result.actions.length === plannedActions.length, "Preview should draft one entry per action", result.actions);

      const byId = new Map(result.actions.map((a) => [a.orderId, a]));
      for (const planned of plannedActions) {
        const entry = byId.get(planned.orderId);
        assert(entry !== undefined, `Preview missing a draft for ${planned.orderId}`, result.actions);
        assert(entry.action === planned.action, `Wrong action drafted for ${planned.orderId}`, entry);
        assert(entry.currentStatus === "fulfilled", `Preview should report currentStatus 'fulfilled' for ${planned.orderId}`, entry);
      }
      // Customer names come from the real registered orders
      assert(
        byId.get(orders.collected1.id)?.customerName === orders.collected1.name &&
          byId.get(orders.uncollected1.id)?.customerName === orders.uncollected1.name &&
          byId.get(orders.incomplete1.id)?.customerName === orders.incomplete1.name,
        "Preview should carry the registered customer names",
        result.actions
      );
      // draftMessage only for notify entries, and it must be a real draft
      for (const entry of result.actions) {
        if (entry.action === "notify") {
          assert(
            typeof entry.draftMessage === "string" && entry.draftMessage.includes(entry.orderId),
            `Notify draft for ${entry.orderId} should contain a real message`,
            entry
          );
        } else {
          assert(
            !("draftMessage" in entry),
            `Non-notify draft for ${entry.orderId} must not carry a draftMessage`,
            entry
          );
        }
      }

      console.log("Preview (the human-approvable draft):", JSON.stringify(result, null, 2));

      // NO WRITES: re-fetch every order straight from DynamoDB and assert the
      // status fields are unchanged
      for (const orderId of allOrderIds) {
        const item = await readOrder(orderId);
        assert(
          item !== undefined && item.status === "fulfilled" && item.notifiedAt === undefined,
          `Preview must not write anything, but ${orderId} changed`,
          item
        );
      }
      console.log("✓ All 5 orders re-fetched from DynamoDB: status still 'fulfilled', preview wrote nothing");
    }
  );
  if (!ok) return finishSummary();

  ok = await runStep(
    "STEP 4b: COMMIT THE APPROVED RESPONSE (commit_approved_response) with a fresh idempotency key",
    async () => {
      const result = parseToolText<CommitResponseResult>(
        await commitResponseTool.handler({ previewId, orderActions: plannedActions, idempotencyKey })
      );
      firstCommit = result;

      assert(result.previewId === previewId, "Commit should echo the approved previewId", result);
      assert(result.committed.length === plannedActions.length, "Commit should report every action", result.committed);

      const committedById = new Map(result.committed.map((c) => [c.orderId, c]));
      for (const planned of plannedActions) {
        const entry = committedById.get(planned.orderId);
        assert(entry !== undefined, `Committed result missing ${planned.orderId}`, result.committed);
        assert(
          entry.newStatus === STATUS_FOR_ACTION[planned.action],
          `Wrong newStatus for ${planned.orderId}`,
          entry
        );
      }

      // Verify against DynamoDB directly, not against the tool's return value
      for (const planned of plannedActions) {
        const item = await readOrder(planned.orderId);
        assert(
          item !== undefined && item.status === STATUS_FOR_ACTION[planned.action],
          `Order ${planned.orderId} should have status '${STATUS_FOR_ACTION[planned.action]}' in DynamoDB`,
          item
        );
        if (planned.action === "notify") {
          assert(typeof item.notifiedAt === "string", `Notified order ${planned.orderId} should record notifiedAt`, item);
        } else {
          assert(item.notifiedAt === undefined, `Non-notified order ${planned.orderId} must not have notifiedAt`, item);
        }
      }

      console.log("Commit result:", JSON.stringify(result, null, 2));
      console.log("✓ All 5 order statuses changed in DynamoDB (on_hold / notified / flagged_incomplete)");
    }
  );
  if (!ok) return finishSummary();

  ok = await runStep(
    "STEP 4c: REPLAY THE SAME COMMIT — same idempotency key must not re-execute",
    async () => {
      // Plant a sentinel status on one held order. If the replay re-ran the
      // transaction, the sentinel would be overwritten with "on_hold" again -
      // so if it survives, the transaction provably did not run a second time.
      const sentinel = `SENTINEL_NOT_REEXECUTED_${runId}`;
      const heldItem = await readOrder(orders.uncollected1.id);
      assert(heldItem !== undefined, `Order ${orders.uncollected1.id} should exist before planting the sentinel`, heldItem);
      await documentClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { ...heldItem, status: sentinel },
        })
      );
      console.log(`Planted sentinel status on ${orders.uncollected1.id} -> ${sentinel}`);

      const replay = parseToolText<CommitResponseResult>(
        await commitResponseTool.handler({ previewId, orderActions: plannedActions, idempotencyKey })
      );

      const sentinelSurvived = (await readOrder(orders.uncollected1.id))?.status === sentinel;
      assert(sentinelSurvived, "Sentinel was overwritten - the commit re-executed!", orders.uncollected1.id);

      // The replay must return the original stored result verbatim. Compare
      // field by field (the stored result round-trips through DynamoDB, which
      // preserves values but not object key order).
      const committedEqual =
        firstCommit.committed.length === replay.committed.length &&
        sortById(firstCommit.committed).every((entry, i) => {
          const other = sortById(replay.committed)[i];
          return (
            entry.orderId === other.orderId &&
            entry.action === other.action &&
            entry.newStatus === other.newStatus
          );
        });
      assert(replay.previewId === firstCommit.previewId, "Replay should return the original previewId", replay);
      assert(replay.committedAt === firstCommit.committedAt, "Replay should return the original committedAt", replay);
      assert(committedEqual, "Replay should return the original committed actions", replay.committed);

      console.log("Replayed result:", JSON.stringify(replay, null, 2));
      console.log("✓ Replay returned the identical stored result and re-executed nothing");

      // Restore the real status so the final recap shows the true end state
      const afterReplay = await readOrder(orders.uncollected1.id);
      await documentClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { ...afterReplay, status: "on_hold" },
        })
      );
      console.log(`Restored ${orders.uncollected1.id} status to 'on_hold' for the recap`);
    }
  );
  if (!ok) return finishSummary();

  // -------------------------------------------------------------------------
  let correction: CorrectBatchResult;

  ok = await runStep(
    `STEP 5a: CORRECT THE BATCH (correct_batch_record) — voice-equivalent: "Correct batch, wrong flour lot recorded"`,
    async () => {
      const result = parseToolText<CorrectBatchResult>(
        await correctBatchTool.handler({
          batchId,
          originalLotId: flourLotId,
          correctedLotId: correctedFlourLotId,
          reason: "Wrong flour lot recorded at production time",
          correctedBy: "operator-demo",
        })
      );
      correction = result;

      assert(result.batchId === batchId, "Correction should echo the batchId", result);
      assert(result.originalLotId === flourLotId, "Correction should echo the originalLotId", result);
      assert(result.correctedLotId === correctedFlourLotId, "Correction should echo the correctedLotId", result);

      // affectedOrderIds must match the actual orders on the batch
      const affectedSorted = sortById(result.affectedOrderIds.map((orderId) => ({ orderId })));
      const expectedSorted = sortById(allOrderIds.map((orderId) => ({ orderId })));
      assert(
        affectedSorted.length === expectedSorted.length &&
          affectedSorted.every((e, i) => e.orderId === expectedSorted[i].orderId),
        "affectedOrderIds should be exactly the 5 orders registered on this batch",
        result.affectedOrderIds
      );

      console.log("Correction result:", JSON.stringify(result, null, 2));
    }
  );
  if (!ok) return finishSummary();

  ok = await runStep(
    `STEP 5b: RE-TRACE THE ORIGINAL LOT (${flourLotId}) — the corrected-away batch must be gone`,
    async () => {
      const result = parseToolText<TraceLotResult>(
        await traceLotTool.handler({ lotId: flourLotId })
      );

      assert(
        !result.batches.some((b) => b.batchId === batchId),
        "Corrected-away batch still appears under the original lot!",
        result
      );
      // The lot is unique to this run, so with its only link superseded the
      // trace must be completely empty
      assert(result.batches.length === 0, "Expected an empty trace after the correction", result.batches);
      assert(
        result.summary.collected === 0 && result.summary.uncollected === 0 && result.summary.incomplete === 0,
        "Summary counts should all be zero after the correction",
        result.summary
      );

      console.log("Trace result:", JSON.stringify(result, null, 2));
      console.log(`✓ Batch ${batchId} no longer appears under ${flourLotId}`);
    }
  );
  if (!ok) return finishSummary();

  ok = await runStep(
    `STEP 5c: RE-TRACE THE CORRECTED LOT (${correctedFlourLotId}) — the batch and all 5 orders must appear`,
    async () => {
      const result = parseToolText<TraceLotResult>(
        await traceLotTool.handler({ lotId: correctedFlourLotId })
      );

      const batch = result.batches.find((b) => b.batchId === batchId);
      assert(batch !== undefined, "Batch should appear under the corrected lot", result);
      assert(batch.orders.length === 5, "All 5 orders should appear under the corrected lot", batch.orders);

      // Same order set and statuses as the original trace
      const beforeById = new Map(firstTrace.batches[0].orders.map((o) => [o.orderId, o]));
      for (const order of batch.orders) {
        const before = beforeById.get(order.orderId);
        assert(before !== undefined, `Order ${order.orderId} was not in the original trace`, order);
        assert(
          order.collectionStatus === before.collectionStatus && order.customerName === before.customerName,
          `Order ${order.orderId} data changed across the correction`,
          { before, after: order }
        );
      }

      assert(
        result.summary.collected === firstTrace.summary.collected &&
          result.summary.uncollected === firstTrace.summary.uncollected &&
          result.summary.incomplete === firstTrace.summary.incomplete,
        "Summary counts should be identical to the original trace",
        result.summary
      );

      console.log("Trace result:", JSON.stringify(result, null, 2));
      console.log(`✓ Batch ${batchId} now traceable via ${correctedFlourLotId} with identical data`);
    }
  );
  if (!ok) return finishSummary();

  return finishSummary();
}

// ---------------------------------------------------------------------------
// Final summary: pass/fail tally plus a recap of the resulting state, so this
// doubles as documentation of what the full flow produces
// ---------------------------------------------------------------------------

async function finishSummary(): Promise<void> {
  const passed = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - passed;

  console.log("\n=============================================================");
  console.log("=== DEMO SCRIPT SUMMARY ===");
  console.log("=============================================================");
  for (const outcome of outcomes) {
    console.log(`${outcome.ok ? "✓" : "✗"} ${outcome.label}`);
    if (!outcome.ok && outcome.error instanceof Error) {
      console.log(`    -> ${outcome.error.message.split("\n")[0]}`);
    }
  }
  console.log(`\nTotal steps: ${outcomes.length} — passed: ${passed}, failed: ${failed}`);

  // Only recap the end state if the run got far enough to have one
  if (failed === 0 && outcomes.length > 0) {
    try {
      // The recap re-reads DynamoDB so it documents real state, not hopes
      console.log("\n--- FINAL STATE RECAP (re-read from DynamoDB) ---");
      await printFinalState();
    } catch (error) {
      console.log("(Recap failed to read final state:", error, ")");
    }
  }

  process.exitCode = failed === 0 ? 0 : 1;
}

// The demo IDs live in runDemo's scope; the recap uses this module-level
// context that runDemo fills in before the steps run.
let recapContext: {
  batchId: string;
  flourLotId: string;
  butterLotId: string;
  correctedFlourLotId: string;
  orders: Array<{ id: string; name: string; collectionStatus: string }>;
} | null = null;

async function printFinalState(): Promise<void> {
  if (!recapContext) {
    console.log("(No recap context recorded)");
    return;
  }
  const { batchId, flourLotId, butterLotId, correctedFlourLotId, orders } = recapContext;

  const batch = await readItem(`BATCH#${batchId}`, "METADATA");
  const flourLink = await readItem(`LOT#${flourLotId}`, `BATCH#${batchId}`);
  const butterLink = await readItem(`LOT#${butterLotId}`, `BATCH#${batchId}`);
  const correctedLink = await readItem(`LOT#${correctedFlourLotId}`, `BATCH#${batchId}`);

  console.log(`Batch: ${batchId} — product=${batch?.product}, size=${batch?.batchSize}, produced=${batch?.producedDate}`);
  console.log("Lot links:");
  console.log(
    `  ${flourLotId}: ${flourLink?.supersededBy ? `SUPERSEDED (corrected away to ${flourLink.supersededBy})` : "active"}`
  );
  console.log(`  ${butterLotId}: ${butterLink && !butterLink.supersededBy ? "active" : "superseded/missing"}`);
  console.log(
    `  ${correctedFlourLotId}: ${correctedLink && !correctedLink.supersededBy ? `active (correctedFrom ${correctedLink.correctedFrom})` : "superseded/missing"}`
  );

  console.log("Orders:");
  for (const order of orders) {
    const item = await readOrder(order.id);
    console.log(
      `  ${order.id} — ${order.name}: collectionStatus=${item?.collectionStatus ?? "MISSING (incomplete)"}, status=${item?.status}${
        item?.notifiedAt ? `, notifiedAt=${item.notifiedAt}` : ""
      }`
    );
  }
}

runDemo().catch((error) => {
  console.error("Demo script failed:", error);
  process.exit(1);
});
