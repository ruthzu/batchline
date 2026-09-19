/**
 * One-off dev utility: seed a handful of realistic order METADATA items into
 * DynamoDB Local so the /orders board has something to display.
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
 */

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient, TABLE_NAME } from "../lib/db";

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

async function run() {
  console.log("Seeding orders into DynamoDB Local…");
  console.log(`Table: ${TABLE_NAME}`);
  console.log(`Orders to write: ${ORDERS.length}`);
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
  console.log("Done. Start the dashboard with:");
  console.log("  npm run dev --workspace=dashboard");
  console.log("Then visit http://localhost:3000/orders");
}

run().catch((error) => {
  console.error("Seed script failed:", error);
  process.exit(1);
});
