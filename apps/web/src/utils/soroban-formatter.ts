/**
 * Soroban ScVal XDR / JSON Unpacker and Formatter
 * Recursively parses and unpacks Soroban contract event AST structures into human-friendly primitives.
 */

export type ScValType =
  | 'Symbol'
  | 'Address'
  | 'i128'
  | 'u128'
  | 'i64'
  | 'u64'
  | 'i32'
  | 'u32'
  | 'Vec'
  | 'Map'
  | 'Bytes'
  | 'String'
  | 'Bool'
  | 'Void'
  | 'Object'
  | 'Unknown';

export interface FormattedScVal {
  type: ScValType;
  raw: any;
  formattedValue: string;
  decimalFormatted?: string;
  children?: Array<{ key: string | number; value: FormattedScVal }>;
}

/**
 * Formats a large integer (i128, u128, i64, etc.) into decimal precision string.
 * Default decimals is 7 (standard Stellar token decimals).
 */
export function formatLargeIntegerWithDecimals(
  val: bigint | string | number,
  decimals: number = 7
): string {
  try {
    let big: bigint;
    if (typeof val === 'bigint') {
      big = val;
    } else if (typeof val === 'number') {
      big = BigInt(Math.floor(val));
    } else if (typeof val === 'string') {
      // Clean string
      const clean = val.trim().replace(/^0x/, '');
      if (/^-?\d+$/.test(clean)) {
        big = BigInt(clean);
      } else {
        return String(val);
      }
    } else {
      return String(val);
    }

    const isNegative = big < 0n;
    const abs = isNegative ? -big : big;
    const divisor = 10n ** BigInt(decimals);

    const integerPart = abs / divisor;
    const remainder = abs % divisor;

    // Pad remainder with leading zeros
    let fractionalStr = remainder.toString().padStart(decimals, '0');
    // Format integer part with thousands separators
    const formattedInteger = integerPart.toLocaleString('en-US');

    const result = `${isNegative ? '-' : ''}${formattedInteger}.${fractionalStr}`;
    return result;
  } catch {
    return String(val);
  }
}

/**
 * Parses i128 / u128 parts { lo, hi } into a single BigInt.
 */
export function parse128Parts(val: any): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(val);
  if (typeof val === 'string') return BigInt(val);
  if (val && typeof val === 'object') {
    if ('lo' in val && 'hi' in val) {
      const lo = BigInt(val.lo ?? 0);
      const hi = BigInt(val.hi ?? 0);
      return (hi << 64n) + lo;
    }
  }
  return 0n;
}

/**
 * Recursively unpacks any ScVal structure into a normalized FormattedScVal AST tree.
 */
export function unpackScVal(scVal: any): FormattedScVal {
  if (scVal === null || scVal === undefined) {
    return {
      type: 'Void',
      raw: scVal,
      formattedValue: 'void',
    };
  }

  // Handle boolean primitives
  if (typeof scVal === 'boolean') {
    return {
      type: 'Bool',
      raw: scVal,
      formattedValue: String(scVal),
    };
  }

  // Handle number primitives
  if (typeof scVal === 'number') {
    return {
      type: 'i32',
      raw: scVal,
      formattedValue: String(scVal),
      decimalFormatted: formatLargeIntegerWithDecimals(scVal, 7),
    };
  }

  // Handle bigint primitives
  if (typeof scVal === 'bigint') {
    return {
      type: 'i128',
      raw: scVal,
      formattedValue: scVal.toString(),
      decimalFormatted: formatLargeIntegerWithDecimals(scVal, 7),
    };
  }

  // Handle string primitives (could be address, symbol, or string)
  if (typeof scVal === 'string') {
    if (scVal.startsWith('G') && scVal.length === 56) {
      return { type: 'Address', raw: scVal, formattedValue: scVal };
    }
    if (scVal.startsWith('C') && scVal.length === 56) {
      return { type: 'Address', raw: scVal, formattedValue: scVal };
    }
    return {
      type: 'String',
      raw: scVal,
      formattedValue: scVal,
    };
  }

  // Handle Array -> Vec
  if (Array.isArray(scVal)) {
    const children = scVal.map((item, idx) => ({
      key: idx,
      value: unpackScVal(item),
    }));
    return {
      type: 'Vec',
      raw: scVal,
      formattedValue: `Vec[${scVal.length}]`,
      children,
    };
  }

  // Handle stellar-sdk / XDR-like wrapped objects:
  // e.g. { type: 'symbol', value: 'transfer' }, { _switch: ..., _value: ... }, { symbol: '...' }
  if (typeof scVal === 'object') {
    // 1. Explicit { type, value } format
    if (scVal.type && 'value' in scVal) {
      const typeStr = String(scVal.type).toLowerCase();
      if (typeStr.includes('symbol')) {
        return { type: 'Symbol', raw: scVal, formattedValue: String(scVal.value) };
      }
      if (typeStr.includes('address')) {
        return { type: 'Address', raw: scVal, formattedValue: String(scVal.value) };
      }
      if (typeStr === 'i128' || typeStr === 'u128') {
        const big = parse128Parts(scVal.value);
        return {
          type: typeStr === 'i128' ? 'i128' : 'u128',
          raw: scVal,
          formattedValue: big.toString(),
          decimalFormatted: formatLargeIntegerWithDecimals(big, 7),
        };
      }
      if (typeStr === 'vec' && Array.isArray(scVal.value)) {
        return unpackScVal(scVal.value);
      }
      if (typeStr === 'map') {
        return unpackMap(scVal.value, scVal);
      }
      if (typeStr === 'bytes') {
        return { type: 'Bytes', raw: scVal, formattedValue: String(scVal.value) };
      }
    }

    // 2. Direct property bags: { symbol: '...' }, { address: '...' }, { i128: ... }, etc.
    if ('symbol' in scVal) {
      return { type: 'Symbol', raw: scVal, formattedValue: String(scVal.symbol) };
    }
    if ('address' in scVal) {
      return { type: 'Address', raw: scVal, formattedValue: String(scVal.address) };
    }
    if ('i128' in scVal) {
      const big = parse128Parts(scVal.i128);
      return {
        type: 'i128',
        raw: scVal,
        formattedValue: big.toString(),
        decimalFormatted: formatLargeIntegerWithDecimals(big, 7),
      };
    }
    if ('u128' in scVal) {
      const big = parse128Parts(scVal.u128);
      return {
        type: 'u128',
        raw: scVal,
        formattedValue: big.toString(),
        decimalFormatted: formatLargeIntegerWithDecimals(big, 7),
      };
    }
    if ('vec' in scVal && Array.isArray(scVal.vec)) {
      return unpackScVal(scVal.vec);
    }
    if ('map' in scVal) {
      return unpackMap(scVal.map, scVal);
    }

    // 3. Stellar XDR _switch format: { _switch: { name: 'scvSymbol' }, _value: ... }
    if (scVal._switch) {
      const switchName = String(scVal._switch.name || scVal._switch);
      if (switchName.includes('scvSymbol')) {
        return { type: 'Symbol', raw: scVal, formattedValue: String(scVal._value) };
      }
      if (switchName.includes('scvAddress')) {
        return { type: 'Address', raw: scVal, formattedValue: String(scVal._value) };
      }
      if (switchName.includes('scvI128') || switchName.includes('scvU128')) {
        const big = parse128Parts(scVal._value);
        return {
          type: switchName.includes('scvI128') ? 'i128' : 'u128',
          raw: scVal,
          formattedValue: big.toString(),
          decimalFormatted: formatLargeIntegerWithDecimals(big, 7),
        };
      }
      if (switchName.includes('scvVec') && Array.isArray(scVal._value)) {
        return unpackScVal(scVal._value);
      }
      if (switchName.includes('scvMap')) {
        return unpackMap(scVal._value, scVal);
      }
    }

    // 4. General dictionary / map
    const entries = Object.entries(scVal);
    const children = entries.map(([k, v]) => ({
      key: k,
      value: unpackScVal(v),
    }));

    return {
      type: 'Map',
      raw: scVal,
      formattedValue: `Map{${entries.length}}`,
      children,
    };
  }

  return {
    type: 'Unknown',
    raw: scVal,
    formattedValue: String(scVal),
  };
}

/**
 * Helper to unpack Soroban map entries (either array of { key, val } or record object).
 */
function unpackMap(mapData: any, raw: any): FormattedScVal {
  if (Array.isArray(mapData)) {
    const children = mapData.map((entry, idx) => {
      let key = `entry_${idx}`;
      let val = entry;
      if (entry && typeof entry === 'object' && 'key' in entry && 'val' in entry) {
        const unpackedKey = unpackScVal(entry.key);
        key = unpackedKey.formattedValue;
        val = entry.val;
      }
      return {
        key,
        value: unpackScVal(val),
      };
    });

    return {
      type: 'Map',
      raw,
      formattedValue: `Map{${children.length}}`,
      children,
    };
  }

  if (typeof mapData === 'object' && mapData !== null) {
    const entries = Object.entries(mapData);
    const children = entries.map(([k, v]) => ({
      key: k,
      value: unpackScVal(v),
    }));
    return {
      type: 'Map',
      raw,
      formattedValue: `Map{${entries.length}}`,
      children,
    };
  }

  return {
    type: 'Map',
    raw,
    formattedValue: 'Map{}',
    children: [],
  };
}
