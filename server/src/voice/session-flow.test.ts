/**
 * session-flow.test.ts — deterministic test of the voice layer's conversation
 * flow: trace -> draft -> approve, plus the failure/expiry paths.
 *
 * NEVER calls Groq: it drives the exported resolvers directly
 * (expandTraceToActions, resolveDraftResponseFromTrace,
 * resolveApprovePendingResponse), so every run gives the same answer for the
 * same data. It DOES need DynamoDB Local, because the resolvers call the REAL
 * previewResponseTool / commitResponseTool underneath — nothing is mocked.
 *
 * Run with (from server/, DynamoDB Local must be reachable):
 *   docker compose up -d          # from the repo root
 *   DYNAMODB_LOCAL=true npx tsx src/voice/session-flow.test.ts
 *
 * Covered:
 *   1. trace stored -> policy expands correctly, deduplicated by orderId
 *   2. no trace in the session -> asks the baker to trace first, calls nothing
 *   3. expired session -> asks to trace first (injectable clock, no 30-min wait)
 *   4. approve with nothing pending -> speaks that, writes nothing
 *   5. approve twice -> commits exactly once (order statuses + one idempotency
 *      record; a replayed approval returns the original result)
 *
 * Exits 0 only if every check passed.
 */

import {
  getSession,
  setSession,
  setSessionClock,
  SESSION_TTL_MS,
} from "./session-store.js";
import {
  expandTraceToActions,
  resolveDraftResponseFromTrace,
  resolveApprovePendingResponse,
} from "./route-command.js";
import { documentClient, TABLE_NAME, ensureTableExists } from "../db/client.js";
import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import type { TraceLotResult } from "@batchline/shared";
import type { PreviewResponseResult, OrderAction } from "../tools/preview-response.js";
import type { CommitResponseResult } from "../tools/commit-response.js";

// ---------------------------------------------------------------------------
// Tiny check harness (same style as the other manual test scripts)
// ---------------------------------------------------------------------------

let failures = 0;

function section(title: string): void {
  console.log();
  console.log(title);
  console.log("-".repeat(title.length));
}

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failures += 1;
    console.log(`✗ ${label}`);
    if (detail !== undefined) {
      console.log("  detail:", JSON.stringify(detail, null, 2));
    }
  }
}

// ---------------------------------------------------------------------------
// DynamoDB helpers (read/write the table directly — never trust a return value
// alone for "did it write?")
// ---------------------------------------------------------------------------

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

/** Count idempotency records whose PK is exactly the voice key for a preview. */
async function countIdempotencyRecords(previewId: string): Promise<number> {
  let count = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;
  do {
    const page: ScanCommandOutput = await documentClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `IDEMPOTENCY#voice-${previewId}` },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    count += (page.Items ?? []).length;
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return count;
}

async function readIdempotencyRecord(previewId: string): Promise<Record<string, unknown> | undefined> {
  const result = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `IDEMPOTENCY#voice-${previewId}`, SK: "METADATA" },
    })
  );
  return result.Item;
}

// ---------------------------------------------------------------------------

const FULL_POLICY = {
  uncollected: "hold",
  collected: "notify",
  incomplete: "flag",
} as const;

async function run(): Promise<void> {
  console.log("=== voice session-flow test (deterministic, no Groq) ===");

  await ensureTableExists();

  const runId = Date.now();
  const orderHold = `ORDER-VOICE-HOLD-${runId}`; // uncollected
  const orderNotify = `ORDER-VOICE-NOTIFY-${runId}`; // collected
  const orderFlag = `ORDER-VOICE-FLAG-${runId}`; // incomplete
  const orderDup = `ORDER-VOICE-DUP-${runId}`; // uncollected, linked to TWO batches

  // The seeded-data hazard this exists for: one order linked to two batches
  // shows up twice in a trace, and preview_response rejects duplicate orderIds.
  const trace: TraceLotResult = {
    lotId: `LOT-VOICE-TEST-${runId}`,
    batches: [
      {
        batchId: `BATCH-VOICE-A-${runId}`,
        product: "Sourdough Boule",
        orders: [
          { orderId: orderHold, collectionStatus: "uncollected" },
          { orderId: orderDup, collectionStatus: "uncollected" },
          { orderId: orderNotify, collectionStatus: "collected" },
        ],
      },
      {
        batchId: `BATCH-VOICE-B-${runId}`,
        product: "Butter Croissant",
        orders: [
          { orderId: orderDup, collectionStatus: "uncollected" }, // again
          { orderId: orderFlag, collectionStatus: "incomplete" },
        ],
      },
    ],
    summary: { collected: 1, uncollected: 3, incomplete: 1 },
  };

  console.log();
  console.log("Setup: seeding four orders");
  console.log("  ", orderHold, "(uncollected)");
  console.log("  ", orderNotify, "(collected)");
  console.log("  ", orderFlag, "(incomplete)");
  console.log("  ", orderDup, "(uncollected, in two batches — the duplicate case)");
  console.log("  trace lot:", trace.lotId);

  await seedOrder(orderHold, "Acme Foods", "uncollected");
  await seedOrder(orderNotify, "Globex Cafe", "collected");
  await seedOrder(orderFlag, "Initech Catering", "incomplete");
  await seedOrder(orderDup, "Umbrella Bakery", "uncollected");

  // ---------------------------------------------------------------------------
  section("Test 1: stored trace expands the policy correctly, deduplicated");
  // ---------------------------------------------------------------------------

  const sessionDraft = `session-draft-${runId}`;
  setSession(sessionDraft, { lastTrace: { trace, tracedAt: Date.now() } });

  // The pure expansion, checked on its own first.
  const expanded = expandTraceToActions(trace, FULL_POLICY);
  check(
    "expandTraceToActions yields 4 actions (duplicate order counted once)",
    expanded.length === 4,
    expanded
  );
  check(
    "duplicate order appears exactly once in the expansion",
    expanded.filter((a) => a.orderId === orderDup).length === 1,
    expanded
  );

  const draft = await resolveDraftResponseFromTrace(FULL_POLICY, sessionDraft);
  const stored = getSession(sessionDraft);
  const pending = stored?.pendingPreview;

  check("draft stored a pending preview in the session", pending !== undefined, stored);
  check(
    "previewId is present on the pending preview",
    typeof pending?.preview.previewId === "string" && pending.preview.previewId.length > 0,
    pending?.preview
  );
  check(
    "pending preview was built from the exact expanded orderActions",
    JSON.stringify(pending?.orderActions ?? []) === JSON.stringify(expanded),
    { stored: pending?.orderActions, expanded }
  );
  check(
    "the reply says nothing has been changed yet",
    /nothing has been changed yet/i.test(draft.spoken),
    draft.spoken
  );

  const expectedActions = new Map<string, string>([
    [orderHold, "hold"],
    [orderDup, "hold"],
    [orderNotify, "notify"],
    [orderFlag, "flag"],
  ]);
  const actualActions = new Map(
    (pending?.orderActions ?? []).map((a: OrderAction) => [a.orderId, a.action])
  );
  check(
    "each order got the action matching its collection bucket",
    actualActions.size === expectedActions.size &&
      [...expectedActions].every(([id, action]) => actualActions.get(id) === action),
    { expected: [...expectedActions], actual: [...actualActions] }
  );

  // The preview is read-only: no order may have moved yet.
  const statusesAfterDraft = await Promise.all(
    [orderHold, orderNotify, orderFlag, orderDup].map(async (id) => (await readOrder(id))?.status)
  );
  check(
    "preview wrote nothing — every order still 'fulfilled'",
    statusesAfterDraft.every((s) => s === "fulfilled"),
    statusesAfterDraft
  );

  // ---------------------------------------------------------------------------
  section("Test 1b: buckets the baker did not mention are skipped");
  // ---------------------------------------------------------------------------

  const sessionPartial = `session-partial-${runId}`;
  setSession(sessionPartial, { lastTrace: { trace, tracedAt: Date.now() } });

  const partial = await resolveDraftResponseFromTrace(
    { uncollected: "hold" },
    sessionPartial
  );
  const partialActions = getSession(sessionPartial)?.pendingPreview?.orderActions ?? [];

  check(
    "only uncollected orders were drafted (2 of 4)",
    partialActions.length === 2,
    partialActions
  );
  check(
    "collected and incomplete buckets produced no actions",
    partialActions.every((a) => a.action === "hold") &&
      !partialActions.some((a) => [orderNotify, orderFlag].includes(a.orderId)),
    partialActions
  );
  check(
    "draft reply still reports nothing changed",
    /nothing has been changed yet/i.test(partial.spoken),
    partial.spoken
  );

  // ---------------------------------------------------------------------------
  section("Test 2: no trace in the session -> asks to trace first, calls nothing");
  // ---------------------------------------------------------------------------

  const sessionNoTrace = `session-no-trace-${runId}`;
  const noTrace = await resolveDraftResponseFromTrace(FULL_POLICY, sessionNoTrace);

  check(
    "reply asks the baker to trace a lot first",
    /trace a lot first/i.test(noTrace.spoken),
    noTrace.spoken
  );
  check(
    "nothing was called: no session entry, no pending preview",
    getSession(sessionNoTrace) === undefined &&
      (noTrace.parsed as { traced?: boolean }).traced === false,
    noTrace.parsed
  );

  // ---------------------------------------------------------------------------
  section("Test 3: expired session -> asks to trace first (injectable clock)");
  // ---------------------------------------------------------------------------

  const sessionExpired = `session-expired-${runId}`;
  let fakeNow = Date.now();
  const restoreClock = setSessionClock(() => fakeNow);

  setSession(sessionExpired, { lastTrace: { trace, tracedAt: fakeNow } });
  const beforeExpiry = getSession(sessionExpired);
  check(
    "trace readable before the TTL elapses",
    beforeExpiry?.lastTrace?.trace.lotId === trace.lotId,
    beforeExpiry
  );

  // Jump past the 30-minute TTL — no waiting in the test.
  fakeNow += SESSION_TTL_MS + 1000;

  const expired = await resolveDraftResponseFromTrace(FULL_POLICY, sessionExpired);
  check(
    "expired session replies asking to trace first",
    /trace a lot first/i.test(expired.spoken),
    expired.spoken
  );
  check(
    "expired session reads as absent (and is dropped on read)",
    getSession(sessionExpired) === undefined
  );
  restoreClock();

  // ---------------------------------------------------------------------------
  section("Test 4: approve with nothing pending speaks that and writes nothing");
  // ---------------------------------------------------------------------------

  const sessionNothing = `session-nothing-pending-${runId}`;
  const nothingPending = await resolveApprovePendingResponse(sessionNothing);
  const statelessApprove = await resolveApprovePendingResponse();

  check(
    "reply says there is no draft waiting for approval",
    /no draft response waiting/i.test(nothingPending.spoken),
    nothingPending.spoken
  );
  check(
    "stateless call (no sessionId) behaves the same",
    /no draft response waiting/i.test(statelessApprove.spoken),
    statelessApprove.spoken
  );

  const statusesBeforeApprove = await Promise.all(
    [orderHold, orderNotify, orderFlag, orderDup].map(async (id) => (await readOrder(id))?.status)
  );
  check(
    "no order statuses changed",
    statusesBeforeApprove.every((s) => s === "fulfilled"),
    statusesBeforeApprove
  );

  // ---------------------------------------------------------------------------
  section("Test 5: approve twice commits exactly once");
  // ---------------------------------------------------------------------------

  const sessionApprove = `session-approve-${runId}`;
  setSession(sessionApprove, { lastTrace: { trace, tracedAt: Date.now() } });
  await resolveDraftResponseFromTrace(FULL_POLICY, sessionApprove);

  const pendingBeforeApprove = getSession(sessionApprove)?.pendingPreview;
  if (!pendingBeforeApprove) {
    check("setup: a pending preview exists to approve", false);
    finish();
    return;
  }

  const firstApprove = await resolveApprovePendingResponse(sessionApprove);
  const firstResult = firstApprove.parsed as CommitResponseResult;
  const previewId = firstResult.previewId;

  check(
    "first approve committed all 4 actions",
    Array.isArray(firstResult.committed) && firstResult.committed.length === 4,
    firstResult
  );
  check(
    "idempotencyKey is the server-built voice-<previewId> key",
    (await readIdempotencyRecord(previewId))?.idempotencyKey === `voice-${previewId}`,
    await readIdempotencyRecord(previewId)
  );
  check(
    "pending preview cleared after a successful commit",
    getSession(sessionApprove)?.pendingPreview === undefined,
    getSession(sessionApprove)
  );

  const statusesAfterFirst = {
    hold: (await readOrder(orderHold))?.status,
    notify: (await readOrder(orderNotify))?.status,
    flag: (await readOrder(orderFlag))?.status,
    dup: (await readOrder(orderDup))?.status,
  };
  check(
    "order statuses changed in DynamoDB (hold/notify/flag, dup held once)",
    statusesAfterFirst.hold === "on_hold" &&
      statusesAfterFirst.dup === "on_hold" &&
      statusesAfterFirst.notify === "notified" &&
      statusesAfterFirst.flag === "flagged_incomplete",
    statusesAfterFirst
  );

  let idempotencyCount = await countIdempotencyRecords(previewId);
  check("exactly one idempotency record exists after the commit", idempotencyCount === 1, idempotencyCount);

  // Second approve: the pending preview is gone, so nothing can be committed.
  const secondApprove = await resolveApprovePendingResponse(sessionApprove);
  check(
    "second approve reports nothing pending",
    /no draft response waiting/i.test(secondApprove.spoken),
    secondApprove.spoken
  );

  const statusesAfterSecond = {
    hold: (await readOrder(orderHold))?.status,
    notify: (await readOrder(orderNotify))?.status,
    flag: (await readOrder(orderFlag))?.status,
    dup: (await readOrder(orderDup))?.status,
  };
  check(
    "statuses unchanged by the second approve",
    JSON.stringify(statusesAfterSecond) === JSON.stringify(statusesAfterFirst),
    { statusesAfterFirst, statusesAfterSecond }
  );
  idempotencyCount = await countIdempotencyRecords(previewId);
  check(
    "still exactly one idempotency record",
    idempotencyCount === 1,
    idempotencyCount
  );

  // A retried approval of the SAME draft (pending put back, as a client retry
  // would see it) must replay the original commit instead of writing again.
  setSession(sessionApprove, { pendingPreview: pendingBeforeApprove });
  const replayApprove = await resolveApprovePendingResponse(sessionApprove);
  const replayResult = replayApprove.parsed as CommitResponseResult;

  check(
    "replayed approval returns the original committedAt (no second commit)",
    replayResult.committedAt === firstResult.committedAt,
    { first: firstResult.committedAt, replay: replayResult.committedAt }
  );
  const statusesAfterReplay = {
    hold: (await readOrder(orderHold))?.status,
    notify: (await readOrder(orderNotify))?.status,
    flag: (await readOrder(orderFlag))?.status,
    dup: (await readOrder(orderDup))?.status,
  };
  check(
    "statuses unchanged by the replay",
    JSON.stringify(statusesAfterReplay) === JSON.stringify(statusesAfterFirst),
    { statusesAfterFirst, statusesAfterReplay }
  );
  idempotencyCount = await countIdempotencyRecords(previewId);
  check(
    "still exactly one idempotency record after the replay",
    idempotencyCount === 1,
    idempotencyCount
  );

  // ---------------------------------------------------------------------------
  finish();
}

function finish(): void {
  console.log();
  if (failures > 0) {
    console.log(`=== FAILED: ${failures} check(s) did not pass ===`);
    process.exit(1);
  }
  console.log("=== All session-flow checks passed ===");
  process.exit(0);
}

run().catch((error) => {
  console.error("session-flow test crashed:", error);
  process.exit(1);
});
