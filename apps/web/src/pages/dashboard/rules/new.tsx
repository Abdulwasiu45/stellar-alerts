import React from 'react';
import Head from 'next/head';
import { VisualRuleBuilder, RuleASTSchema } from '@/components/rules/VisualRuleBuilder';

export default function NewRulePage() {
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
    <>
      <Head>
        <title>New Alert Rule | StellarAlerts</title>
      </Head>
      <div className="min-h-screen bg-[#050508] text-gray-100 p-6 max-w-7xl mx-auto">
        <VisualRuleBuilder onSave={handleSave} />
      </div>
    </>
  );
}
