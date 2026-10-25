'use strict';

/**
 * 节点解析/序列化。
 *
 * 思路：不论来源是订阅链接、分享链接、Clash YAML 还是 JSON，都先交给引擎
 * 以 `list=true&target=clash` 归一化成 Clash 的 flow 风格 proxies 列表，
 * 再由这里解析成可编辑的对象，最后按需序列化回 YAML 作为转换输入。
 */

const SUPPORTED_TYPES = new Set([
  'ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic',
  'anytls', 'socks5', 'http', 'snell', 'wireguard', 'mieru',
]);

/** 在顶层分隔符处切分（忽略 {} [] 与引号内部） */
function splitTopLevel(text, sep = ',') {
  const out = [];
  let depth = 0;
  let quote = '';
  let buf = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function unquote(value) {
  const v = String(value || '').trim();
  if (v.length >= 2 && ((v[0] === '\'' && v.endsWith('\'')) || (v[0] === '"' && v.endsWith('"')))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, '\'');
  }
  return v;
}

function parseValue(raw) {
  const v = String(raw || '').trim();
  if (v.startsWith('{') && v.endsWith('}')) return parseFlowMap(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    return splitTopLevel(v.slice(1, -1)).map((part) => parseValue(part)).filter((x) => x !== '');
  }
  return unquote(v);
}

function parseFlowMap(text) {
  const inner = String(text).trim().replace(/^\{/, '').replace(/\}$/, '');
  const obj = {};
  for (const part of splitTopLevel(inner)) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = unquote(part.slice(0, idx));
    if (!key) continue;
    obj[key] = parseValue(part.slice(idx + 1));
  }
  return obj;
}

/** 把 Clash flow 风格 proxies 列表解析成节点数组 */
function parseProxyYaml(text) {
  const nodes = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*-\s*(\{.*\})\s*$/);
    if (!m) continue;
    try {
      const node = parseFlowMap(m[1]);
      if (node.name && node.server && node.type) nodes.push(node);
    } catch {
      // 忽略无法解析的行
    }
  }
  return nodes;
}

function needsQuote(value) {
  const v = String(value);
  return v === '' || /[,\[\]{}:#&*!|>'"%@`]/.test(v) || /^\s|\s$/.test(v);
}

function yamlValue(value) {
  if (Array.isArray(value)) return `[${value.map(yamlValue).join(', ')}]`;
  if (value && typeof value === 'object') return yamlMap(value);
  const s = String(value);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (/^(true|false)$/i.test(s)) return s.toLowerCase();
  return needsQuote(s) ? `'${s.replace(/'/g, '\'\'')}'` : s;
}

function yamlMap(obj) {
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `{${parts.join(', ')}}`;
}

/** 把节点数组序列化成可交给引擎的 Clash YAML（icon 只用于界面，不写入配置） */
function nodesToYaml(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return 'proxies: []\n';
  const rows = list.map((node) => {
    const clean = { ...node };
    delete clean.icon;
    return `  - ${yamlMap(clean)}`;
  });
  return `proxies:\n${rows.join('\n')}\n`;
}

function normalizeNode(node, index = 0) {
  const source = node && typeof node === 'object' ? node : {};
  const name = String(source.name || '').trim().slice(0, 64) || `节点 ${index + 1}`;
  const server = String(source.server || '').trim();
  const port = Number(source.port);
  const type = String(source.type || '').trim().toLowerCase();
  const icon = source.icon == null ? '' : String(source.icon).slice(0, 64);
  return {
    ...source,
    name,
    server,
    port: Number.isFinite(port) ? Math.trunc(port) : 0,
    type,
    icon,
  };
}

/** 校验并清洗节点列表，返回 {nodes, errors, warnings} */
function normalizeNodes(input) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(input)) {
    return { nodes: [], errors: ['nodes 必须是数组'], warnings };
  }
  if (input.length > 800) {
    return { nodes: [], errors: ['节点数量超过 800，请拆分后再试'], warnings };
  }
  const seen = new Map();
  const nodes = [];
  input.forEach((raw, i) => {
    const node = normalizeNode(raw, i);
    if (!node.server) {
      warnings.push(`第 ${i + 1} 个节点缺少服务器地址，已跳过`);
      return;
    }
    if (!/^[A-Za-z0-9.-]+$/.test(node.server) && !/^[0-9a-f:.]+$/i.test(node.server)) {
      errors.push(`第 ${i + 1} 个节点的服务器地址不合法：${node.server}`);
      return;
    }
    if (!(node.port >= 1 && node.port <= 65535)) {
      errors.push(`第 ${i + 1} 个节点的端口不合法：${node.port}`);
      return;
    }
    if (!SUPPORTED_TYPES.has(node.type)) {
      warnings.push(`第 ${i + 1} 个节点类型 ${node.type || '(空)'} 未识别，已跳过后端校验`);
    }
    const dup = seen.get(node.name);
    if (dup !== undefined) {
      let n = 2;
      let candidate = `${node.name} (${n})`;
      while (seen.has(candidate)) {
        n += 1;
        candidate = `${node.name} (${n})`;
      }
      warnings.push(`节点名重复，已重命名：${node.name} → ${candidate}`);
      node.name = candidate;
    }
    seen.set(node.name, nodes.length);
    nodes.push(node);
  });
  return { nodes, errors, warnings };
}

module.exports = {
  SUPPORTED_TYPES,
  parseFlowMap,
  parseProxyYaml,
  nodesToYaml,
  normalizeNodes,
};
