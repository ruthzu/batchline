"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  collected: "bg-emerald-500",
  uncollected: "bg-amber-500",
  incomplete: "bg-red-500",
  notified: "bg-blue-500",
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
      className: `order-node ${STATUS_NODE_STYLE[status] ?? "bg-gray-500"}`,
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
    style: { stroke: "#6b7280", strokeWidth: 2 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#6b7280",
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
      style: { stroke: "#6b7280", strokeWidth: 2 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "#6b7280",
      },
    });
  });
  return edges;
}

export default function TracePage() {
  const [lotId, setLotId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TraceLotResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const handleTrace = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!lotId.trim()) return;

      setLoading(true);
      setResult(null);
      setError(null);
      setNotFound(false);

      try {
        const url = `${MCP_SERVER_URL}/api/trace-lot?lotId=${encodeURIComponent(
          lotId.trim()
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
    [lotId, MCP_SERVER_URL]
  );

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
          style: { stroke: "#6b7280", strokeWidth: 2 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "#6b7280",
          },
        });

        const orders = batch.orders;
        const orderSpacing = 80;
        const totalOrderHeight = orders.length * orderSpacing;
        const startY = batchY + 100 - totalOrderHeight / 2;

        orders.forEach((order: TracedOrder, oIdx: number) => {
          const status = order.collectionStatus;
          nodes.push({
            id: `order-${order.orderId}`,
            type: "default",
            position: { x: batchX + 200, y: startY + oIdx * orderSpacing },
            data: {
              label: `${order.customerName ?? order.orderId}\n${order.orderId}`,
              className: `order-node ${
                STATUS_NODE_STYLE[status] ?? "bg-gray-500"
              }`,
            },
          });

          edges.push({
            id: `batch-${batch.batchId}->order-${order.orderId}`,
            source: `batch-${batch.batchId}`,
            target: `order-${order.orderId}`,
            type: "smoothstep",
            style: { stroke: "#9ca3af", strokeWidth: 1.5 },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: "#9ca3af",
            },
          });
        });
      });
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">Trace a Lot</h1>
          <a
            href="/orders"
            className="text-sm text-gray-500 hover:text-gray-700"
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
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-gray-900 placeholder-gray-400 focus:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading || !lotId.trim()}
              className="rounded-lg border border-gray-300 bg-white px-6 py-2 text-sm font-medium text-gray-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-50 transition-colors hover:bg-gray-50"
            >
              {loading ? "Tracing…" : "Trace Lot"}
            </button>
          </div>
        </form>

        {/* Error state */}
        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
            <p className="font-medium">Error</p>
            <p className="mt-1 text-sm">{error}</p>
          </div>
        )}

        {/* Not found state */}
        {notFound && (
          <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-6 text-center">
            <p className="text-lg font-medium text-gray-700">
              This lot was never recorded
            </p>
            <p className="mt-1 text-sm text-gray-500">
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
              <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-xs font-medium uppercase text-gray-500">
                  Summary
                </p>
                <div className="mt-2 flex gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-full bg-emerald-500" />
                    <span className="text-sm text-gray-700">
                      Collected: {result.summary.collected}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-full bg-amber-500" />
                    <span className="text-sm text-gray-700">
                      Uncollected: {result.summary.uncollected}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-full bg-red-500" />
                    <span className="text-sm text-gray-700">
                      Incomplete: {result.summary.incomplete}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            {/* React Flow graph */}
            <div
              ref={reactFlowWrapper}
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
              style={{ height: "520px" }}
            >
              <ReactFlow nodes={nodes} edges={edges} fitView>
                <Controls>
                  <span className="sr-only">Zoom controls</span>
                </Controls>
                <Background color="#e5e7eb" gap={16} />
              </ReactFlow>
            </div>

            {/* Legend */}
            <div className="mt-4 flex flex-wrap gap-4 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-gray-400" />
                Lot (source)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-gray-300" />
                Batch
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-emerald-500" />
                Collected / Fulfilled
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-amber-500" />
                Uncollected / On Hold
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-red-500" />
                Incomplete / Flagged
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-full bg-blue-500" />
                Notified
              </span>
            </div>
          </>
        )}

        {/* Empty state — no search performed yet */}
        {!result && !error && !notFound && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
            <p className="text-gray-500">
              Enter a lot ID above and click "Trace Lot" to see how that lot
              flows through batches and customer orders.
            </p>
          </div>
        )}
      </main>

      <style>{`
        .lot-node {
          background: #4b5563 !important;
          color: white !important;
          border-radius: 8px;
          padding: 8px 16px;
          font-weight: 600;
          font-size: 14px;
          border: 2px solid #374151;
        }
        .batch-node {
          background: #f3f4f6 !important;
          color: #374151 !important;
          border-radius: 8px;
          padding: 8px 16px;
          border: 2px solid #d1d5db;
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
        .no-batches-node {
          background: #fef3c7 !important;
          color: #92400e !important;
          border-radius: 8px;
          padding: 16px 24px;
          border: 2px dashed #f59e0b;
          font-size: 14px;
        }
      `}</style>
    </div>
  );
}
