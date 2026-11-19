'use client';

import React, { useState, useMemo } from 'react';
import {
  unpackScVal,
  FormattedScVal,
  ScValType,
} from '../../utils/soroban-formatter';

export interface SorobanEventData {
  contractId?: string;
  topics?: any[];
  data?: any;
  ledger?: number;
  txHash?: string;
  timestamp?: string | number;
  [key: string]: any;
}

export interface SorobanEventInspectorProps {
  event?: SorobanEventData | any;
  initialExpandedDepth?: number;
}

// Badge color styles per type
const TYPE_BADGE_STYLES: Record<ScValType, string> = {
  Symbol: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Address: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  i128: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  u128: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  i64: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  u64: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  i32: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  u32: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  Vec: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  Map: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  Bytes: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  String: 'bg-slate-500/10 text-slate-300 border-slate-500/20',
  Bool: 'bg-pink-500/10 text-pink-400 border-pink-500/20',
  Void: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  Object: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  Unknown: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
};

// Copy button with feedback
const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy value"
      className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors border border-slate-700/60 font-mono"
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
};

// Single tree node component (recursive)
interface TreeNodeProps {
  label?: string | number;
  node: FormattedScVal;
  depth: number;
  filter: string;
  initialExpandedDepth: number;
}

const TreeNode: React.FC<TreeNodeProps> = ({
  label,
  node,
  depth,
  filter,
  initialExpandedDepth,
}) => {
  const hasChildren = Boolean(node.children && node.children.length > 0);
  const [isExpanded, setIsExpanded] = useState<boolean>(depth < initialExpandedDepth);
  const [showRawInt, setShowRawInt] = useState(false);

  // Search filter matching
  const isMatch = useMemo(() => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    const labelMatch = label !== undefined && String(label).toLowerCase().includes(q);
    const valueMatch = node.formattedValue.toLowerCase().includes(q);
    const decimalMatch = node.decimalFormatted
      ? node.decimalFormatted.toLowerCase().includes(q)
      : false;
    return labelMatch || valueMatch || decimalMatch;
  }, [filter, label, node]);

  // Check if any child matches filter
  const hasChildMatch = useMemo(() => {
    if (!filter || !hasChildren || !node.children) return false;
    const checkMatch = (item: FormattedScVal): boolean => {
      const q = filter.toLowerCase();
      if (item.formattedValue.toLowerCase().includes(q)) return true;
      if (item.decimalFormatted?.toLowerCase().includes(q)) return true;
      if (item.children) {
        return item.children.some(
          (c) => String(c.key).toLowerCase().includes(q) || checkMatch(c.value)
        );
      }
      return false;
    };
    return node.children.some(
      (c) => String(c.key).toLowerCase().includes(filter.toLowerCase()) || checkMatch(c.value)
    );
  }, [filter, hasChildren, node.children]);

  // If filter is active and neither this nor children match, hide node
  if (filter && !isMatch && !hasChildMatch) {
    return null;
  }

  // Auto-expand node when child matches search filter
  const expanded = filter ? (hasChildMatch ? true : isExpanded) : isExpanded;

  const badgeStyle = TYPE_BADGE_STYLES[node.type] || TYPE_BADGE_STYLES.Unknown;

  return (
    <div className="flex flex-col text-xs font-mono select-text">
      {/* Node Header Row */}
      <div
        onClick={() => hasChildren && setIsExpanded(!isExpanded)}
        className={`flex items-center gap-2 py-1 px-2 rounded hover:bg-slate-800/60 transition-colors ${
          hasChildren ? 'cursor-pointer' : 'cursor-default'
        } ${isMatch && filter ? 'bg-amber-500/10 border-l-2 border-amber-400' : ''}`}
      >
        {/* Expand / Collapse Chevron */}
        <span className="w-4 text-center text-slate-500 select-none">
          {hasChildren ? (expanded ? '▼' : '▶') : '•'}
        </span>

        {/* Key / Property Label */}
        {label !== undefined && (
          <span className="text-slate-300 font-semibold">{String(label)}:</span>
        )}

        {/* Type Badge */}
        <span
          className={`text-[10px] px-1.5 py-0.2 rounded border font-semibold tracking-wide uppercase ${badgeStyle}`}
        >
          {node.type}
        </span>

        {/* Value Display */}
        {!hasChildren && (
          <div className="flex items-center gap-2 flex-wrap">
            {node.decimalFormatted ? (
              <div className="flex items-center gap-1.5">
                <span className="text-emerald-300 font-medium">
                  {showRawInt ? node.formattedValue : node.decimalFormatted}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowRawInt(!showRawInt);
                  }}
                  className="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-slate-400 hover:text-slate-200"
                >
                  {showRawInt ? 'Show Decimals' : 'Show Raw'}
                </button>
              </div>
            ) : (
              <span
                className={`break-all ${
                  node.type === 'Address'
                    ? 'text-sky-300'
                    : node.type === 'Symbol'
                    ? 'text-purple-300'
                    : 'text-slate-200'
                }`}
              >
                {node.formattedValue}
              </span>
            )}

            <CopyButton
              text={
                node.decimalFormatted && !showRawInt
                  ? node.decimalFormatted
                  : node.formattedValue
              }
            />
          </div>
        )}

        {/* Container Size indicator for Vec/Map */}
        {hasChildren && (
          <span className="text-slate-500 text-[11px]">{node.formattedValue}</span>
        )}
      </div>

      {/* Children Container */}
      {hasChildren && expanded && node.children && (
        <div className="pl-5 border-l border-slate-800/80 ml-3 flex flex-col gap-0.5 my-0.5">
          {node.children.map((child, idx) => (
            <TreeNode
              key={`${child.key}-${idx}`}
              label={child.key}
              node={child.value}
              depth={depth + 1}
              filter={filter}
              initialExpandedDepth={initialExpandedDepth}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const SorobanEventInspector: React.FC<SorobanEventInspectorProps> = ({
  event,
  initialExpandedDepth = 2,
}) => {
  const [filter, setFilter] = useState('');
  const [activeTab, setActiveTab] = useState<'tree' | 'raw'>('tree');

  // Format topics and data recursively
  const unpackedTopics = useMemo(() => {
    if (!event?.topics) return [];
    return (Array.isArray(event.topics) ? event.topics : [event.topics]).map((t: any) =>
      unpackScVal(t)
    );
  }, [event?.topics]);

  const unpackedData = useMemo(() => {
    if (event?.data === undefined) return null;
    return unpackScVal(event.data);
  }, [event?.data]);

  // Overall event AST
  const unpackedRoot = useMemo(() => {
    if (!event) return null;
    return unpackScVal(event);
  }, [event]);

  if (!event) {
    return (
      <div className="p-8 text-center text-slate-500 border border-slate-800 rounded-xl bg-slate-950 font-mono text-sm">
        No Soroban contract event loaded
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col rounded-xl border border-slate-800 bg-slate-950 overflow-hidden shadow-2xl font-sans">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/90 px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-500 animate-pulse" />
            <span className="text-sm font-semibold text-white">Soroban Event AST Inspector</span>
          </div>
          {event.contractId && (
            <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
              Contract: {String(event.contractId).slice(0, 8)}...{String(event.contractId).slice(-6)}
            </span>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* Search / Filter input */}
          <input
            type="text"
            placeholder="Search keys, values, types..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-xs px-3 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono w-48 sm:w-64"
          />

          {/* View Mode Toggle */}
          <div className="flex items-center bg-slate-800 rounded-md p-0.5 border border-slate-700">
            <button
              onClick={() => setActiveTab('tree')}
              className={`text-xs px-2.5 py-1 rounded font-medium transition-colors ${
                activeTab === 'tree'
                  ? 'bg-purple-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Tree View
            </button>
            <button
              onClick={() => setActiveTab('raw')}
              className={`text-xs px-2.5 py-1 rounded font-medium transition-colors ${
                activeTab === 'raw'
                  ? 'bg-purple-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Raw JSON
            </button>
          </div>

          <CopyButton text={JSON.stringify(event, null, 2)} />
        </div>
      </div>

      {/* Main Content Area */}
      <div className="p-4 overflow-x-auto min-h-[300px] max-h-[650px] overflow-y-auto">
        {activeTab === 'raw' ? (
          <pre className="text-xs font-mono text-slate-300 bg-slate-900/60 p-4 rounded-lg border border-slate-800/80 overflow-x-auto">
            {JSON.stringify(event, null, 2)}
          </pre>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Metadata Header (if present) */}
            {(event.txHash || event.ledger) && (
              <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-slate-400 bg-slate-900/40 p-2.5 rounded-lg border border-slate-800">
                {event.ledger && (
                  <div>
                    <span className="text-slate-500">Ledger:</span>{' '}
                    <span className="text-slate-200">{event.ledger}</span>
                  </div>
                )}
                {event.txHash && (
                  <div>
                    <span className="text-slate-500">Tx:</span>{' '}
                    <span className="text-slate-200">{event.txHash}</span>
                  </div>
                )}
                {event.timestamp && (
                  <div>
                    <span className="text-slate-500">Time:</span>{' '}
                    <span className="text-slate-200">{String(event.timestamp)}</span>
                  </div>
                )}
              </div>
            )}

            {/* Topics Section */}
            {unpackedTopics.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Topics ({unpackedTopics.length})
                </span>
                <div className="bg-slate-900/40 p-2 rounded-lg border border-slate-800 flex flex-col gap-1">
                  {unpackedTopics.map((topicNode, idx) => (
                    <TreeNode
                      key={`topic-${idx}`}
                      label={`topic[${idx}]`}
                      node={topicNode}
                      depth={0}
                      filter={filter}
                      initialExpandedDepth={initialExpandedDepth}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Event Data Section */}
            {unpackedData ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Event Data
                </span>
                <div className="bg-slate-900/40 p-2 rounded-lg border border-slate-800">
                  <TreeNode
                    label="data"
                    node={unpackedData}
                    depth={0}
                    filter={filter}
                    initialExpandedDepth={initialExpandedDepth}
                  />
                </div>
              </div>
            ) : unpackedRoot ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Contract Event Structure
                </span>
                <div className="bg-slate-900/40 p-2 rounded-lg border border-slate-800">
                  <TreeNode
                    label="root"
                    node={unpackedRoot}
                    depth={0}
                    filter={filter}
                    initialExpandedDepth={initialExpandedDepth}
                  />
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

export default SorobanEventInspector;
