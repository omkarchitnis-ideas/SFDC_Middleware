const crypto = require('crypto');

class QueryCache {
  constructor(options = {}) {
    this.defaultTtlMs = (parseInt(process.env.QUERY_CACHE_TTL_SECONDS, 10) || 60) * 1000;
    this.maxItems = parseInt(process.env.QUERY_CACHE_MAX_ITEMS, 10) || 500;
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0
    };

    // Periodic sweep every 60 seconds to prune expired items
    this.pruneInterval = setInterval(() => this.pruneExpired(), 60000);
    if (this.pruneInterval.unref) {
      this.pruneInterval.unref();
    }
  }

  /**
   * Normalizes a SOQL string and generates a deterministic hash key.
   */
  generateKey(soql, maxRecords = 2000) {
    if (!soql || typeof soql !== 'string') return null;
    const normalized = soql.trim().replace(/\s+/g, ' ').toLowerCase();
    const hash = crypto.createHash('sha256').update(`${normalized}|limit:${maxRecords}`).digest('hex');
    return hash;
  }

  /**
   * Retrieves a cached result if it exists and has not expired.
   */
  get(key) {
    if (!key || !this.cache.has(key)) {
      this.stats.misses++;
      return null;
    }

    const entry = this.cache.get(key);
    const now = Date.now();

    // Check expiration
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    // Refresh LRU order (delete and re-insert)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.stats.hits++;
    const ageSeconds = Math.round((now - entry.createdAt) / 1000);
    const ttlSeconds = Math.round((entry.expiresAt - now) / 1000);

    return {
      data: entry.data,
      ageSeconds,
      ttlSeconds
    };
  }

  /**
   * Caches a query result with an optional custom TTL in seconds.
   */
  set(key, data, customTtlSeconds) {
    if (!key) return;

    // Enforce max capacity by evicting oldest (first key in Map)
    if (this.cache.size >= this.maxItems) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }

    const ttlMs = (customTtlSeconds ? parseInt(customTtlSeconds, 10) * 1000 : this.defaultTtlMs);
    const now = Date.now();

    this.cache.set(key, {
      data,
      createdAt: now,
      expiresAt: now + ttlMs
    });
  }

  /**
   * Clears the entire cache or entries matching a specific pattern.
   */
  clear() {
    const count = this.cache.size;
    this.cache.clear();
    return count;
  }

  /**
   * Prunes all expired keys from the Map.
   */
  pruneExpired() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Returns operational metrics for monitoring and health dashboards.
   */
  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRatio = totalRequests > 0 ? ((this.stats.hits / totalRequests) * 100).toFixed(1) + '%' : '0.0%';

    return {
      cachedItems: this.cache.size,
      maxItems: this.maxItems,
      defaultTtlSeconds: Math.round(this.defaultTtlMs / 1000),
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRatio
    };
  }
}

const queryCache = new QueryCache();

module.exports = {
  QueryCache,
  queryCache
};
