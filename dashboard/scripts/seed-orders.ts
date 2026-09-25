/**
 * One-off dev utility: seed a handful of realistic order METADATA items into
 * DynamoDB Local so the /orders board has something to display, plus one
 * lot/batch graph so /trace can resolve a seed lotId end-to-end.
 *
 * Run with:
 *   DYNAMODB_LOCAL=true npx tsx dashboard/scripts/seed-orders.ts
 *
 * This is NOT part of the app — it's a manual dev helper. It writes items
 * directly using the same single-table shapes the server tools use (see
 * database.md and server/src/tools/trace-lot.test.ts for the real attribute
 * names).
 *
 * Order item shape (PK=ORDER#<orderId>, SK=METADATA, entityType="ORDER"):
 *   orderId, customerName, customerContact, status, collectionStatus
 *
 * Statuses used here: fulfilled, on_hold, notified, flagged_incomplete
 * (the four statuses the order board visually distinguishes).
 *
 * Note: `collectionStatus` (collected/uncollected/incomplete) is the physical
 * pickup/receipt status read by trace_ingredient_lot, and is deliberately
 * independent of `status`, the recall-response workflow state — see
 * database.md ("collectionStatus vs status").
 */

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient, TABLE_NAME } from "../lib/db";

// ---------------------------------------------------------------------------
// Seeded orders (8) — collectionStatus is the physical pickup/receipt status,
// kept separate from the recall-response workflow `status`.
// ---------------------------------------------------------------------------
const ORDERS = [
  {
    orderId: "ORDER-2026-0001",
    customerName: "Acme Foods",
    customerContact: "orders@acme.example",
    status: "fulfilled",
    collectionStatus: "collected" as const,
  },
  {
    orderId: "ORDER-2026-0002",
    customerName: "Globex Cafe",
    customerContact: "hello@globex.example",
    status: "fulfilled",
    collectionStatus: "uncollected" as const,
  },
  {
    orderId: "ORDER-2026-0003",
    customerName: "Initech Supply Co.",
    customerContact: "procurement@initech.example",
    status: "on_hold",
    collectionStatus: "uncollected" as const,
  },
  {
    orderId: "ORDER-2026-0004",
    customerName: "Umbrella Bakery",
    customerContact: "supply@umbrella.example",
    status: "on_hold",
    collectionStatus: "uncollected" as const,
  },
  {
    orderId: "ORDER-2026-0005",
    customerName: "Stark Industries",
    customerContact: "despatch@stark.example",
    status: "notified",
    collectionStatus: "uncollected" as const,
  },
  {
    orderId: "ORDER-2026-0006",
    customerName: "Wayne Enterprises",
    customerContact: "logistics@wayne.example",
    status: "notified",
    collectionStatus: "uncollected" as const,
  },
  {
    orderId: "ORDER-2026-0007",
    customerName: "Oscorp Industries",
    customerContact: "orders@oscorp.example",
    status: "flagged_incomplete",
    collectionStatus: "incomplete" as const,
  },
  {
    orderId: "ORDER-2026-0008",
    customerName: "Massive Dynamic",
    customerContact: "purchasing@massive.example",
    status: "flagged_incomplete",
    collectionStatus: "incomplete" as const,
  },
];

// ---------------------------------------------------------------------------
// Seeded lot/batch graph — ties several of the orders above to one production
// run so tracing LOT-FLR-2026-0117 via trace_ingredient_lot returns the
// affected orders with their collectionStatus. Item shapes mirror
// record-batch.ts (LOT_BATCH_LINK, placeholder LOT METADATA, BATCH METADATA)
// and the BATCH_ORDER_LINK shape used in trace-lot.test.ts.
// ---------------------------------------------------------------------------
const SEED_LOT_ID = "LOT-FLR-2026-0117";
const SEED_BATCH_ID = "BATCH-2026-03-14-001";

const SEED_LOT_METADATA = {
  PK: `LOT#${SEED_LOT_ID}`,
  SK: "METADATA",
  lotId: SEED_LOT_ID,
  ingredientName: "Organic Plain Flour",
  supplier: "Hearthstone Mills",
  receivedDate: "2026-03-10T09:00:00.000Z",
  quantity: 500,
  entityType: "LOT",
};

const SEED_BATCH_METADATA = {
  PK: `BATCH#${SEED_BATCH_ID}`,
  SK: "METADATA",
  batchId: SEED_BATCH_ID,
  product: "Sourdough Boule",
  producedDate: "2026-03-14T06:00:00.000Z",
  batchSize: 120,
  entityType: "BATCH",
};

const SEED_LOT_BATCH_LINK = {
  PK: `LOT#${SEED_LOT_ID}`,
  SK: `BATCH#${SEED_BATCH_ID}`,
  lotId: SEED_LOT_ID,
  batchId: SEED_BATCH_ID,
  quantityUsed: 45,
  entityType: "LOT_BATCH_LINK",
  GSI1PK: `LOT#${SEED_LOT_ID}`,
  GSI1SK: `BATCH#${SEED_BATCH_ID}`,
};

// Orders that received product from this batch (BATCH#<batchId>/ORDER#<orderId>).
// Deliberately a mix of collectionStatuses: two already collected, one
// uncollected, one incomplete — so a trace shows a meaningful summary.
const SEED_BATCH_ORDER_LINKS = [
  { orderId: "ORDER-2026-0001", quantityAllocated: 40 }, // Acme Foods — collected
  { orderId: "ORDER-2026-0008", quantityAllocated: 35 }, // Massive Dynamic — incomplete
  { orderId: "ORDER-2026-0002", quantityAllocated: 25 }, // Globex Cafe — uncollected
  { orderId: "ORDER-2026-0005", quantityAllocated: 20 }, // Stark Industries — uncollected
];

const SEED_ITEMS = [
  SEED_LOT_METADATA,
  SEED_BATCH_METADATA,
  SEED_LOT_BATCH_LINK,
  ...SEED_BATCH_ORDER_LINKS.map(({ orderId, quantityAllocated }) => ({
    PK: `BATCH#${SEED_BATCH_ID}`,
    SK: `ORDER#${orderId}`,
    batchId: SEED_BATCH_ID,
    orderId,
    quantityAllocated,
    entityType: "BATCH_ORDER_LINK",
  })),
];

async function run() {
  console.log("Seeding orders into DynamoDB Local…");
  console.log(`Table: ${TABLE_NAME}`);
  console.log(`Orders to write: ${ORDERS.length}`);
  console.log(`Lot/batch graph items: ${SEED_ITEMS.length}`);
  console.log();

  for (const order of ORDERS) {
    await documentClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `ORDER#${order.orderId}`,
          SK: "METADATA",
          orderId: order.orderId,
          customerName: order.customerName,
          customerContact: order.customerContact,
          status: order.status,
          collectionStatus: order.collectionStatus,
          entityType: "ORDER",
        },
      })
    );
    console.log(`  ✓ ${order.orderId} — ${order.customerName} [${order.status}]`);
  }

  console.log();
  console.log(`Seeding lot/batch graph for ${SEED_LOT_ID} / ${SEED_BATCH_ID}…`);

  for (const item of SEED_ITEMS) {
    await documentClient.send(
      new PutCommand({ TableName: TABLE_NAME, Item: item })
    );
    console.log(`  ✓ ${item.PK} / ${item.SK}`);
  }

  console.log();
  console.log("Done. Start the dashboard with:");
  console.log("  npm run dev --workspace=dashboard");
  console.log("Then visit http://localhost:3000/orders");
  console.log(`Trace the seeded lot at /trace?lotId=${SEED_LOT_ID}`);
}

run().catch((error) => {
  console.error("Seed script failed:", error);
  process.exit(1);
});
