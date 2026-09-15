# DynamoDB Single-Table Design

This project uses a single DynamoDB table named `batchline` with a single-table design pattern.

## Table Schema

**Table Name:** `batchline` (or `batchline-local` for local development)

**Partition Key (PK):** `PK` (string)
**Sort Key (SK):** `SK` (string)

## Global Secondary Indexes

### GSI1
- **GSI1PK:** `GSI1PK` (string)
- **GSI1SK:** `GSI1SK` (string)

## Entity Patterns

### Batch Metadata
```
PK: BATCH#<batchId>
SK: METADATA
```

Attributes:
- `batchId`: string
- `product`: string
- `producedDate`: ISO 8601 string
- `batchSize`: number
- `entityType`: "BATCH"

### Lot / Batch Link
```
PK: LOT#<lotId>
SK: BATCH#<batchId>
```

This item represents the relationship between a lot and a batch.

**GSI1 (for querying all batches a lot was used in):**
```
GSI1PK: LOT#<lotId>
GSI1SK: BATCH#<batchId>
```

Attributes:
- `lotId`: string
- `quantityUsed`: number
- `batchId`: string
- `entityType`: "LOT_BATCH_LINK"

### Lot Metadata (created on-demand when referenced)
```
PK: LOT#<lotId>
SK: METADATA
```

Attributes:
- `lotId`: string
- `ingredientName`: string ("unknown" if not registered)
- `supplier`: string ("unknown" if not registered)
- `receivedDate`: string (empty if not registered)
- `quantity`: number (0 if not registered)
- `entityType`: "LOT"

## Design Rationale

- **Batches** are accessed directly via `BATCH#<batchId>` + `METADATA`
- **Lot-Batch relationships** are stored as link items with the inverted GSI for querying "which batches used this lot?"
- **Lots** are created on-demand with minimal placeholder data when first referenced in a batch record, allowing a separate registration flow to fill in details later
- **Transactions** ensure batch records and their lot links are written atomically
