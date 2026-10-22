import {
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  QueryCommandOutput,
  ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import type { Batch } from "@batchline/shared";
import { documentClient, TABLE_NAME } from "./db";

/**
 * What the batch board renders for one row: the shared Batch shape plus the
 * two counts the board needs. lotIds is kept so each row can deep-link to
 * /trace?lotId=<id> (TraceLotResult supports a lot having many batches, so
 * tracing any of a batch's lots will always surface that batch).
 */
export type BatchWithCounts = Batch & {
  lotCount: number;
  orderCount: number;
  lotIds: string[];
};

/**
 * Server-side only: read every batch from the single table, plus per-batch
 * lot/order counts.
 *
 * Batch METADATA items follow the single-table design (see database.md and
 * record-batch.ts):
 *
 *   PK: BATCH#<batchId>   SK: METADATA   entityType: "BATCH"
 *   (attributes: batchId, product, producedDate, batchSize)
 *
 * There is no shared BATCH partition to Query (each batch is its own
 * partition), so finding all batches is a Scan with an entityType filter,
 * paginated via LastEvaluatedKey — the same trade-off lib/orders.ts makes
 * for ORDER items. Fine at dashboard scale; revisit if this ever grows.
 *
 * Unlike getAllOrders, no blanket-try/catch masking here: DynamoDB errors
 * (network, auth, missing table) propagate and Next renders its error page —
 * a silently-empty board would be a lie during a recall.
 */
export async function getAllBatches(): Promise<BatchWithCounts[]> {
  const batches: BatchWithCounts[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;

  do {
    const result: ScanCommandOutput = await documentClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "#entityType = :entityType",
        ExpressionAttributeNames: { "#entityType": "entityType" },
        ExpressionAttributeValues: { ":entityType": "BATCH" },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of result.Items ?? []) {
      // Skip anything that isn't a complete BATCH METADATA item rather than
      // rendering a broken row.
      if (
        typeof item.batchId === "string" &&
        typeof item.product === "string" &&
        typeof item.producedDate === "string" &&
        typeof item.batchSize === "number"
      ) {
        batches.push({
          batchId: item.batchId,
          product: item.product,
          producedDate: item.producedDate,
          batchSize: item.batchSize,
          lotCount: 0,
          orderCount: 0,
          lotIds: [],
        });
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Attach counts per batch.
  for (const batch of batches) {
    batch.lotCount = await countLotsForBatch(batch.batchId, batch.lotIds);
    batch.orderCount = await countOrdersForBatch(batch.batchId);
  }

  return batches;
}

/**
 * Count the ingredient lots a batch used. EXPLICIT CAVEAT — this needs a full
 * table Scan with a filter:
 *
 * Lot→batch links are stored with the LOT as the partition
 * (PK: LOT#<lotId>, SK: BATCH#<batchId> — record-batch.ts). GSI1 is a copy of
 * that same lot-keyed layout (GSI1PK: LOT#<lotId>), so neither the base table
 * nor the GSI can be keyed by batch — "which lots went into batch X?" has no
 * queryable index and the only way to answer it is to Scan everything and
 * filter. That's O(whole table) per batch and gets slower linearly; acceptable
 *
 *
 * Filtering mirrors trace-lot.ts's getActiveBatchIdsForLot: links carry a
 * supersededBy tombstone after a correction, and superseded links no longer
 * count — the corrected lot is the authoritative one for the batch.
 *
 * Returns both the count and the lotIds (for trace deep-links).
 */
async function countLotsForBatch(
  batchId: string,
  lotIdsOut: string[],
): Promise<number> {
  let lotCount = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;

  do {
    const result: ScanCommandOutput = await documentClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression:
          "#entityType = :entityType AND batchId = :batchId",
        ExpressionAttributeNames: { "#entityType": "entityType" },
        ExpressionAttributeValues: {
          ":entityType": "LOT_BATCH_LINK",
          ":batchId": batchId,
        },
        // We only need PK (LOT#<lotId>) and supersededBy — no point pulling
        // whole items back.
        ProjectionExpression: "PK, supersededBy",
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of result.Items ?? []) {
      // Superseded links were corrected away; the corrected lot is
      // authoritative for the batch instead (same rule as trace-lot.ts).
      if (item.supersededBy) {
        continue;
      }
      // On a LOT_BATCH_LINK item the lot is the partition: PK = LOT#<lotId>
      // (the SK is BATCH#<batchId> — the batch side, which we already know).
      if (typeof item.PK === "string" && item.PK.startsWith("LOT#")) {
        const lotId = item.PK.slice("LOT#".length);
        if (lotId) {
          lotIdsOut.push(lotId);
          lotCount += 1;
        }
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return lotCount;
}

/**
 * Count how many orders a batch shipped to. This one IS a cheap Query —
 * order links are filed under the batch's own partition
 * (PK: BATCH#<batchId>, SK: ORDER#<orderId>, as written by
 * seed-orders.ts / trace-lot.test.ts and queried the same way by
 * trace-lot.ts's getOrderIdsForBatch). Select: COUNT returns the count
 * without item payloads; pages are accumulated because a count-only Query
 * still paginates at 1MB.
 */
async function countOrdersForBatch(batchId: string): Promise<number> {
  let orderCount = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;

  do {
    const result: QueryCommandOutput = await documentClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": `BATCH#${batchId}`,
          ":skPrefix": "ORDER#",
        },
        Select: "COUNT",
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    orderCount += result.Count ?? 0;
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return orderCount;
}
