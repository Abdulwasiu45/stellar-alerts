'use client';

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  TransactionGraph,
  GraphNode,
  GraphEdge,
  GraphPayment,
  shortAddress,
  clusterColor,
} from '../../lib/graph/forceGraph';

export interface MoneyFlowGraphProps {
  payments?: GraphPayment[];
  monitoredWallets?: string[];
  height?: number | string;
  width?: number | string;
  onNodeSelect?: (node: GraphNode | null) => void;
  selectedNodeId?: string | null;
}

// Asset color map
const ASSET_COLORS: Record<string, string> = {
  XLM: '#38bdf8', // Sky blue
  USDC: '#22c55e', // Green
  EURC: '#60a5fa', // Blue
  AQUA: '#06b6d4', // Cyan
  yXLM: '#fbbf24', // Amber
  BTC: '#f97316', // Orange
  ETH: '#818cf8', // Indigo
};

export function getAssetColor(asset: string): string {
  const upper = asset.toUpperCase();
  return ASSET_COLORS[upper] || '#a855f7'; // Purple fallback
}

/**
 * Helper to generate nodes and links dataset from payment records.
 */
export function buildGraphDatasetFromPayments(
  payments: GraphPayment[],
  monitoredWallets: string[] = []
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  graph: TransactionGraph;
} {
  const graph = new TransactionGraph(500);
  graph.setWalletAddresses(monitoredWallets);

  for (const payment of payments) {
    graph.addPayment(payment);
  }

  return {
    nodes: Array.from(graph.nodes.values()),
    edges: Array.from(graph.edges.values()),
    graph,
  };
}

export const MoneyFlowGraph: React.FC<MoneyFlowGraphProps> = ({
  payments = [],
  monitoredWallets = [],
  height = 600,
  width = '100%',
  onNodeSelect,
  selectedNodeId,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Pan & Zoom transform state
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const draggedNodeRef = useRef<GraphNode | null>(null);

  // Selected node state for inspection
  const [activeNode, setActiveNode] = useState<GraphNode | null>(null);
  const [filterAsset, setFilterAsset] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSimulating, setIsSimulating] = useState(true);

  // Force simulation graph instance
  const graphInstance = useMemo(() => {
    const { graph } = buildGraphDatasetFromPayments(payments, monitoredWallets);
    return graph;
  }, [payments, monitoredWallets]);

  // Sync external selectedNodeId
  useEffect(() => {
    if (selectedNodeId) {
      const node = graphInstance.nodes.get(selectedNodeId);
      if (node) setActiveNode(node);
    }
  }, [selectedNodeId, graphInstance]);

  // Center graph initially
  useEffect(() => {
    if (containerRef.current) {
      const { clientWidth, clientHeight } = containerRef.current;
      transformRef.current = {
        x: clientWidth / 2,
        y: (typeof height === 'number' ? height : clientHeight || 600) / 2,
        scale: 1,
      };
    }
  }, [height]);

  // Main canvas render & simulation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;

    const render = () => {
      if (isSimulating) {
        graphInstance.step();
      }

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      // Background grid
      ctx.fillStyle = '#0f172a'; // Slate 900
      ctx.fillRect(0, 0, w, h);

      // Apply transform (pan & zoom)
      ctx.save();
      ctx.translate(transformRef.current.x, transformRef.current.y);
      ctx.scale(transformRef.current.scale, transformRef.current.scale);

      const edges = Array.from(graphInstance.edges.values());
      const nodes = Array.from(graphInstance.nodes.values());

      // 1. Draw Edges
      for (const edge of edges) {
        if (filterAsset !== 'ALL' && edge.asset.toUpperCase() !== filterAsset.toUpperCase()) {
          continue;
        }

        const s = graphInstance.nodes.get(edge.source);
        const t = graphInstance.nodes.get(edge.target);
        if (!s || !t) continue;

        const isHighlighted =
          activeNode && (s.id === activeNode.id || t.id === activeNode.id);

        const assetColor = getAssetColor(edge.asset);
        // Thickness proportional to log volume
        const thickness = Math.max(1.5, Math.min(8, Math.log10(edge.volume + 1) * 2));

        ctx.strokeStyle = isHighlighted ? assetColor : `${assetColor}88`;
        ctx.lineWidth = isHighlighted ? thickness + 1.5 : thickness;

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();

        // Draw directed arrow head
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 25) {
          const arrowLen = 8;
          const targetOffset = 18; // offset from node center
          const arrowX = t.x - (dx / dist) * targetOffset;
          const arrowY = t.y - (dy / dist) * targetOffset;
          const angle = Math.atan2(dy, dx);

          ctx.fillStyle = isHighlighted ? assetColor : `${assetColor}aa`;
          ctx.beginPath();
          ctx.moveTo(arrowX, arrowY);
          ctx.lineTo(
            arrowX - arrowLen * Math.cos(angle - Math.PI / 6),
            arrowY - arrowLen * Math.sin(angle - Math.PI / 6)
          );
          ctx.lineTo(
            arrowX - arrowLen * Math.cos(angle + Math.PI / 6),
            arrowY - arrowLen * Math.sin(angle + Math.PI / 6)
          );
          ctx.closePath();
          ctx.fill();
        }
      }

      // 2. Draw Nodes
      for (const node of nodes) {
        const isSelected = activeNode?.id === node.id;
        const isMonitored = node.kind === 'wallet';
        const isMatched = searchQuery
          ? node.id.toLowerCase().includes(searchQuery.toLowerCase())
          : false;

        const baseRadius = isMonitored ? 12 : node.kind === 'pool' ? 10 : 8;
        const radius = isSelected ? baseRadius + 3 : baseRadius;

        // Selection / Monitored Glow
        if (isSelected || isMatched) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 6, 0, Math.PI * 2);
          ctx.fillStyle = isMatched ? 'rgba(234, 179, 8, 0.4)' : 'rgba(56, 189, 248, 0.4)';
          ctx.fill();
        }

        // Monitored Wallet distinct ring
        if (isMonitored) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius + 3, 0, Math.PI * 2);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Node circle
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = isMonitored
          ? '#0284c7' // Blue for monitored wallet
          : node.kind === 'pool'
          ? '#9333ea' // Purple for contract/pool
          : clusterColor(node.cluster);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.stroke();

        // Node label
        ctx.font = '10px monospace';
        ctx.fillStyle = isSelected ? '#ffffff' : '#94a3b8';
        ctx.textAlign = 'center';
        ctx.fillText(shortAddress(node.id), node.x, node.y + radius + 12);
      }

      ctx.restore();
      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [graphInstance, isSimulating, activeNode, filterAsset, searchQuery]);

  // Screen coordinates to graph world coordinates
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const { x, y, scale } = transformRef.current;
    return {
      x: (sx - x) / scale,
      y: (sy - y) / scale,
    };
  }, []);

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.88;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const { x, y, scale } = transformRef.current;
    const newScale = Math.max(0.2, Math.min(5, scale * zoomFactor));

    transformRef.current = {
      x: mouseX - (mouseX - x) * (newScale / scale),
      y: mouseY - (mouseY - y) * (newScale / scale),
      scale: newScale,
    };
  };

  // Find node under mouse
  const findNodeAt = (wx: number, wy: number): GraphNode | null => {
    for (const node of graphInstance.nodes.values()) {
      const dx = node.x - wx;
      const dy = node.y - wy;
      if (dx * dx + dy * dy <= 256) {
        return node;
      }
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
    const node = findNodeAt(wx, wy);

    if (node) {
      draggedNodeRef.current = node;
      node.fixed = true;
    } else {
      isDraggingRef.current = true;
      dragStartRef.current = {
        x: e.clientX - transformRef.current.x,
        y: e.clientY - transformRef.current.y,
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggedNodeRef.current) {
      const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
      draggedNodeRef.current.x = wx;
      draggedNodeRef.current.y = wy;
    } else if (isDraggingRef.current) {
      transformRef.current.x = e.clientX - dragStartRef.current.x;
      transformRef.current.y = e.clientY - dragStartRef.current.y;
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggedNodeRef.current) {
      draggedNodeRef.current.fixed = false;
      draggedNodeRef.current = null;
    }
    isDraggingRef.current = false;
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
    const node = findNodeAt(wx, wy);
    setActiveNode(node);
    if (onNodeSelect) {
      onNodeSelect(node);
    }
  };

  const resetView = () => {
    if (containerRef.current) {
      const { clientWidth, clientHeight } = containerRef.current;
      transformRef.current = {
        x: clientWidth / 2,
        y: (typeof height === 'number' ? height : clientHeight || 600) / 2,
        scale: 1,
      };
    }
  };

  // Inspect recent payments for active node
  const activeNodePayments = useMemo(() => {
    if (!activeNode) return [];
    return payments
      .filter((p) => p.from === activeNode.id || p.to === activeNode.id)
      .slice(-10);
  }, [activeNode, payments]);

  // Unique assets for filter
  const assets = useMemo(() => {
    const set = new Set<string>();
    for (const p of payments) {
      if (p.asset) set.add(p.asset.toUpperCase());
    }
    return Array.from(set);
  }, [payments]);

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-xl border border-slate-800 bg-slate-950 overflow-hidden shadow-2xl flex flex-col font-sans"
      style={{ height }}
    >
      {/* Top Toolbar */}
      <div className="absolute top-4 left-4 right-4 z-10 flex flex-wrap items-center justify-between gap-3 bg-slate-900/80 backdrop-blur-md px-4 py-2.5 rounded-lg border border-slate-800">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Money Flow Topology
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 font-medium">
            {graphInstance.nodes.size} Nodes
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
            {graphInstance.edges.size} Edges
          </span>
        </div>

        {/* Filters and Search */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search address (G...)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="text-xs px-2.5 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />

          <select
            value={filterAsset}
            onChange={(e) => setFilterAsset(e.target.value)}
            className="text-xs px-2.5 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
          >
            <option value="ALL">All Assets</option>
            {assets.map((asset) => (
              <option key={asset} value={asset}>
                {asset}
              </option>
            ))}
          </select>

          <button
            onClick={() => setIsSimulating(!isSimulating)}
            className={`text-xs px-2.5 py-1.5 rounded-md font-medium border transition-colors ${
              isSimulating
                ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
            }`}
          >
            {isSimulating ? 'Pause Physics' : 'Resume'}
          </button>

          <button
            onClick={resetView}
            className="text-xs px-2.5 py-1.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 font-medium"
          >
            Reset View
          </button>
        </div>
      </div>

      {/* Main Interactive Canvas */}
      <canvas
        ref={canvasRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        className="w-full h-full cursor-grab active:cursor-grabbing flex-grow"
      />

      {/* Node Inspection Drawer / Popup */}
      {activeNode && (
        <div className="absolute bottom-4 right-4 z-20 w-96 max-h-[80%] bg-slate-900/95 backdrop-blur-md border border-slate-800 rounded-xl p-4 shadow-2xl flex flex-col gap-3 text-slate-200">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <div className="flex items-center gap-2">
              <span
                className={`w-3 h-3 rounded-full ${
                  activeNode.kind === 'wallet'
                    ? 'bg-sky-400'
                    : activeNode.kind === 'pool'
                    ? 'bg-purple-400'
                    : 'bg-emerald-400'
                }`}
              />
              <span className="font-semibold text-sm capitalize">
                {activeNode.kind === 'wallet' ? 'Monitored Wallet' : activeNode.kind}
              </span>
            </div>
            <button
              onClick={() => setActiveNode(null)}
              className="text-slate-400 hover:text-white text-xs font-bold px-1.5 py-0.5 rounded hover:bg-slate-800"
            >
              ✕
            </button>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-slate-400 font-medium">Account Address:</span>
            <div className="flex items-center gap-1.5 bg-slate-950 p-2 rounded border border-slate-800">
              <span className="text-xs font-mono text-slate-300 break-all select-all">
                {activeNode.id}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 py-1 text-center">
            <div className="bg-slate-950/60 p-2 rounded border border-slate-800">
              <span className="block text-[10px] text-slate-500 uppercase">Volume</span>
              <span className="text-xs font-mono font-semibold text-sky-400">
                {activeNode.volume.toLocaleString()}
              </span>
            </div>
            <div className="bg-slate-950/60 p-2 rounded border border-slate-800">
              <span className="block text-[10px] text-slate-500 uppercase">Hops/Degree</span>
              <span className="text-xs font-mono font-semibold text-emerald-400">
                {activeNode.degree}
              </span>
            </div>
            <div className="bg-slate-950/60 p-2 rounded border border-slate-800">
              <span className="block text-[10px] text-slate-500 uppercase">Cluster</span>
              <span className="text-xs font-mono font-semibold text-amber-400">
                #{activeNode.cluster}
              </span>
            </div>
          </div>

          {/* Recent Payments Inspection */}
          <div className="flex flex-col gap-1.5 mt-1 overflow-hidden">
            <span className="text-xs font-semibold text-slate-400">Recent Node Payments</span>
            <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-1">
              {activeNodePayments.length === 0 ? (
                <span className="text-xs text-slate-500 italic">No recent payments logged</span>
              ) : (
                activeNodePayments.map((p, idx) => (
                  <div
                    key={`${p.txHash}-${idx}`}
                    className="flex items-center justify-between text-xs p-1.5 rounded bg-slate-950/40 border border-slate-800/80 font-mono"
                  >
                    <span
                      className={`text-[10px] px-1 rounded ${
                        p.from === activeNode.id
                          ? 'bg-rose-500/10 text-rose-400'
                          : 'bg-emerald-500/10 text-emerald-400'
                      }`}
                    >
                      {p.from === activeNode.id ? 'OUT' : 'IN'}
                    </span>
                    <span className="text-slate-300 font-semibold">
                      {p.amount.toLocaleString()} {p.asset}
                    </span>
                    <span className="text-slate-500 text-[10px]">
                      {p.from === activeNode.id ? `-> ${shortAddress(p.to)}` : `<- ${shortAddress(p.from)}`}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 flex items-center gap-4 bg-slate-900/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-800 text-xs text-slate-400">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-sky-500" />
          <span>Monitored Wallet</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-purple-500" />
          <span>Contract / Pool</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
          <span>External Account</span>
        </div>
      </div>
    </div>
  );
};

export default MoneyFlowGraph;
