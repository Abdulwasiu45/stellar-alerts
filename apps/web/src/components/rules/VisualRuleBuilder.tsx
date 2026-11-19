'use client';

import React, { useState, useId } from 'react';
import {
  ConditionBlock,
  RuleCondition,
  RuleField,
  RuleOperator,
  FIELD_OPTIONS,
} from './ConditionBlock';

export type LogicalOperator = 'AND' | 'OR';

export interface ConditionGroup {
  id: string;
  type: 'group';
  logic: LogicalOperator;
  children: (RuleCondition | ConditionGroup)[];
}

export interface RuleASTSchema {
  version: '1.0';
  title?: string;
  description?: string;
  root: ConditionGroup;
  createdAt?: string;
}

export interface DryRunTransaction {
  id: string;
  txHash: string;
  fromAddress: string;
  amount: number;
  asset: string;
  memo: string;
  contractId?: string;
  timestamp: string;
}

export interface DryRunResult {
  totalScanned: number;
  matchedCount: number;
  matchRatePercent: number;
  executionTimeMs: number;
  matchedTransactions: DryRunTransaction[];
}

export interface VisualRuleBuilderProps {
  initialSchema?: RuleASTSchema;
  onSave?: (schema: RuleASTSchema) => void;
  onDryRun?: (schema: RuleASTSchema) => Promise<DryRunResult>;
}

let counter = 0;
const uid = (prefix = 'item') => `${prefix}-${Date.now()}-${counter++}`;

const createDefaultCondition = (): RuleCondition => ({
  id: uid('cond'),
  field: 'amount',
  operator: 'gt',
  value: '1000',
});

const createDefaultGroup = (logic: LogicalOperator = 'AND'): ConditionGroup => ({
  id: uid('grp'),
  type: 'group',
  logic,
  children: [createDefaultCondition()],
});

// Helper: evaluate a single condition against a mock or real transaction
export function evaluateCondition(cond: RuleCondition, tx: DryRunTransaction): boolean {
  if (!cond.value) return false;

  switch (cond.field) {
    case 'amount': {
      const target = Number(cond.value);
      const actual = tx.amount;
      if (Number.isNaN(target)) return false;
      if (cond.operator === 'gt') return actual > target;
      if (cond.operator === 'gte') return actual >= target;
      if (cond.operator === 'lt') return actual < target;
      if (cond.operator === 'lte') return actual <= target;
      if (cond.operator === 'eq') return actual === target;
      if (cond.operator === 'neq') return actual !== target;
      return false;
    }
    case 'asset': {
      const target = cond.value.toUpperCase().trim();
      const actual = tx.asset.toUpperCase().trim();
      if (cond.operator === 'eq') return actual === target;
      if (cond.operator === 'neq') return actual !== target;
      if (cond.operator === 'in') {
        const allowed = target.split(',').map((s) => s.trim());
        return allowed.includes(actual);
      }
      return false;
    }
    case 'sender': {
      const target = cond.value.toLowerCase().trim();
      const actual = tx.fromAddress.toLowerCase().trim();
      if (cond.operator === 'eq') return actual === target;
      if (cond.operator === 'neq') return actual !== target;
      if (cond.operator === 'contains') return actual.includes(target);
      if (cond.operator === 'in') {
        const allowed = target.split(',').map((s) => s.trim());
        return allowed.includes(actual);
      }
      return false;
    }
    case 'memo': {
      const target = cond.value.toLowerCase().trim();
      const actual = (tx.memo || '').toLowerCase().trim();
      if (cond.operator === 'eq') return actual === target;
      if (cond.operator === 'neq') return actual !== target;
      if (cond.operator === 'contains') return actual.includes(target);
      return false;
    }
    case 'contractId': {
      const target = cond.value.toLowerCase().trim();
      const actual = (tx.contractId || '').toLowerCase().trim();
      if (cond.operator === 'eq') return actual === target;
      if (cond.operator === 'neq') return actual !== target;
      if (cond.operator === 'contains') return actual.includes(target);
      return false;
    }
    default:
      return false;
  }
}

// Helper: evaluate an entire group
export function evaluateGroup(group: ConditionGroup, tx: DryRunTransaction): boolean {
  if (group.children.length === 0) return true;

  if (group.logic === 'AND') {
    return group.children.every((child) =>
      'type' in child ? evaluateGroup(child, tx) : evaluateCondition(child, tx)
    );
  } else {
    return group.children.some((child) =>
      'type' in child ? evaluateGroup(child, tx) : evaluateCondition(child, tx)
    );
  }
}

// Mock 1,000 Stellar ledger transactions for realistic dry-run simulation
export function generateMockLedgerTransactions(count = 1000): DryRunTransaction[] {
  const assets = ['XLM', 'USDC', 'EURC', 'AQUA', 'yXLM', 'BTC'];
  const sampleAddresses = [
    'GDV4...8X9M',
    'GB7B...3LK2',
    'GCFX...99OP',
    'GA2C...V74N',
    'GA5Z...8LPL',
  ];
  const txs: DryRunTransaction[] = [];

  for (let i = 0; i < count; i++) {
    const isWhale = i % 40 === 0;
    const isMedium = i % 8 === 0;
    const amount = isWhale
      ? Math.round(10000 + Math.random() * 90000)
      : isMedium
      ? Math.round(500 + Math.random() * 4500)
      : Math.round(1 + Math.random() * 499);

    const asset = assets[i % assets.length];
    const fromAddress = sampleAddresses[i % sampleAddresses.length];

    txs.push({
      id: `tx-${i + 1}`,
      txHash: `4e9b${i}a${(i * 997).toString(16).padStart(8, '0')}f78`,
      fromAddress,
      amount,
      asset,
      memo: i % 5 === 0 ? 'Monthly payroll deposit' : i % 3 === 0 ? 'DeFi swap' : '',
      contractId: i % 10 === 0 ? 'CCWV...98AZ' : undefined,
      timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
    });
  }
  return txs;
}

export const VisualRuleBuilder: React.FC<VisualRuleBuilderProps> = ({
  initialSchema,
  onSave,
  onDryRun,
}) => {
  const [ruleTitle, setRuleTitle] = useState(initialSchema?.title || 'High-Value Payment Alert');
  const [ruleDescription, setRuleDescription] = useState(
    initialSchema?.description || 'Triggers when a transaction matches threshold criteria'
  );
  const [rootGroup, setRootGroup] = useState<ConditionGroup>(
    initialSchema?.root || createDefaultGroup('AND')
  );

  // Drag and drop state
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Modals & Drawers
  const [isDryRunOpen, setIsDryRunOpen] = useState(false);
  const [isJsonModalOpen, setIsJsonModalOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Dry run state
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);

  // Group & Condition Management functions
  const updateGroupInTree = (
    current: ConditionGroup,
    targetGroupId: string,
    transform: (g: ConditionGroup) => ConditionGroup
  ): ConditionGroup => {
    if (current.id === targetGroupId) {
      return transform(current);
    }
    return {
      ...current,
      children: current.children.map((child) => {
        if ('type' in child && child.type === 'group') {
          return updateGroupInTree(child, targetGroupId, transform);
        }
        return child;
      }),
    };
  };

  const handleToggleLogic = (groupId: string) => {
    setRootGroup((prev) =>
      updateGroupInTree(prev, groupId, (g) => ({
        ...g,
        logic: g.logic === 'AND' ? 'OR' : 'AND',
      }))
    );
  };

  const handleAddCondition = (groupId: string) => {
    setRootGroup((prev) =>
      updateGroupInTree(prev, groupId, (g) => ({
        ...g,
        children: [...g.children, createDefaultCondition()],
      }))
    );
  };

  const handleAddNestedGroup = (groupId: string) => {
    setRootGroup((prev) =>
      updateGroupInTree(prev, groupId, (g) => ({
        ...g,
        children: [...g.children, createDefaultGroup('OR')],
      }))
    );
  };

  const handleUpdateCondition = (groupId: string, updated: RuleCondition) => {
    setRootGroup((prev) =>
      updateGroupInTree(prev, groupId, (g) => ({
        ...g,
        children: g.children.map((item) => (item.id === updated.id ? updated : item)),
      }))
    );
  };

  const handleDeleteItem = (groupId: string, itemId: string) => {
    setRootGroup((prev) =>
      updateGroupInTree(prev, groupId, (g) => ({
        ...g,
        children: g.children.filter((item) => item.id !== itemId),
      }))
    );
  };

  const handleDuplicateCondition = (groupId: string, condition: RuleCondition) => {
    const clone: RuleCondition = {
      ...condition,
      id: uid('cond'),
    };
    setRootGroup((prev) =>
      updateGroupInTree(prev, groupId, (g) => ({
        ...g,
        children: [...g.children, clone],
      }))
    );
  };

  // Reorder inside a group
  const handleDragStart = (e: React.DragEvent, id: string, index: number) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ id, index }));
    setDraggingId(id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, groupId: string, targetIndex: number) => {
    e.preventDefault();
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (!data || data.index === undefined) return;

      setRootGroup((prev) =>
        updateGroupInTree(prev, groupId, (g) => {
          const newChildren = [...g.children];
          const [moved] = newChildren.splice(data.index, 1);
          if (moved) {
            newChildren.splice(targetIndex, 0, moved);
          }
          return { ...g, children: newChildren };
        })
      );
    } catch {
      // Ignore drop error
    } finally {
      setDraggingId(null);
    }
  };

  const handleDragEnd = () => {
    setDraggingId(null);
  };

  // Build JSON AST
  const generateAST = (): RuleASTSchema => ({
    version: '1.0',
    title: ruleTitle,
    description: ruleDescription,
    root: rootGroup,
    createdAt: new Date().toISOString(),
  });

  const handleOpenJsonModal = () => {
    setJsonText(JSON.stringify(generateAST(), null, 2));
    setJsonError(null);
    setIsJsonModalOpen(true);
  };

  const handleImportJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed.root || !Array.isArray(parsed.root.children)) {
        throw new Error('Invalid schema: Missing root condition group.');
      }
      setRootGroup(parsed.root);
      if (parsed.title) setRuleTitle(parsed.title);
      if (parsed.description) setRuleDescription(parsed.description);
      setIsJsonModalOpen(false);
      setJsonError(null);
    } catch (err: any) {
      setJsonError(err.message || 'Malformed JSON');
    }
  };

  // Dry run simulation
  const executeDryRun = async () => {
    setDryRunLoading(true);
    setIsDryRunOpen(true);
    const start = performance.now();

    try {
      if (onDryRun) {
        const result = await onDryRun(generateAST());
        setDryRunResult(result);
      } else {
        // Run against local 1,000 transaction testnet simulator
        await new Promise((r) => setTimeout(r, 200)); // brief UI tick
        const mockTxs = generateMockLedgerTransactions(1000);
        const matched = mockTxs.filter((tx) => evaluateGroup(rootGroup, tx));
        const duration = Math.round(performance.now() - start);

        setDryRunResult({
          totalScanned: 1000,
          matchedCount: matched.length,
          matchRatePercent: Number(((matched.length / 1000) * 100).toFixed(2)),
          executionTimeMs: duration,
          matchedTransactions: matched.slice(0, 50), // display top 50 in drawer
        });
      }
    } finally {
      setDryRunLoading(false);
    }
  };

  // Render recursive condition groups
  const renderGroup = (group: ConditionGroup, depth = 0): React.ReactNode => {
    const isRoot = depth === 0;

    return (
      <div
        key={group.id}
        data-testid={`group-${group.id}`}
        className={`rounded-2xl p-4 sm:p-5 transition-all ${
          isRoot
            ? 'bg-[#0b0c14] border border-cyan-500/20 shadow-xl'
            : 'bg-[#10121d] border border-white/10 ml-2 sm:ml-6 my-3 shadow-inner'
        }`}
      >
        {/* Group Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-white/5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold uppercase tracking-wider text-gray-400">
              {isRoot ? 'Root Condition Logic' : `Nested Group (Depth ${depth})`}
            </span>
            {/* Logic Toggle */}
            <div className="inline-flex rounded-xl bg-[#07080e] p-1 border border-white/10">
              <button
                type="button"
                onClick={() => handleToggleLogic(group.id)}
                className={`px-3 py-1 text-xs font-extrabold rounded-lg transition-all cursor-pointer ${
                  group.logic === 'AND'
                    ? 'bg-cyan-500 text-black shadow-[0_0_12px_rgba(6,182,212,0.4)]'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                AND (All Must Match)
              </button>
              <button
                type="button"
                onClick={() => handleToggleLogic(group.id)}
                className={`px-3 py-1 text-xs font-extrabold rounded-lg transition-all cursor-pointer ${
                  group.logic === 'OR'
                    ? 'bg-purple-500 text-white shadow-[0_0_12px_rgba(168,85,247,0.4)]'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                OR (Any May Match)
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isRoot && (
              <button
                type="button"
                onClick={() => handleDeleteItem(rootGroup.id, group.id)}
                className="px-2.5 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
              >
                Remove Group
              </button>
            )}
          </div>
        </div>

        {/* Children (Conditions or Sub-Groups) */}
        <div className="space-y-3">
          {group.children.map((child, index) => {
            if ('type' in child && child.type === 'group') {
              return renderGroup(child, depth + 1);
            }
            return (
              <ConditionBlock
                key={child.id}
                condition={child}
                index={index}
                groupId={group.id}
                isDragging={draggingId === child.id}
                onUpdate={(updated) => handleUpdateCondition(group.id, updated)}
                onDelete={(id) => handleDeleteItem(group.id, id)}
                onDuplicate={(cond) => handleDuplicateCondition(group.id, cond)}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={(e, targetIdx) => handleDrop(e, group.id, targetIdx)}
                onDragEnd={handleDragEnd}
              />
            );
          })}

          {group.children.length === 0 && (
            <div className="text-center py-6 border border-dashed border-white/10 rounded-xl text-gray-500 text-xs">
              No conditions in this block. Click "Add Condition" below.
            </div>
          )}
        </div>

        {/* Action Buttons: Add Condition / Add Group */}
        <div className="flex items-center gap-2 mt-4 pt-2">
          <button
            type="button"
            onClick={() => handleAddCondition(group.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-semibold transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            Add Condition
          </button>
          {depth < 2 && (
            <button
              type="button"
              onClick={() => handleAddNestedGroup(group.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/30 text-purple-300 text-xs font-semibold transition-colors cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              Add Nested Group
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header & Meta Settings */}
      <div className="bg-[#0b0c14] border border-white/10 rounded-3xl p-6 shadow-xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-cyan-400 animate-pulse"></span>
              Advanced Visual Rule Builder
            </h1>
            <p className="text-gray-400 text-xs mt-1">
              Assemble complex compound alerts with nested logic and testnet transaction verification.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleOpenJsonModal}
              className="px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-semibold text-gray-300 transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
              Import / Export JSON
            </button>

            <button
              type="button"
              onClick={executeDryRun}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500/20 to-orange-500/20 hover:from-amber-500/30 hover:to-orange-500/30 border border-amber-500/40 text-xs font-bold text-amber-200 transition-all shadow-[0_0_15px_rgba(245,158,11,0.2)] flex items-center gap-2 cursor-pointer"
            >
              <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Dry Run (1,000 Tx)
            </button>

            <button
              type="button"
              onClick={() => onSave?.(generateAST())}
              className="px-5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-extrabold transition-all shadow-[0_0_20px_rgba(6,182,212,0.4)] cursor-pointer"
            >
              Save Rule
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1">Rule Name</label>
            <input
              type="text"
              value={ruleTitle}
              onChange={(e) => setRuleTitle(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-[#07080e] border border-white/10 text-white text-sm focus:outline-none focus:border-cyan-400"
              placeholder="e.g. Whale Transfer Alert"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1">Description</label>
            <input
              type="text"
              value={ruleDescription}
              onChange={(e) => setRuleDescription(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-[#07080e] border border-white/10 text-white text-sm focus:outline-none focus:border-cyan-400"
              placeholder="Alert operational team on large transfers"
            />
          </div>
        </div>
      </div>

      {/* Visual Canvas Canvas */}
      <div className="space-y-4">
        {renderGroup(rootGroup, 0)}
      </div>

      {/* JSON Schema Export/Import Modal */}
      {isJsonModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="bg-[#0e101a] border border-white/10 rounded-2xl w-full max-w-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <h2 className="text-lg font-bold text-white">Rule AST Schema (JSON)</h2>
              <button
                type="button"
                onClick={() => setIsJsonModalOpen(false)}
                className="text-gray-400 hover:text-white cursor-pointer"
              >
                ✕
              </button>
            </div>

            {jsonError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300">
                {jsonError}
              </div>
            )}

            <textarea
              rows={12}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              className="w-full p-4 rounded-xl bg-[#07080e] border border-white/10 font-mono text-xs text-cyan-300 focus:outline-none focus:border-cyan-400 leading-relaxed"
            />

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(jsonText);
                }}
                className="px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-semibold text-gray-300 border border-white/10 cursor-pointer"
              >
                Copy to Clipboard
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsJsonModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-white/5 text-xs text-gray-400 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImportJson}
                  className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-xs font-bold text-black cursor-pointer"
                >
                  Apply JSON Schema
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Dry Run Simulation Drawer */}
      {isDryRunOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-xl h-full bg-[#0a0c16] border-l border-white/10 shadow-2xl flex flex-col p-6 overflow-hidden">
            <div className="flex items-center justify-between pb-4 border-b border-white/10 shrink-0">
              <div>
                <h2 className="text-lg font-extrabold text-white flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping"></span>
                  Live Dry-Run Simulator
                </h2>
                <p className="text-gray-400 text-xs mt-0.5">
                  Backtesting rule conditions against recent historical ledgers.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsDryRunOpen(false)}
                className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                ✕
              </button>
            </div>

            {dryRunLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                <div className="w-10 h-10 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-sm font-semibold text-gray-300">
                  Scanning 1,000 ledger transactions...
                </p>
              </div>
            ) : dryRunResult ? (
              <div className="flex-1 overflow-y-auto space-y-5 pt-4 pr-1">
                {/* Stats Summary Bar */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3.5 rounded-2xl bg-[#101322] border border-white/10">
                    <div className="text-[11px] uppercase tracking-wider text-gray-400">Scanned</div>
                    <div className="text-lg font-bold text-white mt-1">
                      {dryRunResult.totalScanned.toLocaleString()} Tx
                    </div>
                  </div>
                  <div className="p-3.5 rounded-2xl bg-cyan-950/30 border border-cyan-500/30">
                    <div className="text-[11px] uppercase tracking-wider text-cyan-400">Matched</div>
                    <div className="text-lg font-bold text-cyan-300 mt-1">
                      {dryRunResult.matchedCount}
                    </div>
                  </div>
                  <div className="p-3.5 rounded-2xl bg-[#101322] border border-white/10">
                    <div className="text-[11px] uppercase tracking-wider text-gray-400">Execution</div>
                    <div className="text-lg font-bold text-amber-300 mt-1 font-mono">
                      {dryRunResult.executionTimeMs} ms
                    </div>
                  </div>
                </div>

                <div className="p-3.5 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-between text-xs text-gray-300">
                  <span>Match Rate:</span>
                  <span className="font-mono font-bold text-cyan-400">
                    {dryRunResult.matchRatePercent}% of historical traffic
                  </span>
                </div>

                {/* Matched Transactions List */}
                <div className="space-y-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">
                    Matched Transactions Preview ({dryRunResult.matchedTransactions.length})
                  </h3>

                  {dryRunResult.matchedTransactions.length === 0 ? (
                    <div className="p-8 text-center border border-dashed border-white/10 rounded-2xl text-gray-500 text-xs">
                      No transactions in the sample set matched the specified criteria.
                    </div>
                  ) : (
                    dryRunResult.matchedTransactions.map((tx) => (
                      <div
                        key={tx.id}
                        className="p-3 rounded-xl bg-[#0e111d] border border-white/5 hover:border-cyan-500/30 transition-all text-xs space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-bold text-white">
                            {tx.amount.toLocaleString()} {tx.asset}
                          </span>
                          <span className="text-[11px] text-gray-500 font-mono">{tx.txHash}</span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-gray-400">
                          <span>From: {tx.fromAddress}</span>
                          <span>{new Date(tx.timestamp).toLocaleTimeString()}</span>
                        </div>
                        {tx.memo && (
                          <div className="text-[11px] text-gray-400 italic">
                            Memo: "{tx.memo}"
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            <div className="pt-4 border-t border-white/10 shrink-0">
              <button
                type="button"
                onClick={executeDryRun}
                className="w-full py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-extrabold text-xs transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)] cursor-pointer"
              >
                Re-run Simulation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
