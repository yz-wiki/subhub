'use strict';

/**
 * 与 subconverter 引擎通信：拼 URL、拉取、校验输出、改写 Surge 托管配置首行。
 */

class EngineError extends Error {
  constructor(message, status = 502, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

class Engine {
  constructor({ base, selfUrl, timeout = 30000, logger, token = '' }) {
    this.base = String(base || '').replace(/\/+$/, '');
    this.selfUrl = String(selfUrl || '').replace(/\/+$/, '');
    this.timeout = timeout;
    this.token = String(token || '');
    this.log = logger || (() => {});
  }

  authHeaders(extra = {}) {
    const headers = { 'User-Agent': 'subhub-gateway/1.0', Accept: '*/*', ...extra };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  templateUrl(name) {
    return `${this.selfUrl}/tpl/${encodeURIComponent(name)}.ini`;
  }

  inlineTemplateUrl(id) {
    return `${this.selfUrl}/tpl-inline/${encodeURIComponent(id)}.ini`;
  }

  buildUrl({ sources, target, templateUrl, include, exclude, opts = {} }) {
    const u = new URL(`${this.base}/sub`);
    u.searchParams.set('target', target.engine);
    if (target.ver) u.searchParams.set('ver', target.ver);
    u.searchParams.set('url', (sources || []).join('|'));
    u.searchParams.set('config', templateUrl);
    if (include) u.searchParams.set('include', include);
    if (exclude) u.searchParams.set('exclude', exclude);
    u.searchParams.set('emoji', opts.emoji === false ? 'false' : 'true');
    u.searchParams.set('udp', opts.udp === false ? 'false' : 'true');
    u.searchParams.set('tfo', opts.tfo ? 'true' : 'false');
    u.searchParams.set('scv', opts.scv === false ? 'false' : 'true');
    u.searchParams.set('sort', opts.sort ? 'true' : 'false');
    u.searchParams.set('list', 'false');
    return u.toString();
  }

  /** 只解析节点：`list=true` 让引擎输出 Clash proxies 列表 */
  buildListUrl(sources) {
    const u = new URL(`${this.base}/sub`);
    u.searchParams.set('target', 'clash');
    u.searchParams.set('list', 'true');
    u.searchParams.set('url', (sources || []).join('|'));
    u.searchParams.set('emoji', 'false');
    u.searchParams.set('sort', 'false');
    return u.toString();
  }

  async listProxies(sources) {
    const url = this.buildListUrl(sources);
    let res;
    try {
      res = await fetch(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      const reason = e && e.name === 'TimeoutError' ? '解析超时' : (e && e.message) || '网络错误';
      throw new EngineError(`调用转换引擎失败：${reason}`);
    }
    const body = await res.text();
    if (!res.ok) throw new EngineError(`转换引擎返回 ${res.status}`, 502, String(body).slice(0, 300));
    if (/^\s*<(!doctype|html)/i.test(body)) throw new EngineError('转换引擎返回了 HTML 错误页', 502, body.slice(0, 200));
    return body;
  }

  async convert(params) {
    const url = this.buildUrl(params);
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.timeout),
        redirect: 'follow',
      });
    } catch (e) {
      const reason = e && e.name === 'TimeoutError' ? '转换超时' : (e && e.message) || '网络错误';
      throw new EngineError(`调用转换引擎失败：${reason}`);
    }

    let body;
    try {
      body = await res.text();
    } catch (e) {
      throw new EngineError(`读取引擎响应失败：${e.message}`);
    }

    if (!res.ok) {
      throw new EngineError(`转换引擎返回 ${res.status}`, 502, String(body).slice(0, 500));
    }
    if (!body || !body.trim()) {
      throw new EngineError('转换引擎返回了空内容，请检查订阅源是否有效');
    }
    if (/^\s*<(!doctype|html)/i.test(body)) {
      throw new EngineError('转换引擎返回了 HTML 错误页', 502, body.slice(0, 300));
    }
    if (body.length < 200 && /invalid|error|failed|no node/i.test(body)) {
      throw new EngineError(`转换失败：${body.trim().slice(0, 200)}`);
    }

    this.validateOutput(params.target, body);

    return {
      body,
      bytes: Buffer.byteLength(body, 'utf8'),
      ms: Date.now() - started,
      url,
      userinfo: res.headers.get('subscription-userinfo') || '',
    };
  }

  validateOutput(target, body) {
    if (target.engine === 'singbox') {
      let conf;
      try {
        conf = JSON.parse(body);
      } catch (e) {
        throw new EngineError('sing-box 输出不是合法 JSON', 502, body.slice(0, 300));
      }
      if (!Array.isArray(conf.outbounds) || !conf.outbounds.length) {
        throw new EngineError('sing-box 输出缺少 outbounds，可能是订阅源没有可用节点');
      }
      return;
    }
    if (target.engine === 'clash') {
      if (!/^proxies\s*:/m.test(body) && !/^proxy-groups\s*:/m.test(body)) {
        throw new EngineError('Clash 输出缺少 proxies / proxy-groups 段', 502, body.slice(0, 300));
      }
      return;
    }
    if (target.engine === 'surge' || target.engine === 'loon') {
      if (!/\[Proxy\]/i.test(body)) {
        throw new EngineError(`${target.label} 输出缺少 [Proxy] 段`, 502, body.slice(0, 300));
      }
      return;
    }
    if (target.engine === 'quanx') {
      if (!/\[server_local\]/i.test(body)) {
        throw new EngineError('Quantumult X 输出缺少 [server_local] 段', 502, body.slice(0, 300));
      }
      return;
    }
    if (target.engine === 'surfboard') {
      if (!/\[Proxy\]/i.test(body)) {
        throw new EngineError('Surfboard 输出缺少 [Proxy] 段', 502, body.slice(0, 300));
      }
      return;
    }
    if (target.engine === 'v2ray') {
      const text = String(body).trim();
      let decoded = text;
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text.split(/\r?\n/)[0])) {
        try {
          decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
        } catch {
          decoded = text;
        }
      }
      if (!/^[a-z][a-z0-9+.-]*:\/\//im.test(decoded)) {
        throw new EngineError(`${target.label} 输出里没有可识别的节点链接`, 502, body.slice(0, 300));
      }
    }
  }

  /** Surge 首行 `#!MANAGED-CONFIG <内部地址> ...` 改写成对外地址 */
  rewriteManaged(body, publicUrl) {
    const text = String(body);
    if (!text.startsWith('#!MANAGED-CONFIG')) return text;
    const lines = text.split('\n');
    lines[0] = lines[0].replace(/^(#!MANAGED-CONFIG\s+)\S+/, `$1${publicUrl}`);
    return lines.join('\n');
  }

  async version() {
    try {
      const res = await fetch(`${this.base}/version`, {
        signal: AbortSignal.timeout(4000),
        headers: this.authHeaders(),
      });
      const text = (await res.text()).trim();
      if (!res.ok) return { ok: false, version: '', error: `HTTP ${res.status}` };
      return { ok: true, version: text.slice(0, 80) };
    } catch (e) {
      return { ok: false, version: '', error: e.message };
    }
  }
}

module.exports = { Engine, EngineError };
