"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Node,
  Edge,
  ReactFlow,
  Controls,
  Background,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";

import type {
  TraceLotResult,
  TracedBatch,
  TracedOrder,
} from "@batchline/shared";

const MCP_SERVER_URL =
  process.env.NEXT_PUBLIC_MCP_SERVER_URL ?? "http://localhost:3001";

// Color scheme matching the order board badges:
//   collected / fulfilled   -> emerald
//   uncollected / on_hold    -> amber
//   incomplete / flagged     -> red
//   notified                 -> blue
const STATUS_NODE_STYLE: Record<string, string> = {
  collected: "order-collected",
  uncollected: "order-uncollected",
  incomplete: "order-incomplete",
  notified: "order-notified",
};

const STATUS_LABEL: Record<string, string> = {
  collected: "Collected",
  uncollected: "Uncollected",
  incomplete: "Incomplete",
  notified: "Notified",
};

function lotNode(lotId: string): Node {
  return {
    id: `lot-${lotId}`,
    type: "default",
    position: { x: 250, y: 50 },
    data: {
      label: `Lot\n${lotId}`,
      className: "lot-node",
    },
  };
}

function batchNode(batch: { batchId: string; product?: string }): Node {
  return {
    id: `batch-${batch.batchId}`,
    type: "default",
    position: { x: 250, y: 180 },
    data: {
      label: `Batch ${batch.batchId}\n${
        batch.product ? batch.product : ""
      }`,
      className: "batch-node",
    },
  };
}

function orderNode(
  order: { orderId: string; customerName?: string; collectionStatus: string },
  index: number,
  totalOrders: number,
  xOffset: number
): Node {
  const status = order.collectionStatus;
  return {
    id: `order-${order.orderId}`,
    type: "default",
    position: { x: 250 + xOffset, y: 340 + index * 70 },
    data: {
      label: `${order.customerName ?? order.orderId}\n${order.orderId}`,
      className: `order-node ${STATUS_NODE_STYLE[status] ?? "order-fallback"}`,
    },
  };
}

function makeEdges(lotId: string, batches: { batchId: string }[]): Edge[] {
  return batches.map((batch) => ({
    id: `lot-${lotId}->batch-${batch.batchId}`,
    source: `lot-${lotId}`,
    target: `batch-${batch.batchId}`,
    type: "smoothstep",
    animated: false,
    style: { stroke: "#c98932", strokeWidth: 2 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#c98932",
    },
  }));
}

function makeOrderEdges(
  lotId: string,
  batches: { batchId: string }[]
): Edge[] {
  const edges: Edge[] = [];
  batches.forEach((batch, bIdx) => {
    edges.push({
      id: `batch-${batch.batchId}->lot-${lotId}`,
      source: `batch-${batch.batchId}`,
      target: `lot-${lotId}`,
      type: "smoothstep",
      animated: false,
      style: { stroke: "#c98932", strokeWidth: 2 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "#c98932",
      },
    });
  });
  return edges;
}

function TracePageContent() {
  const searchParams = useSearchParams();
  // Pre-fill from /trace?lotId=<id> deep links (e.g. the batch board's
  // "Trace" buttons). Falls back to "" for a plain /trace visit, which
  // behaves exactly as before.
  const [lotId, setLotId] = useState(() => searchParams.get("lotId") ?? "");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TraceLotResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  // Core trace fetch, shared by the manual form submit (handleTrace) and the
  // automatic run-on-mount for a ?lotId= deep link (see the effect below) —
  // one implementation, two entry points.
  const runTrace = useCallback(
    async (rawLotId: string) => {
      if (!rawLotId.trim()) return;

      setLoading(true);
      setResult(null);
      setError(null);
      setNotFound(false);

      try {
        const url = `${MCP_SERVER_URL}/api/trace-lot?lotId=${encodeURIComponent(
          rawLotId.trim()
        )}`;
        const response = await fetch(url);

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          if (response.status === 404 && body.code === "LOT_NOT_FOUND") {
            setNotFound(true);
            return;
          }
          setError(
            body.message ??
              `Request failed with status ${response.status}`
          );
          return;
        }

        const json = await response.json();
        setResult(json);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to fetch trace results"
        );
      } finally {
        setLoading(false);
      }
    },
    [MCP_SERVER_URL]
  );

  const handleTrace = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      await runTrace(lotId);
    },
    [runTrace, lotId]
  );

  // Deep-link support: /trace?lotId=<id> pre-fills the input (via the
  // useState initializer above) and automatically runs the trace once on
  // mount so "Trace" links from the batch board land on a rendered graph.
  // Without the param this effect does nothing and the page waits for a
  // manual search, exactly as before. The ref guard makes it run once even
  // though React StrictMode invokes effects twice in dev.
  const autoLotId = searchParams.get("lotId");
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current) return;
    if (autoLotId && autoLotId.trim()) {
      autoRanRef.current = true;
      void runTrace(autoLotId);
    }
  }, [autoLotId, runTrace]);

  useEffect(() => {
    if (result && reactFlowWrapper.current) {
      // Fit the graph to the nodes after the result changes.
      // Use a small delay to let React Flow render the new nodes first.
      const timer = setTimeout(() => {
        const instance = (reactFlowWrapper.current as any)?.reactFlowInstance;
        if (instance) {
          instance.fitView({ padding: 0.2 });
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [result]);

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  if (result) {
    const { lotId: tracedLotId, batches, summary } = result;

    // Lot node (source) — distinct color
    nodes.push({
      id: `lot-${tracedLotId}`,
      type: "default",
      position: { x: 250, y: 50 },
      data: {
        label: `Lot\n${tracedLotId}`,
        className: "lot-node",
      },
    });

    if (batches.length === 0) {
      // No active batches — show a message node instead of an empty graph
      nodes.push({
        id: "no-batches-message",
        type: "default",
        position: { x: 250, y: 200 },
        data: {
          label: "No active batches found for this lot.\nThe lot may have been fully corrected away.",
          className: "no-batches-node",
        },
      });
    } else {
      // Arranged vertically — lot at top, then batches below, orders under each batch
      const batchSpacing = 280;
      batches.forEach((batch: TracedBatch, bIdx: number) => {
        const batchX = 250;
        const batchY = 180 + bIdx * batchSpacing;

        nodes.push({
          id: `batch-${batch.batchId}`,
          type: "default",
          position: { x: batchX, y: batchY },
          data: {
            label: `Batch ${batch.batchId}\n${
              batch.product ? batch.product : ""
            }`,
            className: "batch-node",
          },
        });

        edges.push({
          id: `lot-${tracedLotId}->batch-${batch.batchId}`,
          source: `lot-${tracedLotId}`,
          target: `batch-${batch.batchId}`,
          type: "smoothstep",
          style: { stroke: "#c98932", strokeWidth: 2 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "#c98932",
          },
        });

        const orders = batch.orders;
        const orderSpacing = 80;
        const totalOrderHeight = orders.length * orderSpacing;
        const startY = batchY + 100 - totalOrderHeight / 2;

        orders.forEach((order: TracedOrder, oIdx: number) => {
          const status = order.collectionStatus;
          // Node id is scoped to the batch: an order linked to two batches
          // legitimately appears under both, and React Flow requires globally
          // unique node ids — `order-<orderId>` alone would emit two nodes
          // with the same id and the second would clobber the first.
          nodes.push({
            id: `order-${batch.batchId}-${order.orderId}`,
            type: "default",
            position: { x: batchX + 200, y: startY + oIdx * orderSpacing },
            data: {
              label: `${order.customerName ?? order.orderId}\n${order.orderId}`,
              className: `order-node ${
                STATUS_NODE_STYLE[status] ?? "order-fallback"
              }`,
            },
          });

          edges.push({
            id: `batch-${batch.batchId}->order-${order.orderId}`,
            source: `batch-${batch.batchId}`,
            target: `order-${batch.batchId}-${order.orderId}`,
            type: "smoothstep",
            style: { stroke: "#d4b99b", strokeWidth: 1.5 },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: "#d4b99b",
            },
          });
        });
      });
    }
  }

  return (
    <div className="min-h-screen bg-[var(--cream)]">
      <header className="border-b border-[var(--line)] bg-[var(--paper)] px-6 py-5">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <h1 className="display-font text-2xl font-semibold text-[var(--ink)]">Trace a Lot</h1>
          <a
            href="/orders"
            className="text-sm font-semibold text-[var(--muted)] hover:text-[var(--terracotta)]"
          >
            Back to Order Board
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {/* Search form */}
        <form onSubmit={handleTrace} className="mb-8">
          <div className="flex gap-3">
            <input
              type="text"
              value={lotId}
              onChange={(e) => setLotId(e.target.value)}
              placeholder="e.g. LOT-RESP-1789754814959"
              className="flex-1 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-[var(--ink)] placeholder-[var(--muted)] focus:border-[var(--amber)] focus:outline-none focus:ring-2 focus:ring-[var(--amber-soft)]"
            />
            <button
              type="submit"
              disabled={loading || !lotId.trim()}
              className="rounded-xl bg-[var(--terracotta)] px-6 py-3 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[var(--terracotta-dark)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Tracing…" : "Trace Lot"}
            </button>
          </div>
        </form>

        {/* Error state */}
        {error && (
          <div className="mb-6 rounded-2xl border border-[var(--rose-soft)] bg-[var(--paper)] p-4 text-[var(--rose)]">
            <p className="font-medium">Error</p>
            <p className="mt-1 text-sm">{error}</p>
          </div>
        )}

        {/* Not found state */}
        {notFound && (
          <div className="mb-6 rounded-2xl border border-[var(--line)] bg-[var(--paper)] p-6 text-center">
            <p className="display-font text-2xl font-semibold text-[var(--ink)]">
              This lot was never recorded
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              The lot ID "{lotId}" does not exist in the system. It may have been
              typed incorrectly, or no batch has ever been recorded with this lot.
            </p>
          </div>
        )}

        {/* Result: summary + graph */}
        {result && (
          <>
            {/* Summary counts */}
            <div className="mb-6 flex flex-wrap gap-4">
              <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] px-5 py-4 shadow-[var(--shadow)]">
                <p className="text-xs font-bold uppercase tracking-[.14em] text-[var(--muted)]">
                  Summary
                </p>
                <div className="mt-2 flex gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-full bg-[var(--sage)]" />
                    <span className="text-sm text-[var(--ink)]">
                      Collected: {result.summary.collected}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-full bg-[var(--amber)]" />
                    <span className="text-sm text-[var(--ink)]">
                      Uncollected: {result.summary.uncollected}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-full bg-[var(--rose)]" />
                    <span className="text-sm text-[var(--ink)]">
                      Incomplete: {result.summary.incomplete}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            {/* React Flow graph */}
            <div
              ref={reactFlowWrapper}
              className="rounded-3xl border border-[var(--line)] bg-[var(--paper)] p-4 shadow-[var(--shadow)]"
              style={{ height: "520px" }}
            >
              <ReactFlow nodes={nodes} edges={edges} fitView>
                <Controls>
                  <span className="sr-only">Zoom controls</span>
                </Controls>
                <Background color="#e6dbce" gap={18} />
              </ReactFlow>
            </div>

            {/* Legend */}
            <div className="mt-4 flex flex-wrap gap-4 text-xs text-[var(--muted)]">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-[var(--terracotta)]" />
                Lot (source)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-[var(--amber)]" />
                Batch
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-[var(--sage)]" />
                Collected / Fulfilled
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-[var(--amber)]" />
                Uncollected / On Hold
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-[var(--rose)]" />
                Incomplete / Flagged
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-[var(--plum)]" />
                Notified
              </span>
            </div>
          </>
        )}

        {/* Empty state — no search performed yet */}
        {!result && !error && !notFound && (
          <div className="rounded-3xl border border-[var(--line)] bg-[var(--paper)] p-8 text-center shadow-[var(--shadow)]">
            <p className="text-[var(--muted)]">
              Enter a lot ID above and click "Trace Lot" to see how that lot
              flows through batches and customer orders.
            </p>
          </div>
        )}
      </main>

      <style>{`
        .lot-node {
          background: var(--terracotta) !important;
          color: white !important;
          border-radius: 8px;
          padding: 8px 16px;
          font-weight: 600;
          font-size: 14px;
          border: 2px solid var(--terracotta-dark);
        }
        .batch-node {
          background: var(--amber-soft) !important;
          color: var(--ink) !important;
          border-radius: 8px;
          padding: 8px 16px;
          border: 2px solid var(--amber);
          font-weight: 500;
          font-size: 13px;
        }
        .order-node {
          border-radius: 8px;
          padding: 8px 16px;
          color: white !important;
          font-weight: 500;
          font-size: 13px;
          border: 1px solid rgba(255,255,255,0.3);
        }
        .order-collected { background: var(--sage) !important; }
        .order-uncollected { background: var(--amber) !important; }
        .order-incomplete { background: var(--rose) !important; }
        .order-notified { background: var(--plum) !important; }
        .order-fallback { background: var(--muted) !important; }
        .no-batches-node {
          background: var(--amber-soft) !important;
          color: #936321 !important;
          border-radius: 8px;
          padding: 16px 24px;
          border: 2px dashed var(--amber);
          font-size: 14px;
        }
      `}</style>
    </div>
  );
}

/**
 * useSearchParams() requires a Suspense boundary in Next 15 (the inner
 * content opts out of static prerendering, so the shell needs a fallback).
 */
export default function TracePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[var(--cream)]">
          <p className="text-sm text-[var(--muted)]">Loading trace…</p>
        </div>
      }
    >
      <TracePageContent />
    </Suspense>
  );
}
