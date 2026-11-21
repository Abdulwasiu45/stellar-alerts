import { AlertRuleRecord, CompiledAlertRule, compileAlertRule } from '../alert-rule-evaluator';
import { createLogger } from '../logger';

const log = createLogger({ module: 'RuleCompilationCache' });

/**
 * Manages caching and lifecycle of compiled alert rules
 * Deduplicates compilation efforts across the application
 */
export class RuleCompilationCache {
  private cache = new Map<string, CompiledAlertRule>();
  private ruleVersions = new Map<string, number>();
  private stats = {
    hits: 0,
    misses: 0,
    compilations: 0,
    evictions: 0,
  };

  /**
   * Max number of rules to cache before evicting least-used
   */
  private maxCacheSize = 10000;

  /**
   * Gets or compiles a rule, caching the result
   */
  getOrCompile(rule: AlertRuleRecord): CompiledAlertRule {
    // Generate cache key from rule ID and version
    const cacheKey = `${rule.id}:${rule.version ?? 0}`;

    // Check if version has changed (rule was updated)
    const cachedVersion = this.ruleVersions.get(rule.id);
    if (cachedVersion !== undefined && cachedVersion !== (rule.version ?? 0)) {
      // Rule was updated, invalidate cached version
      this.cache.delete(`${rule.id}:${cachedVersion}`);
      this.stats.evictions++;
    }

    // Try to get from cache
    if (this.cache.has(cacheKey)) {
      this.stats.hits++;
      return this.cache.get(cacheKey)!;
    }

    // Cache miss: compile the rule
    this.stats.misses++;
    this.stats.compilations++;

    const compiled = compileAlertRule(rule);
    this.cache.set(cacheKey, compiled);
    this.ruleVersions.set(rule.id, rule.version ?? 0);

    // Evict oldest entries if cache is too large
    if (this.cache.size > this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.stats.evictions++;
      }
    }

    return compiled;
  }

  /**
   * Batch gets or compiles multiple rules
   */
  getOrCompileBatch(rules: AlertRuleRecord[]): CompiledAlertRule[] {
    return rules.map((rule) => this.getOrCompile(rule));
  }

  /**
   * Invalidates a specific rule from cache (call when rule is updated)
   */
  invalidate(ruleId: string): void {
    const version = this.ruleVersions.get(ruleId);
    if (version !== undefined) {
      const cacheKey = `${ruleId}:${version}`;
      if (this.cache.has(cacheKey)) {
        this.cache.delete(cacheKey);
        this.stats.evictions++;
      }
      this.ruleVersions.delete(ruleId);
    }
  }

  /**
   * Invalidates all rules for a user (call when user's rules are bulk updated)
   */
  invalidateUser(userId: string): void {
    // This would need rule metadata to associate with user
    // For now, just clear the whole cache
    log.info({ userId }, 'Clearing rule compilation cache for user');
    this.clear();
  }

  /**
   * Clears all cached rules
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.ruleVersions.clear();
    log.info({ clearedCount: size }, 'Cleared rule compilation cache');
  }

  /**
   * Gets cache statistics
   */
  getStats(): {
    cachedRules: number;
    hits: number;
    misses: number;
    hitRate: number;
    compilations: number;
    evictions: number;
  } {
    const total = this.stats.hits + this.stats.misses;
    return {
      cachedRules: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? (this.stats.hits / total) * 100 : 0,
      compilations: this.stats.compilations,
      evictions: this.stats.evictions,
    };
  }

  /**
   * Sets maximum cache size
   */
  setMaxSize(size: number): void {
    this.maxCacheSize = size;
  }

  /**
   * Resets statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      compilations: 0,
      evictions: 0,
    };
  }
}

// Export singleton instance
export const ruleCompilationCache = new RuleCompilationCache();
