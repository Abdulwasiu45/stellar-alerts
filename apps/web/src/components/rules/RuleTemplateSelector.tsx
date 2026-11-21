'use client';

import React, { useEffect, useMemo, useState } from 'react';

export type AmmProtocol = 'soroswap' | 'phoenix' | 'aqua';
export type AmmNetwork = 'mainnet' | 'testnet';
export type AmmEventKind = 'swap' | 'liquidityDeposit' | 'liquidityWithdrawal' | 'poolCreated';

export interface AmmContractAddresses {
  routerContractId?: string;
  factoryContractId?: string;
  multihopContractId?: string;
  poolContractIds: string[];
}

export interface AmmRuleDraft {
  name: string;
  assets: string[];
  minAmount: number | string | null;
  maxAmount: number | string | null;
  channels: string[];
  isActive: boolean;
  conditions: unknown;
}

export interface AmmRulePreset {
  id: string;
  name: string;
  description: string;
  protocol: AmmProtocol;
  network: AmmNetwork;
  eventKind: AmmEventKind;
  addresses: AmmContractAddresses;
  topicPatterns: readonly string[];
  topicPosition: number;
  minAmount: number | string | null;
  ruleDraft: AmmRuleDraft;
}

export interface RuleTemplateSelectorProps {
  onSelect?: (preset: AmmRulePreset) => void;
  defaultNetwork?: AmmNetwork;
  defaultProtocol?: AmmProtocol | 'all';
  className?: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export function RuleTemplateSelector({
  onSelect,
  defaultNetwork = 'mainnet',
  defaultProtocol = 'all',
  className,
}: RuleTemplateSelectorProps) {
  const [presets, setPresets] = useState<AmmRulePreset[]>([]);
  const [protocol, setProtocol] = useState<AmmProtocol | 'all'>(defaultProtocol);
  const [network, setNetwork] = useState<AmmNetwork>(defaultNetwork);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadPresets() {
      try {
        setIsLoading(true);
        const response = await fetch(`${API_URL}/rules/presets`, {
          credentials: 'include',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Unable to load rule presets (${response.status})`);
        }

        const data = (await response.json()) as { presets?: AmmRulePreset[] };
        setPresets(Array.isArray(data.presets) ? data.presets : []);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load rule presets');
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadPresets();
    return () => controller.abort();
  }, []);

  const visiblePresets = useMemo(
    () =>
      presets.filter(
        (preset) =>
          (protocol === 'all' || preset.protocol === protocol) && preset.network === network,
      ),
    [presets, protocol, network],
  );

  return (
    <section className={className} aria-labelledby="rule-template-selector-title">
      <h2 id="rule-template-selector-title">AMM rule templates</h2>
      <div>
        <label htmlFor="rule-template-protocol">Protocol</label>
        <select
          id="rule-template-protocol"
          value={protocol}
          onChange={(event) => setProtocol(event.target.value as AmmProtocol | 'all')}
        >
          <option value="all">All protocols</option>
          <option value="soroswap">Soroswap</option>
          <option value="phoenix">Phoenix</option>
          <option value="aqua">Aqua</option>
        </select>
      </div>
      <div>
        <label htmlFor="rule-template-network">Network</label>
        <select
          id="rule-template-network"
          value={network}
          onChange={(event) => setNetwork(event.target.value as AmmNetwork)}
        >
          <option value="mainnet">Mainnet</option>
          <option value="testnet">Testnet</option>
        </select>
      </div>

      {error ? <p role="alert">{error}</p> : null}
      {isLoading ? <p>Loading rule templates…</p> : null}
      {!isLoading && !error && visiblePresets.length === 0 ? <p>No templates available.</p> : null}

      <ul>
        {visiblePresets.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              onClick={() => onSelect?.(preset)}
              aria-label={`Use ${preset.name} template`}
            >
              <strong>{preset.name}</strong>
              <span>{preset.description}</span>
              <span>Topics: {preset.topicPatterns.join(', ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default RuleTemplateSelector;
