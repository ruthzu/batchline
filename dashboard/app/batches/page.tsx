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
    <main className="min-h-screen bg-[var(--cream)] px-5 py-8 sm:px-8 lg:py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8">
          <p className="text-xs font-bold uppercase tracking-[.18em] text-[var(--amber)]">Production ledger</p>
          <h1 className="display-font mt-2 text-4xl font-semibold text-[var(--ink)]">Batch Board</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {sorted.length} batch{sorted.length !== 1 ? "es" : ""} total
          </p>
        </header>

        {sorted.length === 0 ? (
          <div className="rounded-3xl border border-[var(--line)] bg-[var(--paper)] p-10 text-center shadow-[var(--shadow)]">
            <p className="text-[var(--muted)]">No batches found.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--paper)] shadow-[var(--shadow)]">
            <table className="min-w-full divide-y divide-[var(--line)]">
              <thead className="bg-[var(--paper-deep)]">
                <tr>
                  <th
                    className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                    scope="col"
                  >
                    Batch ID
                  </th>
                  <th
                    className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                    scope="col"
                  >
                    Product
                  </th>
                  <th
                    className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                    scope="col"
                  >
                    Produced
                  </th>
                  <th
                    className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                    scope="col"
                  >
                    Lots
                  </th>
                  <th
                    className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                    scope="col"
                  >
                    Orders
                  </th>
                  <th
                    className="px-5 py-4 text-left text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]"
                    scope="col"
                  >
                    <span className="sr-only">Trace</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {sorted.map((batch) => (
                  <tr key={batch.batchId} className="transition hover:bg-[var(--cream)]">
                    <td className="whitespace-nowrap px-5 py-4 text-sm font-mono font-semibold text-[var(--ink)]">
                      {batch.batchId}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm font-medium text-[var(--ink)]">
                      {batch.product}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-[var(--muted)]">
                      {formatProducedDate(batch.producedDate)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-[var(--ink)]">
                      {batch.lotCount}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-[var(--ink)]">
                      {batch.orderCount}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-right">
                      {batch.lotIds.length > 0 ? (
                        <Link
                          href={`/trace?lotId=${encodeURIComponent(batch.lotIds[0])}`}
                          className="text-sm font-bold text-[var(--terracotta)] hover:text-[var(--terracotta-dark)]"
                        >
                          Trace
                        </Link>
                      ) : (
                        <Link
                          href="/trace"
                          className="text-sm text-[var(--muted)] hover:text-[var(--ink)]"
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
