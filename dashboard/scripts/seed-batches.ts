/**
 * One-off dev utility: seed extra batch production runs so the /batches board
 * has realistic, varying data. Complements dashboard/scripts/seed-orders.ts
 * (which seeds the orders and the first batch, BATCH-2026-03-14-001); safe to
 * re-run — every write is a plain Put with deterministic keys, so re-running
 * overwrites identical items and never duplicates.
 *
 * Run with:
 *   DYNAMODB_LOCAL=true npx tsx dashboard/scripts/seed-batches.ts
 *
 * This is NOT part of the app — it's a manual dev helper. It writes items
 * directly using the same single-table shapes the server tools use (see
 * database.md and record-batch.ts for the canonical attribute names).
 *
 * Item shapes written here (mirroring record-batch.ts):
 *   Batch METADATA:     PK: BATCH#<batchId>  SK: METADATA  entityType "BATCH"
 *   Lot→batch link:     PK: LOT#<lotId>      SK: BATCH#<batchId>
 *                       entityType "LOT_BATCH_LINK", GSI1PK/GSI1SK lot-keyed
 *   Placeholder LOT:    PK: LOT#<lotId>      SK: METADATA  entityType "LOT"
 *   Batch→order link:   PK: BATCH#<batchId>  SK: ORDER#<orderId>
 *                       entityType "BATCH_ORDER_LINK"
 *
 * After running, the batch board shows three batches:
 *   BATCH-2026-03-14-001 (from seed-orders.ts) — 1 lot,  4 orders
 *   BATCH-2026-03-21-002                    — 3 lots,  1 order
 *   BATCH-2026-03-28-003                    — 2 lots,  0 orders
 * LOT-FLR-2026-0117 is deliberately shared between two batches so a trace of
 * that lot shows multiple batches — the multi-batch case trace_ingredient_lot
 * exists for.
 */

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient, TABLE_NAME } from "../lib/db";

// ---------------------------------------------------------------------------
// Batches: ids/timestamps are deterministic so re-runs overwrite in place.
// ---------------------------------------------------------------------------
const BATCH_1_ID = "BATCH-2026-03-21-002"; // shared flour lot with seed-orders' batch
const BATCH_2_ID = "BATCH-2026-03-28-003"; // no orders yet — fresh production run

// ---------------------------------------------------------------------------
// Batch 1 — Croissant Batch, 3 ingredient lots, 1 order so far.
// ---------------------------------------------------------------------------
const BATCH_1 = {
  metadata: {
    PK: `BATCH#${BATCH_1_ID}`,
    SK: "METADATA",
    batchId: BATCH_1_ID,
    product: "Butter Croissant",
    producedDate: "2026-03-21T06:00:00.000Z",
    batchSize: 240,
    entityType: "BATCH",
  },
  lots: [
    {
      lotId: "LOT-FLR-2026-0117", // deliberately shared with BATCH-2026-03-14-001
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
  orders: [{ orderId: "ORDER-2026-0002", quantityAllocated: 60 }], // Globex Cafe
};

// ---------------------------------------------------------------------------
// Batch 2 — Protein Bar Batch, 2 ingredient lots, no orders linked yet.
// ---------------------------------------------------------------------------
const BATCH_2 = {
  metadata: {
    PK: `BATCH#${BATCH_2_ID}`,
    SK: "METADATA",
    batchId: BATCH_2_ID,
    product: "Protein Bar",
    producedDate: "2026-03-28T06:00:00.000Z",
    batchSize: 500,
    entityType: "BATCH",
  },
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
  orders: [],
};

interface BatchSeed {
  metadata: Record<string, unknown>;
  lots: {
    lotId: string;
    ingredientName: string;
    supplier: string;
    receivedDate: string;
    quantityUsed: number;
  }[];
  orders: { orderId: string; quantityAllocated: number }[];
}

const BATCHES: BatchSeed[] = [BATCH_1, BATCH_2];

// ---------------------------------------------------------------------------
// Item assembly — exact shapes written by record-batch.ts / seed-orders.ts.
// ---------------------------------------------------------------------------
function buildItems(batch: BatchSeed): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [batch.metadata];

  for (const lot of batch.lots) {
    // Lot→batch link: lot is the partition, SK names the batch (record-batch.ts).
    items.push({
      PK: `LOT#${lot.lotId}`,
      SK: `BATCH#${batch.metadata.batchId}`,
      lotId: lot.lotId,
      quantityUsed: lot.quantityUsed,
      batchId: batch.metadata.batchId,
      entityType: "LOT_BATCH_LINK",
      // GSI1 for querying which batches used this lot
      GSI1PK: `LOT#${lot.lotId}`,
      GSI1SK: `BATCH#${batch.metadata.batchId}`,
    });

    // Placeholder lot metadata (record-batch.ts creates these on demand; we
    // seed realistic values so /trace shows real ingredient names). The link
    // above already carries the batchId, so the key is deterministic and
    // re-runs simply overwrite.
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

  for (const { orderId, quantityAllocated } of batch.orders) {
    // Batch→order link: batch is the partition, SK names the order (same
    // shape as seed-orders.ts / trace-lot.test.ts).
    items.push({
      PK: `BATCH#${batch.metadata.batchId}`,
      SK: `ORDER#${orderId}`,
      batchId: batch.metadata.batchId,
      orderId,
      quantityAllocated,
      entityType: "BATCH_ORDER_LINK",
    });
  }

  return items;
}

async function run() {
  console.log("Seeding batches into DynamoDB Local…");
  console.log(`Table: ${TABLE_NAME}`);

  for (const batch of BATCHES) {
    const items = buildItems(batch);
    console.log(
      `\n${batch.metadata.batchId} — ${batch.metadata.product} ` +
        `(${batch.lots.length} lot${batch.lots.length !== 1 ? "s" : ""}, ` +
        `${batch.orders.length} order${batch.orders.length !== 1 ? "s" : ""})`,
    );

    for (const item of items) {
      await documentClient.send(
        new PutCommand({ TableName: TABLE_NAME, Item: item }),
      );
      console.log(`  ✓ ${item.PK} / ${item.SK}`);
    }
  }

  console.log();
  console.log("Done. Batches seeded:");
  console.log("  BATCH-2026-03-14-001  (from seed-orders.ts) — 1 lot, 4 orders");
  console.log(`  ${BATCH_1_ID} — 3 lots, 1 order`);
  console.log(`  ${BATCH_2_ID} — 2 lots, 0 orders`);
  console.log();
  console.log("Start the dashboard with:");
  console.log("  npm run dev --workspace=dashboard");
  console.log("Then visit http://localhost:3000/batches");
}

run().catch((error) => {
  console.error("Seed script failed:", error);
  process.exit(1);
});
