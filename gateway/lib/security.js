'use strict';

/**
 * 安全：订阅源 SSRF 校验 + 简单限流。
 *
 * 默认禁止私网 / 回环 / 链路本地 / 云元数据地址，
 * 通过 ALLOW_PRIVATE_SOURCES=true 可放开（家用内网机场场景）。
 */

const dns = require('node:dns').promises;
const net = require('node:net');
const { HttpError } = require('./util');

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'kubernetes.default.svc',
]);

const DNS_TTL = 120 * 1000;
const dnsCache = new Map(); // host -> { addrs, exp }

function ipv4Parts(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

function isPrivateIpv4(ip) {
  const p = ipv4Parts(ip);
  if (!p) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIpv6(ip) {
  const s = String(ip).toLowerCase().replace(/%.*$/, '');
  if (s === '::' || s === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true; // fe80::/10 link-local
  if (/^2001:db8:/.test(s)) return true; // doc
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    if (net.isIPv4(v4)) return isPrivateIpv4(v4);
  }
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return false;
}

function isBlockedHostname(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return false;
}

async function lookup(host) {
  const now = Date.now();
  const hit = dnsCache.get(host);
  if (hit && hit.exp > now) return hit.addrs;
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new HttpError(400, `无法解析订阅源域名：${host}`);
  }
  const list = addrs.map((a) => a.address).filter(Boolean);
  dnsCache.set(host, { addrs: list, exp: now + DNS_TTL });
  if (dnsCache.size > 500) {
    for (const [k, v] of dnsCache) if (v.exp <= now) dnsCache.delete(k);
  }
  return list;
}

/**
 * 校验一个订阅源地址。
 * @returns {Promise<{url: string, host: string}>}
 */
async function assertSourceUrl(raw, { allowPrivate = false } = {}) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) throw new HttpError(400, '订阅链接为空');
  if (value.length > 4096) throw new HttpError(400, '订阅链接过长');
  if (value.startsWith('tg://')) throw new HttpError(400, '暂不支持 tg:// 订阅源，请使用 http(s) 链接');

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, `订阅链接格式不正确：${value.slice(0, 80)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, '订阅源只支持 http:// 或 https://');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!allowPrivate && isPrivateIp(host)) {
      throw new HttpError(400, `出于 SSRF 防护，禁止访问内网地址：${host}（可设置 ALLOW_PRIVATE_SOURCES=true 放开）`);
    }
    return { url: url.toString(), host };
  }

  if (!allowPrivate) {
    if (isBlockedHostname(host)) {
      throw new HttpError(400, `禁止访问本地/内部域名：${host}`);
    }
    const addrs = await lookup(host);
    if (!addrs.length) throw new HttpError(400, `域名无解析结果：${host}`);
    if (addrs.some((ip) => isPrivateIp(ip))) {
      throw new HttpError(400, `域名 ${host} 解析到内网地址 ${addrs[0]}，已拒绝（可设置 ALLOW_PRIVATE_SOURCES=true 放开）`);
    }
  }

  return { url: url.toString(), host };
}

/** 批量校验，去重并保持顺序 */
async function assertSources(list, opts) {
  const arr = Array.isArray(list) ? list : [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const value = String(item == null ? '' : item).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const { url } = await assertSourceUrl(value, opts);
    out.push(url);
  }
  return out;
}

class RateLimiter {
  constructor({ limit, windowMs, name = 'bucket' }) {
    this.limit = Math.max(1, Number(limit) || 60);
    this.windowMs = Math.max(1000, Number(windowMs) || 60000);
    this.name = name;
    this.map = new Map();
    this.lastSweep = Date.now();
  }

  hit(key) {
    const now = Date.now();
    let entry = this.map.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + this.windowMs };
      this.map.set(key, entry);
    }
    entry.count += 1;
    if (now - this.lastSweep > this.windowMs) {
      this.lastSweep = now;
      for (const [k, v] of this.map) if (v.reset <= now) this.map.delete(k);
    }
    const ok = entry.count <= this.limit;
    return {
      ok,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfter: Math.max(1, Math.ceil((entry.reset - now) / 1000)),
    };
  }
}

module.exports = {
  assertSourceUrl,
  assertSources,
  isPrivateIp,
  RateLimiter,
};
