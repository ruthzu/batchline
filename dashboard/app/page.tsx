import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-2xl font-bold">Batchline Dashboard</h1>
      <p className="mt-2 text-gray-600">
        Placeholder home page.
      </p>
      <div className="mt-8 flex flex-col gap-3">
        <Link
          href="/orders"
          className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
        >
          View Order Board /
        </Link>
        <Link
          href="/trace"
          className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
        >
          Trace a Lot /
        </Link>
        <Link
          href="/voice"
          className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
        >
          Try Voice (Simulated Alexa+) /
        </Link>
      </div>
    </main>
  );
}
