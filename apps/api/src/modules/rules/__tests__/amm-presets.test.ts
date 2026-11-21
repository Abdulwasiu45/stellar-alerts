import { describe, expect, it } from 'vitest';
import { ruleCompiler } from '../../../lib/rules-engine/compiler';
import { rulesService } from '../rules.service';
import {
  ammContractPresets,
  ammRulePresets,
  type AmmProtocol,
} from '../presets/amm-presets';

describe('AMM rule presets', () => {
  it('generates valid rule schema objects for every protocol, network, and event', () => {
    expect(ammRulePresets.length).toBeGreaterThan(0);

    for (const preset of ammRulePresets) {
      expect(preset.ruleDraft.name).toBeTruthy();
      expect(preset.ruleDraft.conditions.operator).toBe('AND');
      expect(preset.ruleDraft.conditions.sorobanTopic.patterns).toBeDefined();
      expect(preset.ruleDraft.conditions.sorobanTopic.patterns?.length).toBeGreaterThan(0);
      expect(() => ruleCompiler.compile(preset.ruleDraft.conditions, `preset-${preset.id}`)).not.toThrow();
    }
  });

  it('includes swap, deposit, and withdrawal presets for all supported protocols and networks', () => {
    const protocols: AmmProtocol[] = ['soroswap', 'phoenix', 'aqua'];
    const networks = ['mainnet', 'testnet'] as const;
    const eventKinds = ['swap', 'liquidityDeposit', 'liquidityWithdrawal'] as const;

    for (const protocol of protocols) {
      for (const network of networks) {
        for (const eventKind of eventKinds) {
          expect(
            ammRulePresets.some(
              (preset) =>
                preset.protocol === protocol &&
                preset.network === network &&
                preset.eventKind === eventKind,
            ),
          ).toBe(true);
        }
      }
    }
  });

  it('prefills contract addresses and topic decoders for every AMM deployment', () => {
    for (const contract of ammContractPresets) {
      const preset = ammRulePresets.find(
        (candidate) => candidate.protocol === contract.protocol && candidate.network === contract.network,
      );

      expect(preset).toBeDefined();
      expect(preset?.addresses).toEqual(contract.addresses);
      expect(preset?.topicPosition).toBe(contract.decoder.topicPosition);
      expect(preset?.topicPatterns.length).toBeGreaterThan(0);
    }
  });

  it('sets a 1000-unit threshold on swap presets only', () => {
    const swaps = ammRulePresets.filter((preset) => preset.eventKind === 'swap');
    const deposits = ammRulePresets.filter((preset) => preset.eventKind === 'liquidityDeposit');

    expect(swaps.every((preset) => preset.minAmount === 1000)).toBe(true);
    expect(deposits.every((preset) => preset.minAmount === null)).toBe(true);
  });

  it('filters presets through RulesService', () => {
    const filtered = rulesService.listPresets({ protocol: 'phoenix', network: 'testnet' });

    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((preset) => preset.protocol === 'phoenix' && preset.network === 'testnet')).toBe(true);
  });
});
