import { getAllOrders } from "../../lib/orders";
import type { Order } from "@batchline/shared";

const STATUS_CLASS: Record<string, string> = {
  fulfilled: "bg-emerald-100 text-emerald-800",
  on_hold: "bg-amber-100 text-amber-800",
  notified: "bg-blue-100 text-blue-800",
  flagged_incomplete: "bg-red-100 text-red-800",
};

const STATUS_LABEL: Record<string, string> = {
  fulfilled: "Fulfilled",
  on_hold: "On Hold",
  notified: "Notified",
  flagged_incomplete: "Flagged",
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
    <main className="min-h-screen bg-white p-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Order Board</h1>
          <p className="mt-1 text-sm text-gray-500">
            {orders.length} order{orders.length !== 1 ? "s" : ""} total
          </p>
        </header>

        {statusSections.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
            <p className="text-gray-500">No orders found.</p>
          </div>
        ) : (
          <div className="space-y-8">
            {statusSections.map(({ status, orders: sectionOrders }) => (
              <section key={status}>
                <div className="mb-3 flex items-center gap-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATUS_CLASS[status] ?? "bg-gray-100 text-gray-800"}`}
                  >
                    {STATUS_LABEL[status] ?? status}
                  </span>
                  <span className="text-sm text-gray-400">
                    {sectionOrders.length}
                  </span>
                </div>

                <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th
                          className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                          scope="col"
                        >
                          Order ID
                        </th>
                        <th
                          className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                          scope="col"
                        >
                          Customer
                        </th>
                        <th
                          className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                          scope="col"
                        >
                          Contact
                        </th>
                        <th
                          className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                          scope="col"
                        >
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sectionOrders.map((order) => (
                        <tr key={order.orderId}>
                          <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-gray-900">
                            {order.orderId}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                            {order.customerName}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                            {order.customerContact}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CLASS[order.status] ?? "bg-gray-100 text-gray-800"}`}
                            >
                              {STATUS_LABEL[order.status] ?? order.status}
                            </span>
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
