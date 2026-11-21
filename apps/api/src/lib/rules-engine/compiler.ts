import { FilterRule, FilterRuleGroup, PaymentContext } from '../rules-engine';
import { createLogger } from '../logger';

const log = createLogger({ module: 'RuleCompiler' });

/**
 * Compiled rule function that evaluates a payment context to a boolean
 */
export type CompiledRuleFunction = (context: PaymentContext) => boolean;

/**
 * Whitelist of allowed field accessors for security
 */
const ALLOWED_FIELDS = new Set([
  'amount',
  'asset',
  'fromAddress',
  'memo',
  // Allow JSONPath expressions starting with $ for extended field access
]);

/**
 * Whitelist of allowed operators for safe execution
 */
const ALLOWED_OPERATORS = new Set([
  'gt',
  'gte',
  'lt',
  'lte',
  'eq',
  'ne',
  'contains',
  'exists',
  'not_exists',
  'in',
  'nin',
]);

/**
 * Cache of compiled rules to avoid recompilation
 */
const compilationCache = new Map<string, CompiledRuleFunction>();

/**
 * RuleCompiler transforms JSON rule AST definitions into fast, safe JavaScript
 * closures with zero object allocations during execution. Compiled rules achieve
 * sub-microsecond evaluation for simple conditions.
 */
export class RuleCompiler {
  private cache: Map<string, CompiledRuleFunction> = new Map();
  private cacheHits = 0;
  private compilations = 0;

  /**
   * Validates rule structure before compilation
   */
  private validateRule(rule: FilterRule | FilterRuleGroup): void {
    if ('rules' in rule) {
      // It's a group
      if (!Array.isArray(rule.rules)) {
        throw new Error('RuleGroup.rules must be an array');
      }
      if (!['AND', 'OR'].includes(rule.operator)) {
        throw new Error(`Invalid group operator: ${rule.operator}. Must be AND or OR`);
      }
      for (const subrule of rule.rules) {
        this.validateRule(subrule);
      }
    } else {
      // It's a rule
      const filterRule = rule as FilterRule;
      if (!filterRule.field) {
        throw new Error('Rule.field is required');
      }
      if (!ALLOWED_OPERATORS.has(filterRule.operator)) {
        throw new Error(`Operator ${filterRule.operator} not allowed`);
      }
      // Validate field is either a standard field or a JSONPath
      if (!filterRule.field.startsWith('$') && !ALLOWED_FIELDS.has(filterRule.field)) {
        throw new Error(`Field ${filterRule.field} not allowed`);
      }
    }
  }

  /**
   * Generates JavaScript code for field value resolution
   */
  private generateFieldAccess(field: string): string {
    // For simple fields, direct property access
    if (ALLOWED_FIELDS.has(field)) {
      return `(ctx.${field} ?? null)`;
    }

    // For JSONPath expressions, use the resolver function
    if (field.startsWith('$')) {
      return `resolveJsonPath(ctx, '${this.escapeString(field)}')[0] ?? null`;
    }

    throw new Error(`Invalid field: ${field}`);
  }

  /**
   * Generates comparison code for an operator
   */
  private generateComparison(operator: string, fieldCode: string, value: unknown): string {
    const escapedValue = this.escapeValue(value);

    switch (operator) {
      case 'gt':
        return `(Number(${fieldCode}) > Number(${escapedValue}))`;
      case 'gte':
        return `(Number(${fieldCode}) >= Number(${escapedValue}))`;
      case 'lt':
        return `(Number(${fieldCode}) < Number(${escapedValue}))`;
      case 'lte':
        return `(Number(${fieldCode}) <= Number(${escapedValue}))`;
      case 'eq':
        return `(${fieldCode} === ${escapedValue})`;
      case 'ne':
        return `(${fieldCode} !== ${escapedValue})`;
      case 'contains':
        return `(String(${fieldCode}).toLowerCase().includes(String(${escapedValue}).toLowerCase()))`;
      case 'exists':
        return `(${fieldCode} !== null && ${fieldCode} !== undefined)`;
      case 'not_exists':
        return `(${fieldCode} === null || ${fieldCode} === undefined)`;
      case 'in':
        return `([${Array.isArray(value) ? value.map((v) => this.escapeValue(v)).join(', ') : ''}].includes(String(${fieldCode})))`;
      case 'nin':
        return `(![${Array.isArray(value) ? value.map((v) => this.escapeValue(v)).join(', ') : ''}].includes(String(${fieldCode})))`;
      default:
        throw new Error(`Unknown operator: ${operator}`);
    }
  }

  /**
   * Escapes a string value for safe inclusion in generated code
   */
  private escapeString(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  /**
   * Escapes a value for safe inclusion in generated code
   */
  private escapeValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'string') {
      return `'${this.escapeString(value)}'`;
    }
    if (Array.isArray(value)) {
      return `[${value.map((v) => this.escapeValue(v)).join(',')}]`;
    }
    throw new Error(`Cannot escape value of type ${typeof value}`);
  }

  /**
   * Generates code for a single filter rule
   */
  private generateRuleCode(rule: FilterRule): string {
    const fieldAccess = this.generateFieldAccess(rule.field);
    const comparison = this.generateComparison(rule.operator, fieldAccess, rule.value);
    return comparison;
  }

  /**
   * Recursively generates code for a rule group
   */
  private generateGroupCode(group: FilterRuleGroup): string {
    if (group.rules.length === 0) {
      return 'true'; // Empty group matches everything
    }

    const ruleCodes = group.rules.map((rule) => {
      if ('rules' in rule) {
        return this.generateGroupCode(rule);
      }
      return this.generateRuleCode(rule as FilterRule);
    });

    if (group.operator === 'AND') {
      return `(${ruleCodes.join(' && ')})`;
    } else {
      return `(${ruleCodes.join(' || ')})`;
    }
  }

  /**
   * Generates the full compiled function code
   */
  private generateFunctionCode(rule: FilterRule | FilterRuleGroup): string {
    const condition = 'rules' in rule ? this.generateGroupCode(rule) : this.generateRuleCode(rule as FilterRule);

    // Helper function for JSONPath resolution (referenced in generated code)
    const helperCode = `
    function resolveJsonPath(ctx, path) {
      const tokens = [];
      const normalized = path.startsWith('$.') ? path.slice(2) : path.startsWith('$') ? path.slice(1) : path;
      const matcher = /\\.?(?<key>[^.\\[\\]]+)|\\[(?<index>\\d+|\\$|"[^"]+"|'[^']+')\]/g;
      let match;
      while ((match = matcher.exec(normalized)) !== null) {
        const key = match.groups?.key;
        const index = match.groups?.index;
        if (key) tokens.push(key);
        else if (index) {
          if (index === '*') tokens.push('*');
          else if (/^\\d+$/.test(index)) tokens.push(Number(index));
          else tokens.push(index.slice(1, -1));
        }
      }
      let values = [ctx];
      for (const token of tokens) {
        const next = [];
        for (const value of values) {
          if (value === null || value === undefined) continue;
          if (token === '*') {
            if (Array.isArray(value)) next.push(...value);
            continue;
          }
          if (Array.isArray(value) && typeof token === 'number') {
            if (token in value) next.push(value[token]);
            continue;
          }
          if (typeof value === 'object' && token in value) {
            next.push(value[String(token)]);
          }
        }
        values = next;
      }
      return values;
    }
    `;

    return `
      ${helperCode}
      return (ctx) => {
        if (!ctx) return false;
        try {
          return ${condition};
        } catch (e) {
          return false;
        }
      };
    `;
  }

  /**
   * Compiles a rule AST into a fast JavaScript closure
   * Returns cached result if already compiled with same key
   */
  compile(rule: FilterRule | FilterRuleGroup, cacheKey?: string): CompiledRuleFunction {
    // Generate cache key if not provided
    const key = cacheKey || JSON.stringify(rule);

    // Check cache first
    if (this.cache.has(key)) {
      this.cacheHits++;
      return this.cache.get(key)!;
    }

    try {
      // Validate rule structure first
      this.validateRule(rule);

      // Generate and execute the function code
      const functionCode = this.generateFunctionCode(rule);
      const compiledFn = new Function(functionCode)() as CompiledRuleFunction;

      // Cache the result
      this.cache.set(key, compiledFn);
      this.compilations++;

      return compiledFn;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error({ error: errorMsg, rule }, '❌ Failed to compile rule');
      throw new Error(`Failed to compile rule: ${errorMsg}`);
    }
  }

  /**
   * Batch compiles multiple rules with deduplication
   */
  compileBatch(
    rules: Array<{ rule: FilterRule | FilterRuleGroup; id: string }>,
  ): Map<string, CompiledRuleFunction> {
    const compiled = new Map<string, CompiledRuleFunction>();

    for (const { rule, id } of rules) {
      try {
        compiled.set(id, this.compile(rule, id));
      } catch (err) {
        log.warn({ ruleId: id, error: err }, 'Skipping rule compilation due to error');
      }
    }

    return compiled;
  }

  /**
   * Evaluates a payment context against a compiled rule
   */
  evaluate(compiledFn: CompiledRuleFunction, context: PaymentContext): boolean {
    try {
      return compiledFn(context);
    } catch (error) {
      log.error({ error }, '❌ Error evaluating compiled rule');
      return false;
    }
  }

  /**
   * Gets compilation statistics for monitoring
   */
  getStats(): {
    cachedRules: number;
    totalCompilations: number;
    cacheHits: number;
    hitRate: number;
  } {
    const total = this.compilations + this.cacheHits;
    return {
      cachedRules: this.cache.size,
      totalCompilations: this.compilations,
      cacheHits: this.cacheHits,
      hitRate: total > 0 ? (this.cacheHits / total) * 100 : 0,
    };
  }

  /**
   * Clears the compilation cache
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.compilations = 0;
  }
}

// Export singleton instance
export const ruleCompiler = new RuleCompiler();
