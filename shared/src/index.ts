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
  collectionStatus: CollectionStatus;
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
