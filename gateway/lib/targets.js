'use strict';

/**
 * 客户端目标：URL 中的 id -> subconverter 的 target / ver 参数，
 * 以及 UA 自动识别、Content-Type、节点数量统计。
 */

const TARGETS = [
  {
    id: 'mihomo',
    label: 'mihomo',
    subtitle: 'Clash Verge / FlClash / Meta 内核',
    engine: 'clash',
    contentType: 'text/yaml; charset=utf-8',
    accent: '#34d399',
    mono: 'M',
  },
  {
    id: 'daed',
    label: 'daed',
    subtitle: 'daed / dae 大鹅 · 节点订阅',
    // daed 的「订阅」只解析分享链接（base64），不吃 Clash YAML，所以输出 v2ray 格式
    engine: 'v2ray',
    contentType: 'text/plain; charset=utf-8',
    accent: '#a78bfa',
    mono: 'D',
  },
  {
    id: 'stash',
    label: 'Stash',
    subtitle: 'Stash (iOS) · Clash 配置',
    engine: 'clash',
    contentType: 'text/yaml; charset=utf-8',
    accent: '#f472b6',
    mono: 'S',
  },
  {
    id: 'singbox',
    label: 'sing-box',
    subtitle: 'SFI / SFA / Hiddify',
    engine: 'singbox',
    contentType: 'application/json; charset=utf-8',
    accent: '#38bdf8',
    mono: 'B',
  },
  {
    id: 'surge',
    label: 'Surge',
    subtitle: 'Surge 4 / 5 · Managed',
    engine: 'surge',
    ver: '4',
    contentType: 'text/plain; charset=utf-8',
    accent: '#fb923c',
    mono: 'G',
  },
  {
    id: 'loon',
    label: 'Loon',
    subtitle: 'Loon (iOS / macOS)',
    engine: 'loon',
    contentType: 'text/plain; charset=utf-8',
    accent: '#facc15',
    mono: 'L',
  },
  {
    id: 'quanx',
    label: 'Quantumult X',
    subtitle: 'Quantumult X',
    engine: 'quanx',
    contentType: 'text/plain; charset=utf-8',
    accent: '#2dd4bf',
    mono: 'Q',
  },
  {
    id: 'surfboard',
    label: 'Surfboard',
    subtitle: 'Surfboard (Android)',
    engine: 'surfboard',
    contentType: 'text/plain; charset=utf-8',
    accent: '#60a5fa',
    mono: 'F',
  },
  {
    id: 'v2ray',
    label: 'v2ray',
    subtitle: 'v2rayN / Shadowrocket / Base64',
    engine: 'v2ray',
    contentType: 'text/plain; charset=utf-8',
    accent: '#c084fc',
    mono: 'V',
  },
];

const BY_ID = new Map(TARGETS.map((t) => [t.id, t]));

const ALIASES = {
  clash: 'mihomo',
  meta: 'mihomo',
  cmfa: 'mihomo',
  clashmeta: 'mihomo',
  'clash-meta': 'mihomo',
  verge: 'mihomo',
  flclash: 'mihomo',
  clashx: 'mihomo',
  'clash-verge': 'mihomo',
  dae: 'daed',
  singbox: 'singbox',
  'sing-box': 'singbox',
  sfi: 'singbox',
  sfa: 'singbox',
  sft: 'singbox',
  hiddify: 'singbox',
  surge4: 'surge',
  surge5: 'surge',
  quantumultx: 'quanx',
  quantumult: 'quanx',
  qx: 'quanx',
  shadowrocket: 'v2ray',
  v2rayn: 'v2ray',
  v2rayng: 'v2ray',
  base64: 'v2ray',
  ss: 'v2ray',
  ssr: 'v2ray',
};

function resolveTarget(input) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  if (BY_ID.has(key)) return BY_ID.get(key);
  const alias = ALIASES[key] || ALIASES[key.replace(/[^a-z0-9-]/g, '')];
  return alias ? BY_ID.get(alias) : null;
}

const UA_RULES = [
  [/quantumult\s*x|quantumultx|\bqx\b/i, 'quanx'],
  [/quantumult/i, 'quanx'],
  [/surfboard/i, 'surfboard'],
  [/sing-?box|hiddify|\bsfi\b|\bsfa\b|\bsft\b|\bsfm\b|karing/i, 'singbox'],
  [/daed|\bdae\b/i, 'daed'],
  [/stash/i, 'stash'],
  [/surge/i, 'surge'],
  [/loon/i, 'loon'],
  [/clash|mihomo|flclash|clashmi|clash\s?verge|clash\s?meta|clashx|clash\s?for\s?windows/i, 'mihomo'],
  [/shadowrocket|v2rayng|v2rayn|nekobox|nekoray|passwall|v2ray/i, 'v2ray'],
];

const FALLBACK_TARGET = 'v2ray';

function detectTarget(ua = '') {
  for (const [re, id] of UA_RULES) {
    if (re.test(ua)) return BY_ID.get(id);
  }
  return BY_ID.get(FALLBACK_TARGET);
}

function targetList() {
  return TARGETS.map(({ id, label, subtitle, accent, mono, engine }) => ({
    id,
    label,
    subtitle,
    accent,
    mono,
    engine,
  }));
}

/** 从输出内容里数节点数量（尽力而为，用于展示） */
function countNodes(target, body) {
  if (!body) return 0;
  try {
    switch (target.id) {
      case 'mihomo':
      case 'stash':
        return countClash(body);
      case 'singbox':
        return countSingbox(body);
      case 'surge':
      case 'loon':
        return countSection(body, '[Proxy]');
      case 'quanx':
        return countSection(body, '[server_local]');
      case 'surfboard':
        return countSection(body, '[Proxy]');
      case 'daed':
      case 'v2ray':
        return countV2ray(body);
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}

function countClash(body) {
  const head = body.split(/^proxy-groups:/m)[0] || '';
  const section = head.split(/^proxies:/m)[1];
  if (!section) return 0;
  const matches = section.match(/^\s*-\s*\{?\s*name\s*:/gm);
  return matches ? matches.length : 0;
}

function countSingbox(body) {
  const conf = JSON.parse(body);
  const outbounds = Array.isArray(conf.outbounds) ? conf.outbounds : [];
  const proxyTypes = new Set([
    'vmess', 'vless', 'trojan', 'shadowsocks', 'shadowsocksr', 'hysteria',
    'hysteria2', 'tuic', 'anytls', 'wireguard', 'socks', 'http', 'ssh',
    'shadowtls', 'mieru', 'snell', 'naive',
  ]);
  return outbounds.filter((o) => o && proxyTypes.has(String(o.type))).length;
}

function countSection(body, sectionName) {
  const lines = body.split(/\r?\n/);
  let active = false;
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.+\]$/.test(line)) {
      active = line.toLowerCase() === sectionName.toLowerCase();
      continue;
    }
    if (!active || !line || line.startsWith('#') || line.startsWith(';')) continue;
    if (!line.includes('=')) continue;
    const name = line.slice(0, line.indexOf('=')).trim();
    if (!name || name.toUpperCase() === 'DIRECT') continue;
    n += 1;
  }
  return n;
}

function countV2ray(body) {
  const text = String(body).trim();
  if (!text) return 0;
  let decoded = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text.split(/\r?\n/)[0])) {
    try {
      decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      decoded = text;
    }
  }
  return decoded
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')).length;
}

module.exports = {
  TARGETS,
  targetList,
  resolveTarget,
  detectTarget,
  countNodes,
};
