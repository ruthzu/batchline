export interface Lot {
  lotId: string;
  ingredientName: string;
  supplier: string;
  receivedDate: string; // ISO 8601
  quantity: number;
}

export interface Batch {
  batchId: string;
  product: string;
  producedDate: string; // ISO 8601
  batchSize: number;
}

export type CollectionStatus = "collected" | "uncollected" | "incomplete";

export interface Order {
  orderId: string;
  customerName: string;
  customerContact: string;
  status: string;
  // Physically absent when the data went missing (the genuine "incomplete"
  // case) - undefined is meaningful and must survive to the UI, which renders
  // it distinctly instead of guessing a state
  collectionStatus?: CollectionStatus;
}

export interface BatchIngredientLink {
  lotId: string;
  batchId: string;
  quantityUsed: number;
}

export interface BatchOrderLink {
  batchId: string;
  orderId: string;
  quantityAllocated: number;
}

export interface CorrectionRecord {
  batchId: string;
  timestamp: string; // ISO 8601
  originalLotId: string;
  correctedLotId: string;
  reason: string;
  correctedBy: string;
  affectedOrderIds: string[];
}

export interface IdempotencyRecord {
  idempotencyKey: string;
  requestHash: string;
  result: unknown;
  executedAt: string;
  ttl: number; // epoch seconds
}

// --- Trace results ---
// Shared by trace_ingredient_lot (server) and the /trace dashboard page so
// both sides use one authoritative definition instead of drifting apart.

export interface TracedOrder {
  orderId: string;
  customerName?: string;
  collectionStatus: CollectionStatus;
}

export interface TracedBatch {
  batchId: string;
  product?: string;
  producedDate?: string;
  orders: TracedOrder[];
}

export interface TraceLotResult {
  lotId: string;
  batches: TracedBatch[];
  summary: {
    collected: number;
    uncollected: number;
    incomplete: number;
  };
}
