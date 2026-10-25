'use strict';

/**
 * 进程内 TTL 缓存，带条目数 / 总字节上限。订阅转换结果通常 5-80KB。
 */

class TTLCache {
  constructor({ maxEntries = 1000, maxBytes = 48 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.map = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.exp <= Date.now()) {
      this.map.delete(key);
      this.bytes -= entry.size;
      this.misses += 1;
      return null;
    }
    // LRU：重新插入
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!(ttlMs > 0)) return;
    const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, exp: Date.now() + ttlMs, size });
    this.bytes += size;
    this.evict();
  }

  evict() {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.map.keys().next();
      if (first.done) break;
      const entry = this.map.get(first.value);
      this.map.delete(first.value);
      if (entry) this.bytes -= entry.size;
    }
  }

  delete(key) {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.bytes -= entry.size;
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : 0,
    };
  }
}

module.exports = { TTLCache };
