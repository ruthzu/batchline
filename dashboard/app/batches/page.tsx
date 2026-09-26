import Link from "next/link";
import { getAllBatches } from "../../lib/batches";

export const dynamic = "force-dynamic";

function formatProducedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function BatchesPage() {
  const batches = await getAllBatches();

  // Newest production run first.
  const sorted = [...batches].sort((a, b) =>
    b.producedDate.localeCompare(a.producedDate),
  );

  return (
    <main className="min-h-screen bg-white p-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Batch Board</h1>
          <p className="mt-1 text-sm text-gray-500">
            {sorted.length} batch{sorted.length !== 1 ? "es" : ""} total
          </p>
        </header>

        {sorted.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
            <p className="text-gray-500">No batches found.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    scope="col"
                  >
                    Batch ID
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    scope="col"
                  >
                    Product
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    scope="col"
                  >
                    Produced
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    scope="col"
                  >
                    Lots
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    scope="col"
                  >
                    Orders
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    scope="col"
                  >
                    <span className="sr-only">Trace</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sorted.map((batch) => (
                  <tr key={batch.batchId}>
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-mono text-gray-900">
                      {batch.batchId}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                      {batch.product}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                      {formatProducedDate(batch.producedDate)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                      {batch.lotCount}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                      {batch.orderCount}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      {batch.lotIds.length > 0 ? (
                        <Link
                          href={`/trace?lotId=${encodeURIComponent(batch.lotIds[0])}`}
                          className="text-sm font-medium text-blue-600 hover:text-blue-800"
                        >
                          Trace
                        </Link>
                      ) : (
                        <Link
                          href="/trace"
                          className="text-sm text-gray-400 hover:text-gray-600"
                        >
                          Trace
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
