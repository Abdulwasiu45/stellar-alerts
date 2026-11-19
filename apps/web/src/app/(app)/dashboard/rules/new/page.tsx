'use client';

import React from 'react';
import { VisualRuleBuilder, RuleASTSchema } from '@/components/rules/VisualRuleBuilder';

export default function NewRuleAppPage() {
  const handleSave = async (ast: RuleASTSchema) => {
    try {
      const response = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ast),
      });
      if (response.ok) {
        alert('Alert rule saved successfully!');
      }
    } catch (err) {
      console.error('Failed to save rule:', err);
    }
  };

  return (
    <div className="space-y-6">
      <VisualRuleBuilder onSave={handleSave} />
    </div>
  );
}
