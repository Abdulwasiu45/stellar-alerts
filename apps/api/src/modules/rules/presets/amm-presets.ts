import type { FilterRule, FilterRuleGroup } from '../../../lib/rules-engine';
import type { SorobanTopicRuleConfig } from '../../alerts/rules/soroban-topic.rule';

export type AmmProtocol = 'soroswap' | 'phoenix' | 'aqua';
export type AmmNetwork = 'mainnet' | 'testnet';
export type AmmEventKind = 'swap' | 'liquidityDeposit' | 'liquidityWithdrawal' | 'poolCreated';

export interface AmmContractAddresses {
  routerContractId?: string;
  factoryContractId?: string;
  multihopContractId?: string;
  poolContractIds: string[];
}

export interface AmmContractPreset {
  id: string;
  protocol: AmmProtocol;
  network: AmmNetwork;
  displayName: string;
  addresses: AmmContractAddresses;
  eventTopics: Record<AmmEventKind, readonly string[]>;
  decoder: {
    kind: 'scval-symbol';
    topicPosition: number;
    valueFieldHints: readonly string[];
  };
}

export interface AmmRuleDraft {
  name: string;
  assets: string[];
  minAmount: number | string | null;
  maxAmount: number | string | null;
  channels: string[];
  isActive: boolean;
  conditions: FilterRuleGroup & { sorobanTopic: SorobanTopicRuleConfig };
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

const PHOENIX_MAINNET_POOL_IDS = [
  'CAZ6W4WHVGQBGURYTUOLCUOOHW6VQGAAPSPCD72VEDZMBBPY7H43AYEC',
  'CBHCRSVX3ZZ7EGTSYMKPEFGZNWRVCSESQR3UABET4MIW52N4EVU6BIZX',
  'CBCZGGNOEUZG4CAAE7TGTQQHETZMKUT4OIPFHHPKEUX46U4KXBBZ3GLH',
  'CD5XNKK3B6BEF2N7ULNHHGAMOKZ7P6456BFNIHRF4WNTEDKBRWAE7IAA',
  'CBISULYO5ZGS32WTNCBMEFCNKNSLFXCQ4Z3XHVDP4X4FLPSEALGSY3PS',
  'CDMXKSLG5GITGFYERUW2MRYOBUQCMRT2QE5Y4PU3QZ53EBFWUXAXUTBC',
  'CB5QUVK5GS3IU23TMFZQ3P5J24YBBZP5PHUQAEJ2SP5K55PFTJRUQG2L',
  'CC6MJZN3HFOJKXN42ANTSCLRFOMHLFXHWPNAX64DQNUEBDMUYMPHASAV',
  'CBW5G5SO5SDYUGQVU7RMZ2KJ34POM3AMODOBIV2RQYG4KJDUUBVC3P2T',
  'CCKOC2LJTPDBKDHTL3M5UO7HFZ2WFIHSOKCELMKQP3TLCIVUBKOQL4HB',
  'CCUCE5H5CKW3S7JBESGCES6ZGDMWLNRY3HOFET3OH33MXZWKXNJTKSM3',
  'CDQLKNH3725BUP4HPKQKMM7OO62FDVXVTO7RCYPID527MZHJG2F3QBJW',
  'CBENABXP6C4C7WG6KB7JQOTDS5GIIXF3IX3PIYNZFCDZDWUHITO2HZ4S',
];

export const ammContractPresets: readonly AmmContractPreset[] = [
  {
    id: 'soroswap-mainnet',
    protocol: 'soroswap',
    network: 'mainnet',
    displayName: 'Soroswap',
    addresses: {
      factoryContractId: 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2',
      routerContractId: 'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH',
      poolContractIds: [],
    },
    eventTopics: {
      swap: ['swap', 'swap:*'],
      liquidityDeposit: ['deposit', 'deposit_liquidity', 'add_liquidity', 'provide_liquidity'],
      liquidityWithdrawal: ['withdraw', 'withdraw_liquidity', 'remove_liquidity'],
      poolCreated: ['create_pair', 'pool_created'],
    },
    decoder: {
      kind: 'scval-symbol',
      topicPosition: 0,
      valueFieldHints: ['amount', 'amount_in', 'amount_out'],
    },
  },
  {
    id: 'soroswap-testnet',
    protocol: 'soroswap',
    network: 'testnet',
    displayName: 'Soroswap',
    addresses: {
      factoryContractId: 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY',
      routerContractId: 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD',
      poolContractIds: [],
    },
    eventTopics: {
      swap: ['swap', 'swap:*'],
      liquidityDeposit: ['deposit', 'deposit_liquidity', 'add_liquidity', 'provide_liquidity'],
      liquidityWithdrawal: ['withdraw', 'withdraw_liquidity', 'remove_liquidity'],
      poolCreated: ['create_pair', 'pool_created'],
    },
    decoder: {
      kind: 'scval-symbol',
      topicPosition: 0,
      valueFieldHints: ['amount', 'amount_in', 'amount_out'],
    },
  },
  {
    id: 'phoenix-mainnet',
    protocol: 'phoenix',
    network: 'mainnet',
    displayName: 'Phoenix',
    addresses: {
      factoryContractId: 'CB4SVAWJA6TSRNOJZ7W2AWFW46D5VR4ZMFZKDIKXEINZCZEGZCJZCKMI',
      multihopContractId: 'CCLZRD4E72T7JCZCN3P7KNPYNXFYKQCL64ECLX7WP5GNVYPYJGU2IO2G',
      poolContractIds: PHOENIX_MAINNET_POOL_IDS,
    },
    eventTopics: {
      swap: ['swap'],
      liquidityDeposit: ['provide_liquidity', 'deposit', 'deposit_liquidity'],
      liquidityWithdrawal: ['withdraw_liquidity', 'withdraw'],
      poolCreated: ['create'],
    },
    decoder: {
      kind: 'scval-symbol',
      topicPosition: 0,
      valueFieldHints: ['amount', 'amount_a', 'amount_b'],
    },
  },
  {
    id: 'phoenix-testnet',
    protocol: 'phoenix',
    network: 'testnet',
    displayName: 'Phoenix',
    addresses: {
      factoryContractId: 'CB6JW45DDEPUDUQI63AVYXD6UB72HMBGDAW7MZDZKZZIKAB7HL4LTNWO',
      multihopContractId: 'CBAMPJTMNDXBBYYQ77C7WX2MTBR3XZHERDJ7NQMXLEZHMWUFQBQMFTOC',
      poolContractIds: [],
    },
    eventTopics: {
      swap: ['swap'],
      liquidityDeposit: ['provide_liquidity', 'deposit', 'deposit_liquidity'],
      liquidityWithdrawal: ['withdraw_liquidity', 'withdraw'],
      poolCreated: ['create'],
    },
    decoder: {
      kind: 'scval-symbol',
      topicPosition: 0,
      valueFieldHints: ['amount', 'amount_a', 'amount_b'],
    },
  },
  {
    id: 'aqua-mainnet',
    protocol: 'aqua',
    network: 'mainnet',
    displayName: 'Aqua',
    addresses: {
      routerContractId: 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK',
      factoryContractId: 'CA4Q2T6FRAFYJYSMDJV7F6B7RL5PS6QS2UOZHBMCT2KSMGQRAAKP2MKO',
      poolContractIds: [],
    },
    eventTopics: {
      swap: ['swap', 'swap:*'],
      liquidityDeposit: ['deposit', 'add_liquidity', 'provide_liquidity'],
      liquidityWithdrawal: ['withdraw', 'withdraw_liquidity', 'remove_liquidity'],
      poolCreated: ['create_pool', 'pool_created'],
    },
    decoder: {
      kind: 'scval-symbol',
      topicPosition: 0,
      valueFieldHints: ['amount', 'amount_in', 'amount_out'],
    },
  },
  {
    id: 'aqua-testnet',
    protocol: 'aqua',
    network: 'testnet',
    displayName: 'Aqua',
    addresses: {
      routerContractId: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD',
      factoryContractId: 'CCXU6S2PFFFESV65RHUEVJX6TSSN6BYKOCJ3S3LM5M3IXXIWAL5AV4CO',
      poolContractIds: [],
    },
    eventTopics: {
      swap: ['swap', 'swap:*'],
      liquidityDeposit: ['deposit', 'add_liquidity', 'provide_liquidity'],
      liquidityWithdrawal: ['withdraw', 'withdraw_liquidity', 'remove_liquidity'],
      poolCreated: ['create_pool', 'pool_created'],
    },
    decoder: {
      kind: 'scval-symbol',
      topicPosition: 0,
      valueFieldHints: ['amount', 'amount_in', 'amount_out'],
    },
  },
];

const EVENT_LABELS: Record<AmmEventKind, string> = {
  swap: 'Swap over $1,000',
  liquidityDeposit: 'Liquidity Deposit',
  liquidityWithdrawal: 'Liquidity Withdrawal',
  poolCreated: 'Pool Created',
};

const EVENT_DESCRIPTIONS: Record<AmmEventKind, string> = {
  swap: 'Alert when a liquidity pool reports a swap above 1,000 units of the traded asset.',
  liquidityDeposit: 'Alert when liquidity is added to a monitored pool.',
  liquidityWithdrawal: 'Alert when liquidity is removed from a monitored pool.',
  poolCreated: 'Alert when a new liquidity pool is created by the protocol factory.',
};

function buildPreset(
  contract: AmmContractPreset,
  eventKind: AmmEventKind,
  minAmount: number | string | null,
): AmmRulePreset {
  const patterns = contract.eventTopics[eventKind];
  const topicPatterns = contract.addresses.poolContractIds.length > 0
    ? contract.addresses.poolContractIds.flatMap((contractId) =>
        patterns.map((pattern) => ({ pattern, position: 0, contractId })),
      )
    : patterns.map((pattern) => ({ pattern, position: 0 }));

  const amountRules: FilterRule[] = minAmount === null
    ? []
    : [{ field: 'amount', operator: 'gt', value: minAmount }];

  const conditions: FilterRuleGroup & { sorobanTopic: SorobanTopicRuleConfig } = {
    operator: 'AND',
    rules: amountRules,
    sorobanTopic: {
      topicPosition: contract.decoder.topicPosition,
      patterns: topicPatterns,
    },
  };

  const name = `${contract.displayName} ${EVENT_LABELS[eventKind]} (${contract.network})`;

  return {
    id: `${contract.id}-${eventKind}`,
    name,
    description: EVENT_DESCRIPTIONS[eventKind],
    protocol: contract.protocol,
    network: contract.network,
    eventKind,
    addresses: contract.addresses,
    topicPatterns: patterns,
    topicPosition: contract.decoder.topicPosition,
    minAmount,
    ruleDraft: {
      name,
      assets: [],
      minAmount,
      maxAmount: null,
      channels: [],
      isActive: true,
      conditions,
    },
  };
}

export const ammRulePresets: readonly AmmRulePreset[] = ammContractPresets.flatMap((contract) =>
  (['swap', 'liquidityDeposit', 'liquidityWithdrawal', 'poolCreated'] as const).map((eventKind) =>
    buildPreset(contract, eventKind, eventKind === 'swap' ? 1000 : null),
  ),
);

export function getAmmRulePreset(id: string): AmmRulePreset | undefined {
  return ammRulePresets.find((preset) => preset.id === id);
}
