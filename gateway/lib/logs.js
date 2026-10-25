'use strict';

/**
 * 运行日志环形缓冲（最多 1000 条，进程内，重启清零）。
 *
 * 分类固定五类：system 系统 / network 网络 / convert 转换 / pull 拉取 / auth 账号。
 * 条目结构：{ id, at, cat, level, msg, user, ip }
 * /api/logs 按权限决定 scope：all 全部，self 只看 user === 自己用户名的条目。
 */

const DEFAULT_LIMIT = 1000;
const MAX_QUERY_LIMIT = 500;
const CATS = [
  { id: 'system', label: '系统' },
  { id: 'network', label: '网络' },
  { id: 'convert', label: '转换' },
  { id: 'pull', label: '拉取' },
  { id: 'auth', label: '账号' },
];
const CAT_IDS = CATS.map((c) => c.id);
const LEVELS = ['info', 'warn', 'error'];

function normalizeLevel(level) {
  const value = String(level || '').toLowerCase();
  return LEVELS.includes(value) ? value : 'info';
}

class LogBuffer {
  constructor({ limit = DEFAULT_LIMIT } = {}) {
    this.limit = Math.max(50, Math.trunc(Number(limit) || DEFAULT_LIMIT));
    this.items = [];
    this.seq = 0;
  }

  push({ cat = 'system', level = 'info', msg = '', user = null, ip = null } = {}) {
    const entry = {
      id: ++this.seq,
      at: new Date().toISOString(),
      cat: CAT_IDS.includes(cat) ? cat : 'system',
      level: normalizeLevel(level),
      msg: String(msg == null ? '' : msg),
      user: user ? String(user) : null,
      ip: ip ? String(ip) : null,
    };
    this.items.push(entry);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    return entry;
  }

  /** 按分类 / 关键字 / 可见范围过滤；返回最新在前 */
  list({ cat = 'all', limit = 200, q = '', scope = 'all', user = null } = {}) {
    const n = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.trunc(Number(limit)) || 200));
    const needle = String(q || '').trim().toLowerCase();
    const rows = this.items.filter((entry) => {
      if (scope === 'self' && (!user || entry.user !== String(user))) return false;
      if (cat && cat !== 'all' && entry.cat !== cat) return false;
      if (needle && !`${entry.msg} ${entry.user || ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    return rows.slice(-n).reverse();
  }

  /** 每类计数（不受 cat 影响，受 scope / q 影响），供前端页签 */
  summary({ scope = 'all', user = null, q = '' } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    return CATS.map((c) => ({
      id: c.id,
      label: c.label,
      count: this.items.filter((entry) => {
        if (entry.cat !== c.id) return false;
        if (scope === 'self' && (!user || entry.user !== String(user))) return false;
        if (needle && !`${entry.msg} ${entry.user || ''}`.toLowerCase().includes(needle)) return false;
        return true;
      }).length,
    }));
  }

  clear() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }
}

module.exports = { LogBuffer, CATS, CAT_IDS, LEVELS };
