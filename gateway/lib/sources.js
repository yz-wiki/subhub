'use strict';

/**
 * 订阅源取回与归一化。
 *
 * 为什么需要它：subconverter 对「明文节点链接列表」的识别并不可靠
 * （实测同样的内容 base64 编码后能解析、明文直接 400 Invalid subscription），
 * 而真实机场两种格式都常见。所以由网关先取回订阅、判断格式：
 *   - base64 订阅      → 原样交给渲染端
 *   - Clash YAML/JSON  → 原样
 *   - 明文链接列表      → base64 编码后再交给渲染端（subconverter 只认这种）
 * 归一化后的内容通过短时有效的 /src/<id> 暴露给 subconverter（容器内网，不可猜测的 id）。
 * 顺带把 upstream 的 Subscription-Userinfo 抓下来，透传给客户端。
 */

const crypto = require('node:crypto');
const { HttpError } = require('./util');

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;

class SourceStore {
  constructor({ ttlMs = 10 * 60 * 1000, logger } = {}) {
    this.ttlMs = ttlMs;
    this.log = logger || (() => {});
    this.map = new Map();
    this.bytes = 0;
  }

  register(body, contentType) {
    const id = crypto.randomBytes(18).toString('hex');
    const buf = Buffer.from(body, 'utf8');
    this.map.set(id, { body, contentType, bytes: buf.length, exp: Date.now() + this.ttlMs });
    this.bytes += buf.length;
    while (this.bytes > MAX_STORE_BYTES && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      this.drop(oldest);
    }
    return id;
  }

  get(id) {
    const item = this.map.get(id);
    if (!item) return null;
    if (item.exp < Date.now()) {
      this.drop(id);
      return null;
    }
    return item;
  }

  drop(id) {
    const item = this.map.get(id);
    if (!item) return;
    this.map.delete(id);
    this.bytes -= item.bytes;
  }

  sweep() {
    const now = Date.now();
    for (const [id, item] of this.map) {
      if (item.exp < now) this.drop(id);
    }
  }
}

function looksLikeBase64(text) {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 16 || compact.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return false;
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    return /^[a-z0-9+.-]+:\/\//im.test(decoded);
  } catch {
    return false;
  }
}

function isClashYaml(text) {
  if (/^\s*proxies\s*:/m.test(text)) return true;
  if (/^\s*proxy-groups\s*:/m.test(text)) return true;
  return false;
}

function isClashJson(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const obj = JSON.parse(trimmed);
    return !!obj && (Array.isArray(obj.proxies) || Array.isArray(obj.proxy_groups));
  } catch {
    return false;
  }
}

/**
 * @returns {{body:string, format:'base64'|'yaml'|'json'|'links'|'encoded-links'}}
 */
function normalizeSubscription(raw, label = '订阅源') {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const trimmed = text.trim();
  if (!trimmed) throw new HttpError(400, `${label}内容为空`);
  if (/^\s*<(!doctype|html)/i.test(trimmed)) {
    const err = new HttpError(502, `${label}返回了网页而不是订阅内容（可能需要登录，或链接填错了）`);
    err.network = true;
    throw err;
  }
  if (isClashYaml(trimmed)) return { body: text, format: 'yaml' };
  if (isClashJson(trimmed)) return { body: text, format: 'json' };
  if (looksLikeBase64(trimmed)) return { body: text, format: 'base64' };
  // 明文节点链接：subconverter 只稳定接受 base64 形式
  if (/^[a-z0-9+.-]+:\/\//im.test(trimmed)) {
    const encoded = Buffer.from(trimmed, 'utf8').toString('base64');
    return { body: encoded, format: 'encoded-links' };
  }
  throw new HttpError(
    400,
    `${label}内容无法识别（既不是 base64 订阅，也不是 Clash 配置或节点链接）`,
  );
}

async function fetchSource(url, { timeout = 15000, allowPrivate, retries = 0 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'clash-verge/v2.0.0',
          Accept: '*/*',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        const err = new HttpError(502, `订阅源返回 HTTP ${res.status}（${new URL(url).host}）`);
        err.network = true;
        throw err;
      }
      const len = Number(res.headers.get('content-length') || 0);
      if (len && len > MAX_SOURCE_BYTES) {
        throw new HttpError(400, `订阅源过大（${(len / 1024 / 1024).toFixed(1)} MB），上限 8 MB`);
      }
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
        throw new HttpError(400, '订阅源过大，上限 8 MB');
      }
      return { text, userinfo: res.headers.get('subscription-userinfo') || '' };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400));
    }
  }
  const reason = lastErr && lastErr.name === 'TimeoutError'
    ? '请求超时'
    : (lastErr && lastErr.message) || '网络错误';
  const err = new HttpError(502, `拉取订阅源失败：${reason}`);
  err.network = true;
  throw err;
}

/**
 * 取回并归一化全部订阅源，返回给 subconverter 的本地 URL 列表。
 * @returns {Promise<{urls:string[], userinfo:string, formats:string[]}>}
 */
async function prepareSources(store, sources, { selfUrl, timeout, allowPrivate, logger } = {}) {
  const urls = [];
  const formats = [];
  let userinfo = '';
  const log = logger || (() => {});

  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    const label = sources.length > 1 ? `第 ${i + 1} 个订阅源` : '订阅源';
    let fetched;
    try {
      fetched = await fetchSource(source, { timeout, allowPrivate });
    } catch (e) {
      const err = new HttpError(e.status || 502, `${label}：${e.message}`);
      if (e.network) err.network = true;
      throw err;
    }
    if (!userinfo && fetched.userinfo) userinfo = fetched.userinfo;
    const { body, format } = normalizeSubscription(fetched.text, label);
    if (format === 'encoded-links') log('src', `${label} 是明文链接列表，已转 base64 (${body.length}B)`);
    const id = store.register(body, format === 'yaml' || format === 'json' ? 'application/yaml' : 'text/plain');
    urls.push(`${selfUrl}/src/${id}`);
    formats.push(format);
  }

  return { urls, userinfo, formats };
}

module.exports = {
  SourceStore,
  normalizeSubscription,
  prepareSources,
  fetchSource,
  MAX_SOURCE_BYTES,
};
