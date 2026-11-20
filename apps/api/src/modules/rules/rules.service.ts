import {
  ammRulePresets,
  type AmmNetwork,
  type AmmProtocol,
  type AmmRulePreset,
} from './presets/amm-presets';

export interface ListRulePresetsQuery {
  protocol?: AmmProtocol;
  network?: AmmNetwork;
  eventKind?: AmmRulePreset['eventKind'];
}

export class RulesService {
  listPresets(query: ListRulePresetsQuery = {}): readonly AmmRulePreset[] {
    return ammRulePresets.filter((preset) => {
      if (query.protocol && preset.protocol !== query.protocol) return false;
      if (query.network && preset.network !== query.network) return false;
      if (query.eventKind && preset.eventKind !== query.eventKind) return false;
      return true;
    });
  }

  getPreset(id: string): AmmRulePreset | undefined {
    return ammRulePresets.find((preset) => preset.id === id);
  }
}

export const rulesService = new RulesService();
