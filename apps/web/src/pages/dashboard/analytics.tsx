import React, { useState } from 'react';
import MoneyFlowGraph from '../../components/analytics/MoneyFlowGraph';
import type { GraphPayment } from '../../lib/graph/forceGraph';

// Sample treasury cluster payment flows for demonstration and default viewing
const INITIAL_SAMPLE_PAYMENTS: GraphPayment[] = [
  {
    txHash: 'tx_flow_001',
    from: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    to: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
    amount: 15420,
    asset: 'XLM',
    at: Date.now() - 1000 * 60 * 12,
  },
  {
    txHash: 'tx_flow_002',
    from: 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
    to: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    amount: 10000,
    asset: 'USDC',
    at: Date.now() - 1000 * 60 * 8,
  },
  {
    txHash: 'tx_flow_003',
    from: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    to: 'GCKFJ7V65W7KDP47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAUSD',
    amount: 9850,
    asset: 'USDC',
    at: Date.now() - 1000 * 60 * 5,
  },
  {
    txHash: 'tx_flow_004',
    from: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    to: 'GCKFJ7V65W7KDP47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAUSD',
    amount: 2500,
    asset: 'AQUA',
    at: Date.now() - 1000 * 60 * 2,
  },
  {
    txHash: 'tx_flow_005',
    from: 'GCKFJ7V65W7KDP47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAUSD',
    to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    amount: 1200,
    asset: 'EURC',
    at: Date.now() - 1000 * 30,
  },
];

const MONITORED_TREASURY_WALLETS = [
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A',
];

export default function AnalyticsDashboardPage() {
  const [payments] = useState<GraphPayment[]>(INITIAL_SAMPLE_PAYMENTS);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-8 flex flex-col gap-6">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Multi-Account Money Flow Analytics
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Real-time interactive WebGL/Canvas force-directed network graph tracking multi-hop fund routing and counterparty clusters.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Live Ingestion Active
          </span>
        </div>
      </div>

      {/* Main Graph Card */}
      <div className="flex flex-col gap-2">
        <MoneyFlowGraph
          payments={payments}
          monitoredWallets={MONITORED_TREASURY_WALLETS}
          height={650}
        />
      </div>
    </div>
  );
}
