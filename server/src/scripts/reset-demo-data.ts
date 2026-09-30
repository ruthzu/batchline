/**
 * reset-demo-data.ts — wipe the DynamoDB table completely and re-seed a clean,
 * realistic demo dataset for the dashboard.
 *
 *   DANGEROUS: this deletes EVERY item in the table, including anything
 *   created by the MCP tools or the other seed scripts. It refuses to run
 *   unless the target is provably DynamoDB Local:
 *
 *     1. DYNAMODB_LOCAL must be exactly "true" — the same local-only switch
 *        dashboard/lib/db.ts branches on. (server/src/db/client.ts itself
 *        never checks env, so this script enforces the gate client.ts lacks.)
 *     2. AWS_ENV, if set, must be "local" — anything else refuses, so a
 *        stray AWS_ENV=production can never combine with a sloppy
 *        DYNAMODB_LOCAL=true to point this script at real AWS.
 *     3. The resolved endpoint must be localhost/127.0.0.1/[::1] — even with
 *        every env var agreeing, a DYNAMODB_ENDPOINT pointing off-loopback
 *        (e.g. at a real AWS endpoint URL) aborts before any scan runs.
 *
 * The gate sits at the top of the module and exits before any database call
 * is possible, so the script is structurally incapable of wiping a real AWS
 * table — not just "probably fine because you'd only run it locally".
 *
 * What it does:
 *   1. Scans the whole table (paginated via LastEvaluatedKey) and deletes
 *      every item in 25-item BatchWriteCommand chunks (the hard DynamoDB
 *      cap), retrying UnprocessedItems, printing a running count, then
 *      re-scans to prove the table is empty before seeding.
 *   2. Seeds the same demo dataset as dashboard/scripts/seed-orders.ts +
 *      seed-batches.ts — identical item shapes and IDs. (Those scripts
 *      self-execute on import, so their data is mirrored here rather than
 *      imported): 3 batches, 5 lots — LOT-FLR-2026-0117 deliberately shared
 *      by two batches so a trace shows the multi-batch case — and 10 orders
 *      with a deliberate collectionStatus mix. ORDER-2026-0006 has the
 *      collectionStatus attribute genuinely ABSENT (not the string
 *      "incomplete") to exercise the dashboard's "Missing" render and
 *      trace's "incomplete" summary. Statuses lean fulfilled-heavy with a
 *      couple already on_hold/notified so the board looks mid-recall.
 *   3. Re-scans and prints per-entityType counts as a seed confirmation.
 *
 * Run with (from server/, or `npm run reset:demo -w server` from the root):
 *   DYNAMODB_LOCAL=true npm run reset:demo
 *
 * Safe to re-run: the wipe guarantees the seed never collides with stale
 * items (the plain seed scripts only overwrite keys they know about).
 */

import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type {
  BatchWriteCommandInput,
  ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { documentClient, TABLE_NAME, ensureTableExists } from "../db/client.js";

// ---------------------------------------------------------------------------
// Safety gate — runs before any database call is possible.
// ---------------------------------------------------------------------------

const DYNAMODB_LOCAL = process.env.DYNAMODB_LOCAL;
const AWS_ENV = process.env.AWS_ENV;
const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";

const describe = (value: string | undefined) =>
  value === undefined ? "(unset)" : JSON.stringify(value);

function refuse(reason: string): never {
  console.error("");
  console.error("=====================================================================");
  console.error("  REFUSING TO RUN");
  console.error("");
  console.error("  reset-demo-data deletes EVERY item in the table, and this");
  console.error("  environment does not prove the target is DynamoDB Local.");
  console.error("");
  console.error(`  Reason: ${reason}`);
  console.error("");
  console.error("  To run it for real (from server/):");
  console.error("    DYNAMODB_LOCAL=true npm run reset:demo");
  console.error("=====================================================================");
  console.error("");
  process.exit(1);
}

if (DYNAMODB_LOCAL !== "true") {
  refuse(
    `DYNAMODB_LOCAL must be exactly "true" (got ${describe(DYNAMODB_LOCAL)})`,
  );
}
if (AWS_ENV !== undefined && AWS_ENV !== "local") {
  refuse(`AWS_ENV is ${describe(AWS_ENV)} — only "local" is allowed`);
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(ENDPOINT)) {
  refuse(
    `DYNAMODB_ENDPOINT (${ENDPOINT}) does not point at localhost — refusing to wipe a non-local database`,
  );
}

console.log(
  `Safety gate passed: DYNAMODB_LOCAL="true", AWS_ENV=${describe(AWS_ENV)}, endpoint=${ENDPOINT}`,
);

// ---------------------------------------------------------------------------
// Batched writes — DynamoDB caps BatchWriteCommand at 25 requests per call,
// and may return some writes as UnprocessedItems (throttling); retry those
// with exponential backoff instead of dropping them on the floor.
// ---------------------------------------------------------------------------

type WriteRequests = NonNullable<BatchWriteCommandInput["RequestItems"]>[string];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function flushWriteRequests(requests: WriteRequests): Promise<void> {
  const maxAttempts = 6;
  let pending = requests;

  for (let attempt = 0; attempt < maxAttempts && pending.length > 0; attempt++) {
    if (attempt > 0) {
      await sleep(100 * 2 ** (attempt - 1));
    }
    const output = await documentClient.send(
      new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: pending } }),
    );
    pending = (output.UnprocessedItems?.[TABLE_NAME] ?? []) as WriteRequests;
  }

  if (pending.length > 0) {
    throw new Error(
      `BatchWriteCommand left ${pending.length} item(s) unprocessed after ${maxAttempts} attempts`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — wipe: paginated Scan + chunked deletes.
// ---------------------------------------------------------------------------

async function wipeTable(): Promise<number> {
  let totalDeleted = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;

  do {
    const page: ScanCommandOutput = await documentClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    lastEvaluatedKey = page.LastEvaluatedKey;

    const items = page.Items ?? [];
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      await flushWriteRequests(
        chunk.map((item) => ({
          DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
        })),
      );
      totalDeleted += chunk.length;
      console.log(`  deleted ${totalDeleted} item(s)…`);
    }
  } while (lastEvaluatedKey);

  return totalDeleted;
}

/** Prove the wipe worked before seeding on top of anything. */
async function assertTableEmpty(): Promise<void> {
  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;

  do {
    const page: ScanCommandOutput = await documentClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    lastEvaluatedKey = page.LastEvaluatedKey;
    if ((page.Items?.length ?? 0) > 0) {
      throw new Error(
        `Expected an empty table but Scan returned ${page.Items?.length} item(s) — refusing to seed on top of leftover data`,
      );
    }
  } while (lastEvaluatedKey);
}

// ---------------------------------------------------------------------------
// Phase 2 — seed: the demo dataset, mirroring dashboard/scripts/seed-orders.ts
// and seed-batches.ts item-for-item (same IDs, same attribute shapes).
// ---------------------------------------------------------------------------

type DemoOrder = {
  orderId: string;
  customerName: string;
  customerContact: string;
  status: "fulfilled" | "on_hold" | "notified" | "flagged_incomplete";
  collectionStatus?: "collected" | "uncollected" | "incomplete";
};

type DemoLot = {
  lotId: string;
  ingredientName: string;
  supplier: string;
  receivedDate: string;
  quantityUsed: number;
};

type DemoBatch = {
  batchId: string;
  product: string;
  producedDate: string;
  batchSize: number;
  lots: DemoLot[];
  orders: { orderId: string; quantityAllocated: number }[];
};

// 10 orders: 6 fulfilled (one with collectionStatus stripped), 2 notified,
// 1 on_hold, 1 flagged_incomplete; collected/uncollected/incomplete/missing.
const DEMO_ORDERS: DemoOrder[] = [
  {
    orderId: "ORDER-2026-0001",
    customerName: "Acme Foods",
    customerContact: "orders@acme.example",
    status: "fulfilled",
    collectionStatus: "collected",
  },
  {
    orderId: "ORDER-2026-0002",
    customerName: "Globex Cafe",
    customerContact: "hello@globex.example",
    status: "fulfilled",
    collectionStatus: "uncollected",
  },
  {
    orderId: "ORDER-2026-0003",
    customerName: "Initech Supply Co.",
    customerContact: "procurement@initech.example",
    status: "fulfilled",
    collectionStatus: "collected",
  },
  {
    orderId: "ORDER-2026-0004",
    customerName: "Umbrella Bakery",
    customerContact: "supply@umbrella.example",
    status: "fulfilled",
    collectionStatus: "uncollected",
  },
  {
    orderId: "ORDER-2026-0005",
    customerName: "Stark Industries",
    customerContact: "despatch@stark.example",
    status: "fulfilled",
    collectionStatus: "uncollected",
  },
  // Genuinely stripped record: NO collectionStatus attribute at all — not a
  // hardcoded "incomplete". The dashboard renders it as "Missing";
  // trace_ingredient_lot reports it as "incomplete".
  {
    orderId: "ORDER-2026-0006",
    customerName: "Wayne Enterprises",
    customerContact: "logistics@wayne.example",
    status: "fulfilled",
  },
  {
    orderId: "ORDER-2026-0007",
    customerName: "Oscorp Industries",
    customerContact: "orders@oscorp.example",
    status: "on_hold",
    collectionStatus: "uncollected",
  },
  {
    orderId: "ORDER-2026-0008",
    customerName: "Massive Dynamic",
    customerContact: "purchasing@massive.example",
    status: "notified",
    collectionStatus: "uncollected",
  },
  {
    orderId: "ORDER-2026-0009",
    customerName: "Hooli",
    customerContact: "supply-chain@hooli.example",
    status: "notified",
    collectionStatus: "collected",
  },
  {
    orderId: "ORDER-2026-0010",
    customerName: "Tyrell Corp",
    customerContact: "procurement@tyrell.example",
    status: "flagged_incomplete",
    collectionStatus: "incomplete",
  },
];

// 3 batches; LOT-FLR-2026-0117 is deliberately shared by the first two so a
// trace of that lot returns multiple batches (the multi-batch trace case).
const DEMO_BATCHES: DemoBatch[] = [
  {
    batchId: "BATCH-2026-03-14-001",
    product: "Sourdough Boule",
    producedDate: "2026-03-14T06:00:00.000Z",
    batchSize: 120,
    lots: [
      {
        lotId: "LOT-FLR-2026-0117",
        ingredientName: "Organic Plain Flour",
        supplier: "Hearthstone Mills",
        receivedDate: "2026-03-10T09:00:00.000Z",
        quantityUsed: 45,
      },
    ],
    orders: [
      { orderId: "ORDER-2026-0001", quantityAllocated: 40 }, // Acme — collected
      { orderId: "ORDER-2026-0008", quantityAllocated: 35 }, // Massive Dynamic — notified
      { orderId: "ORDER-2026-0002", quantityAllocated: 25 }, // Globex — uncollected
      { orderId: "ORDER-2026-0005", quantityAllocated: 20 }, // Stark — uncollected
    ],
  },
  {
    batchId: "BATCH-2026-03-21-002",
    product: "Butter Croissant",
    producedDate: "2026-03-21T06:00:00.000Z",
    batchSize: 240,
    lots: [
      {
        // Same lot as BATCH-2026-03-14-001 — the shared-lot trace case.
        lotId: "LOT-FLR-2026-0117",
        ingredientName: "Organic Plain Flour",
        supplier: "Hearthstone Mills",
        receivedDate: "2026-03-10T09:00:00.000Z",
        quantityUsed: 80,
      },
      {
        lotId: "LOT-BTR-2026-0042",
        ingredientName: "Cultured Butter",
        supplier: "Meadow Dairy",
        receivedDate: "2026-03-18T08:00:00.000Z",
        quantityUsed: 55,
      },
      {
        lotId: "LOT-YST-2026-0009",
        ingredientName: "Instant Yeast",
        supplier: "FermentCo",
        receivedDate: "2026-02-25T10:30:00.000Z",
        quantityUsed: 5,
      },
    ],
    orders: [{ orderId: "ORDER-2026-0002", quantityAllocated: 60 }], // Globex
  },
  {
    batchId: "BATCH-2026-03-28-003",
    product: "Protein Bar",
    producedDate: "2026-03-28T06:00:00.000Z",
    batchSize: 500,
    lots: [
      {
        lotId: "LOT-OAT-2026-0203",
        ingredientName: "Rolled Oats",
        supplier: "Prairie Grain",
        receivedDate: "2026-03-20T07:00:00.000Z",
        quantityUsed: 120,
      },
      {
        lotId: "LOT-WPC-2026-0011",
        ingredientName: "Whey Protein Concentrate",
        supplier: "NutriSource",
        receivedDate: "2026-03-15T12:00:00.000Z",
        quantityUsed: 45,
      },
    ],
    orders: [], // fresh production run, nothing shipped yet
  },
];

/** Assemble the exact single-table items written by the two seed scripts. */
function buildSeedItems(): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];

  for (const order of DEMO_ORDERS) {
    const item: Record<string, unknown> = {
      PK: `ORDER#${order.orderId}`,
      SK: "METADATA",
      orderId: order.orderId,
      customerName: order.customerName,
      customerContact: order.customerContact,
      status: order.status,
      entityType: "ORDER",
    };
    // Only set collectionStatus when it actually exists — ORDER-2026-0006
    // keeps the attribute genuinely absent. (The document client's
    // removeUndefinedValues would also strip an explicit undefined, but
    // omitting the key is the honest shape.)
    if (order.collectionStatus !== undefined) {
      item.collectionStatus = order.collectionStatus;
    }
    items.push(item);
  }

  const seenLots = new Set<string>();
  for (const batch of DEMO_BATCHES) {
    items.push({
      PK: `BATCH#${batch.batchId}`,
      SK: "METADATA",
      batchId: batch.batchId,
      product: batch.product,
      producedDate: batch.producedDate,
      batchSize: batch.batchSize,
      entityType: "BATCH",
    });

    for (const lot of batch.lots) {
      // Lot→batch link: lot is the partition, SK names the batch
      // (record-batch.ts shape, with GSI1 for the batch-side query).
      items.push({
        PK: `LOT#${lot.lotId}`,
        SK: `BATCH#${batch.batchId}`,
        lotId: lot.lotId,
        quantityUsed: lot.quantityUsed,
        batchId: batch.batchId,
        entityType: "LOT_BATCH_LINK",
        GSI1PK: `LOT#${lot.lotId}`,
        GSI1SK: `BATCH#${batch.batchId}`,
      });

      // Lot metadata: a shared lot is written once, not once per batch.
      if (!seenLots.has(lot.lotId)) {
        seenLots.add(lot.lotId);
        items.push({
          PK: `LOT#${lot.lotId}`,
          SK: "METADATA",
          lotId: lot.lotId,
          ingredientName: lot.ingredientName,
          supplier: lot.supplier,
          receivedDate: lot.receivedDate,
          quantity: 500,
          entityType: "LOT",
        });
      }
    }

    for (const { orderId, quantityAllocated } of batch.orders) {
      items.push({
        PK: `BATCH#${batch.batchId}`,
        SK: `ORDER#${orderId}`,
        batchId: batch.batchId,
        orderId,
        quantityAllocated,
        entityType: "BATCH_ORDER_LINK",
      });
    }
  }

  return items;
}

async function seedDemoData(): Promise<Record<string, unknown>[]> {
  const items = buildSeedItems();

  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await flushWriteRequests(
      chunk.map((item) => ({ PutRequest: { Item: item } })),
    );
    for (const item of chunk) {
      console.log(`  ✓ ${item.PK} / ${item.SK}`);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Phase 3 — verify: re-scan everything and confirm exactly what was seeded.
// ---------------------------------------------------------------------------

async function verifySeed(expectedTotal: number): Promise<void> {
  const counts = new Map<string, number>();
  let total = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;

  do {
    const page: ScanCommandOutput = await documentClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    lastEvaluatedKey = page.LastEvaluatedKey;

    for (const item of page.Items ?? []) {
      const entityType = String(item.entityType ?? "(no entityType)");
      counts.set(entityType, (counts.get(entityType) ?? 0) + 1);
      total += 1;
    }
  } while (lastEvaluatedKey);

  for (const [entityType, count] of [...counts.entries()].sort()) {
    console.log(`  ${entityType}: ${count}`);
  }
  console.log(`  TOTAL: ${total} (expected ${expectedTotal})`);

  if (total !== expectedTotal) {
    throw new Error(
      `Seed verification failed: table has ${total} item(s), expected ${expectedTotal}`,
    );
  }
}

// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log("Resetting demo data (DynamoDB Local)");
  console.log(`  Table:    ${TABLE_NAME}`);
  console.log();

  console.log("[1/3] Wiping table…");
  await ensureTableExists();
  const deleted = await wipeTable();
  await assertTableEmpty();
  console.log(`Deleted ${deleted} item(s) — table is now empty.`);
  console.log();

  console.log("[2/3] Seeding demo data…");
  const seeded = await seedDemoData();
  console.log(`Seeded ${seeded.length} item(s).`);
  console.log();

  console.log("[3/3] Verifying seeded table…");
  await verifySeed(seeded.length);
  console.log();
  console.log("✓ Reset complete. The dashboard should now show:");
  console.log(
    "    /orders  → 10 orders (6 fulfilled, 1 on_hold, 2 notified, 1 flagged_incomplete)",
  );
  console.log("    /batches → 3 batches (LOT-FLR-2026-0117 shared by two of them)");
  console.log("    /trace?lotId=LOT-FLR-2026-0117 → the multi-batch trace case");
}

run().catch((error) => {
  console.error("reset-demo-data failed:", error);
  process.exit(1);
});
