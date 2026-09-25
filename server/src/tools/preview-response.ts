import { z } from "zod";
import { documentClient, TABLE_NAME } from "../db/client.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

// A single decision the caller has already made about one order. The caller is
// expected to have run trace_ingredient_lot first and chosen the action from
// that order's collectionStatus — this tool does not re-derive that choice.
export const orderActionSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  action: z.enum(["hold", "notify", "flag"]),
});

// Input schema for the preview_response tool
export const previewResponseSchema = z.object({
  orderActions: z
    .array(orderActionSchema)
    .min(1, "at least one order action is required"),
});

export type OrderAction = z.infer<typeof orderActionSchema>;
export type ResponseAction = OrderAction["action"];
export type PreviewResponseInput = z.infer<typeof previewResponseSchema>;

export type DraftResponseEntry = {
  orderId: string;
  customerName?: string;
  action: ResponseAction;
  // Current order status, so the caller can see what the commit would change
  currentStatus?: string;
  // Only present for the "notify" action - "hold" and "flag" are internal
  // operations with no customer-facing message
  draftMessage?: string;
};

export type PreviewResponseResult = {
  previewId: string;
  actions: DraftResponseEntry[];
  generatedAt: string;
};

export type PreviewResponseError = {
  code: "ORDER_NOT_FOUND" | "DUPLICATE_ORDER_ACTION";
  message: string;
  orderId?: string;
};

// Custom error class for typed errors
export class PreviewResponseToolError extends Error {
  constructor(
    public readonly error: PreviewResponseError
  ) {
    super(error.message);
    this.name = "PreviewResponseToolError";
  }
}

// Fetch order metadata (customerName, status).
// Returns null only when the item genuinely doesn't exist; DynamoDB errors propagate.
export async function getOrderMetadata(orderId: string): Promise<{
  customerName?: string;
  status?: string;
} | null> {
  const result = await documentClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `ORDER#${orderId}`,
        SK: "METADATA",
      },
    })
  );
  if (!result.Item) {
    return null;
  }
  return {
    customerName: result.Item.customerName as string | undefined,
    status: result.Item.status as string | undefined,
  };
}

// Reject the same order appearing twice. A commit of such a list could never
// succeed - DynamoDB rejects a transaction with two writes to one item - so
// catching it at preview time keeps the caller from drafting an uncommittable
// response.
export function assertNoDuplicateOrders(orderActions: OrderAction[]): void {
  const seen = new Set<string>();
  for (const { orderId } of orderActions) {
    if (seen.has(orderId)) {
      throw new PreviewResponseToolError({
        code: "DUPLICATE_ORDER_ACTION",
        message: `Order '${orderId}' appears more than once in orderActions. Each order may have at most one action.`,
        orderId,
      });
    }
    seen.add(orderId);
  }
}

// Short customer-facing recall notice. Only built for the "notify" action.
function buildDraftMessage(orderId: string, customerName?: string): string {
  const greeting = customerName ? `Hello ${customerName},` : "Hello,";
  return (
    `${greeting} we are contacting you about order ${orderId}. ` +
    `An ingredient used in this order has been recalled, so the order is affected. ` +
    `Please do not consume the product and contact us to arrange a replacement or refund.`
  );
}

export const previewResponseTool = {
  schema: previewResponseSchema,

  handler: async (input: PreviewResponseInput) => {
    assertNoDuplicateOrders(input.orderActions);

    const actions: DraftResponseEntry[] = [];

    for (const orderAction of input.orderActions) {
      // An order the caller named but that doesn't exist is a real error, not
      // something to skip quietly - the caller's plan is built on bad data.
      // DynamoDB errors (network, auth, table missing) propagate as exceptions.
      const orderMetadata = await getOrderMetadata(orderAction.orderId);

      if (!orderMetadata) {
        throw new PreviewResponseToolError({
          code: "ORDER_NOT_FOUND",
          message: `Order with ID '${orderAction.orderId}' was not found. Cannot draft a response for an order that does not exist.`,
          orderId: orderAction.orderId,
        });
      }

      actions.push({
        orderId: orderAction.orderId,
        customerName: orderMetadata.customerName,
        action: orderAction.action,
        currentStatus: orderMetadata.status,
        draftMessage:
          orderAction.action === "notify"
            ? buildDraftMessage(orderAction.orderId, orderMetadata.customerName)
            : undefined,
      });
    }

    // Identifies this specific preview. Nothing is persisted here - this tool is
    // read-only. commit_approved_response requires this previewId back alongside
    // the same orderActions, so a commit can be tied to the preview a human
    // actually approved.
    const result: PreviewResponseResult = {
      previewId: crypto.randomUUID(),
      actions,
      generatedAt: new Date().toISOString(),
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
};
