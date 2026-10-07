import { getAllOrders } from "../../lib/orders";
import type { Order } from "@batchline/shared";

const STATUS_CLASS: Record<string, string> = {
  fulfilled: "bg-[var(--sage-soft)] text-[var(--sage)]",
  on_hold: "bg-[var(--amber-soft)] text-[#936321]",
  notified: "bg-[var(--plum-soft)] text-[var(--plum)]",
  flagged_incomplete: "bg-[var(--rose-soft)] text-[var(--rose)]",
};

const STATUS_LABEL: Record<string, string> = {
  fulfilled: "Fulfilled",
  on_hold: "On Hold",
  notified: "Notified",
  flagged_incomplete: "Flagged",
};

// Physical pickup state - an independent field from the recall-workflow status
// above. A missing field renders as "Missing" (dashed styling) rather than
// masquerading as a real state, because absent data is not a state someone
// chose.
const COLLECTION_CLASS: Record<string, string> = {
  collected: "bg-[var(--sage-soft)] text-[var(--sage)]",
  uncollected: "bg-[var(--amber-soft)] text-[#936321]",
  incomplete: "bg-[var(--rose-soft)] text-[var(--rose)]",
};

const COLLECTION_LABEL: Record<string, string> = {
  collected: "Collected",
  uncollected: "Uncollected",
  incomplete: "Incomplete",
};

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const orders = await getAllOrders();

  const byStatus = (status: string) =>
    orders
      .filter((o) => o.status === status)
      .sort((a, b) => a.orderId.localeCompare(b.orderId));

  const statusSections: { status: string; orders: Order[] }[] = [
    { status: "fulfilled", orders: byStatus("fulfilled") },
    { status: "on_hold", orders: byStatus("on_hold") },
    { status: "notified", orders: byStatus("notified") },
    { status: "flagged_incomplete", orders: byStatus("flagged_incomplete") },
  ].filter((s) => s.orders.length > 0);

  return (
    <main className="min-h-screen bg-[var(--cream)] px-5 py-8 sm:px-8 lg:py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8">
          <p className="text-xs font-bold uppercase tracking-[.18em] text-[var(--terracotta)]">Customer response</p>
          <h1 className="display-font mt-2 text-4xl font-semibold text-[var(--ink)]">Order Board</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {orders.length} order{orders.length !== 1 ? "s" : ""} total
          </p>
        </header>

        {statusSections.length === 0 ? (
          <div className="rounded-3xl border border-[var(--line)] bg-[var(--paper)] p-10 text-center shadow-[var(--shadow)]">
            <p className="text-[var(--muted)]">No orders found.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {statusSections.map(({ status, orders: sectionOrders }) => (
              <section key={status}>
                <div className="mb-3 flex items-center gap-3">
                  <span
                    className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wide ${STATUS_CLASS[status] ?? "bg-[var(--paper-deep)] text-[var(--muted)]"}`}
                  >
                    {STATUS_LABEL[status] ?? status}
                  </span>
                  <span className="text-sm text-[var(--muted)]">
                    {sectionOrders.length}
                  </span>
                </div>

                <div className="overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--paper)] shadow-[var(--shadow)]">
                  <table className="min-w-full divide-y divide-[var(--line)]">
                    <thead className="bg-[var(--paper-deep)]">
                      <tr>
                        <th
                          className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                          scope="col"
                        >
                          Order ID
                        </th>
                        <th
                          className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                          scope="col"
                        >
                          Customer
                        </th>
                        <th
                          className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                          scope="col"
                        >
                          Contact
                        </th>
                        <th
                          className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                          scope="col"
                        >
                          Status
                        </th>
                        <th
                          className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                          scope="col"
                        >
                          Collection
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--line)]">
                      {sectionOrders.map((order) => (
                        <tr key={order.orderId} className="transition hover:bg-[var(--cream)]">
                          <td className="whitespace-nowrap px-5 py-4 text-sm font-mono font-semibold text-[var(--ink)]">
                            {order.orderId}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-sm font-medium text-[var(--ink)]">
                            {order.customerName}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-sm text-[var(--muted)]">
                            {order.customerContact}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4">
                            <span
                              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${STATUS_CLASS[order.status] ?? "bg-[var(--paper-deep)] text-[var(--muted)]"}`}
                            >
                              {STATUS_LABEL[order.status] ?? order.status}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-5 py-4">
                            {order.collectionStatus === undefined ? (
                              <span
                                className="inline-flex items-center rounded-full border border-dashed border-[var(--muted)] px-3 py-1 text-xs font-bold text-[var(--muted)]"
                                title="collectionStatus is missing from this order's record"
                              >
                                Missing
                              </span>
                            ) : (
                              <span
                                className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${COLLECTION_CLASS[order.collectionStatus] ?? "bg-[var(--paper-deep)] text-[var(--muted)]"}`}
                              >
                                {COLLECTION_LABEL[order.collectionStatus] ?? order.collectionStatus}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
