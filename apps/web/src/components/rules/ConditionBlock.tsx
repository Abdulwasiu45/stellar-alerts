'use client';

import React from 'react';

export type RuleField = 'amount' | 'asset' | 'sender' | 'memo' | 'contractId';
export type RuleOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';

export interface RuleCondition {
  id: string;
  field: RuleField;
  operator: RuleOperator;
  value: string;
}

export interface ConditionBlockProps {
  condition: RuleCondition;
  index: number;
  groupId: string;
  isDragging?: boolean;
  onUpdate: (updated: RuleCondition) => void;
  onDelete: (id: string) => void;
  onDuplicate: (condition: RuleCondition) => void;
  onDragStart: (e: React.DragEvent, id: string, index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, targetIndex: number) => void;
  onDragEnd: () => void;
}

export const FIELD_OPTIONS: { value: RuleField; label: string; description: string }[] = [
  { value: 'amount', label: 'Payment Amount', description: 'Transaction value in XLM or custom token' },
  { value: 'asset', label: 'Asset Code', description: 'Stellar asset code e.g. XLM, USDC, AQUA' },
  { value: 'sender', label: 'Sender Address', description: 'Stellar public key (G... address)' },
  { value: 'memo', label: 'Transaction Memo', description: 'Memo text or ID hash string' },
  { value: 'contractId', label: 'Soroban Contract', description: 'Smart contract C... identifier' },
];

export const OPERATORS_BY_FIELD: Record<RuleField, { value: RuleOperator; label: string }[]> = {
  amount: [
    { value: 'gt', label: '> (Greater than)' },
    { value: 'gte', label: '≥ (Greater or equal)' },
    { value: 'lt', label: '< (Less than)' },
    { value: 'lte', label: '≤ (Less or equal)' },
    { value: 'eq', label: '= (Equal to)' },
    { value: 'neq', label: '≠ (Not equal to)' },
  ],
  asset: [
    { value: 'eq', label: '= (Is asset)' },
    { value: 'neq', label: '≠ (Is not asset)' },
    { value: 'in', label: 'in (Any of comma-separated)' },
  ],
  sender: [
    { value: 'eq', label: '= (Is address)' },
    { value: 'neq', label: '≠ (Is not address)' },
    { value: 'contains', label: 'contains (Substring)' },
    { value: 'in', label: 'in (Any of comma-separated)' },
  ],
  memo: [
    { value: 'eq', label: '= (Exact match)' },
    { value: 'neq', label: '≠ (Does not match)' },
    { value: 'contains', label: 'contains (Substring)' },
  ],
  contractId: [
    { value: 'eq', label: '= (Is contract)' },
    { value: 'neq', label: '≠ (Not contract)' },
    { value: 'contains', label: 'contains (Substring)' },
  ],
};

export const ConditionBlock: React.FC<ConditionBlockProps> = ({
  condition,
  index,
  groupId,
  isDragging = false,
  onUpdate,
  onDelete,
  onDuplicate,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) => {
  const availableOperators = OPERATORS_BY_FIELD[condition.field] || OPERATORS_BY_FIELD.amount;

  const handleFieldChange = (newField: RuleField) => {
    const validOps = OPERATORS_BY_FIELD[newField];
    const operatorStillValid = validOps.some((op) => op.value === condition.operator);
    onUpdate({
      ...condition,
      field: newField,
      operator: operatorStillValid ? condition.operator : validOps[0].value,
    });
  };

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, condition.id, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      onDragEnd={onDragEnd}
      data-testid={`condition-block-${condition.id}`}
      className={`group relative flex flex-wrap sm:flex-nowrap items-center gap-3 p-3.5 rounded-2xl border transition-all duration-200 select-none ${
        isDragging
          ? 'bg-cyan-950/40 border-cyan-500/60 opacity-60 shadow-[0_0_20px_rgba(6,182,212,0.3)]'
          : 'bg-[#0f111a]/90 hover:bg-[#141724] border-white/10 hover:border-cyan-500/40 shadow-sm'
      }`}
    >
      {/* Drag Grip Handle */}
      <div
        className="cursor-grab active:cursor-grabbing text-gray-500 hover:text-cyan-400 p-1 rounded transition-colors shrink-0"
        title="Drag to reorder condition"
        aria-label="Drag to reorder"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M4 16h16" />
        </svg>
      </div>

      {/* Field Selector */}
      <div className="w-full sm:w-44 shrink-0">
        <label className="sr-only">Field</label>
        <select
          value={condition.field}
          onChange={(e) => handleFieldChange(e.target.value as RuleField)}
          className="w-full px-3 py-1.5 rounded-xl bg-[#090a10] border border-white/10 text-xs font-semibold text-gray-200 focus:outline-none focus:border-cyan-400"
          aria-label="Select field"
        >
          {FIELD_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Operator Selector */}
      <div className="w-full sm:w-40 shrink-0">
        <label className="sr-only">Operator</label>
        <select
          value={condition.operator}
          onChange={(e) => onUpdate({ ...condition, operator: e.target.value as RuleOperator })}
          className="w-full px-3 py-1.5 rounded-xl bg-[#090a10] border border-white/10 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-400"
          aria-label="Select operator"
        >
          {availableOperators.map((op) => (
            <option key={op.value} value={op.value}>
              {op.label}
            </option>
          ))}
        </select>
      </div>

      {/* Value Input */}
      <div className="flex-1 min-w-[160px]">
        <label className="sr-only">Condition value</label>
        <input
          type={condition.field === 'amount' ? 'number' : 'text'}
          placeholder={
            condition.field === 'amount'
              ? 'e.g. 5000'
              : condition.field === 'asset'
              ? 'e.g. USDC or XLM'
              : condition.field === 'sender'
              ? 'e.g. GAB...'
              : 'Filter value...'
          }
          value={condition.value}
          onChange={(e) => onUpdate({ ...condition, value: e.target.value })}
          className="w-full px-3 py-1.5 rounded-xl bg-[#090a10] border border-white/10 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-cyan-400 font-mono"
          aria-label="Condition value"
        />
      </div>

      {/* Quick Actions (Duplicate & Delete) */}
      <div className="flex items-center gap-1 shrink-0 ml-auto sm:ml-0">
        <button
          type="button"
          onClick={() => onDuplicate(condition)}
          title="Duplicate condition"
          aria-label="Duplicate condition"
          className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onDelete(condition.id)}
          title="Delete condition"
          aria-label="Delete condition"
          className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  );
};
