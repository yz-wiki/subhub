'use strict';

/**
 * subconverter [custom] ini 的可视化模型：
 *   custom_proxy_group / ruleset  <->  结构化 JSON
 *
 * 目标：让 Web 编辑器可以像 SubBoost 一样拖拽配置策略组与规则，
 * 又保留 ini 里其它指令（enable_rule_generator 等）原样往返。
 */

const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance', 'relay'];

const RULE_TYPES = [
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
  'GEOIP', 'IP-ASN', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'SRC-PORT', 'DST-PORT',
  'PROCESS-NAME', 'PROCESS-PATH', 'URL-REGEX', 'USER-AGENT', 'RULE-SET',
  'AND', 'OR', 'NOT', 'MATCH', 'FINAL',
];

const BUILTIN_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];

const META_RE = /^[;#]\s*@([A-Za-z][\w-]*)\s*(.*)$/;

function normalizeNewlines(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
}

/** 读取文件顶部的 `; @key value` 元数据（不解析正文） */
function parseMeta(text) {
  const meta = {};
  const lines = normalizeNewlines(text).split('\n').slice(0, 80);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith(';') && !line.startsWith('#')) break;
    const m = line.match(META_RE);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}

function parseGroupArgs(seg) {
  // seg: ['name','type', ...args]
  const name = String(seg[0] || '').trim();
  const type = String(seg[1] || '').trim().toLowerCase();
  const args = seg.slice(2).map((s) => String(s == null ? '' : s));
  const group = { name, type, refs: [], patterns: [], url: '', interval: '', tolerance: '' };

  if (type === 'select') {
    for (const raw of args) {
      const arg = raw.trim();
      if (!arg) continue;
      if (arg.startsWith('[]')) {
        group.refs.push(arg.slice(2).trim());
      } else if (/^(DIRECT|REJECT|REJECT-DROP|PASS|COMPATIBLE)$/i.test(arg)) {
        group.refs.push(arg.toUpperCase());
      } else {
        group.patterns.push(arg);
      }
    }
    return group;
  }

  if (type === 'relay') {
    // 中转组：成员按顺序串联（Clash relay / mihomo 的 dialer-proxy 链）
    for (const raw of args) {
      const arg = raw.trim().replace(/^\[\]\s*/, '');
      if (arg) group.refs.push(arg);
    }
    return group;
  }

  group.patterns = args[0] && args[0].trim() ? [args[0].trim()] : [];
  group.url = (args[1] || '').trim();
  const timing = (args[2] || '').trim();
  if (timing) {
    const parts = timing.split(',');
    group.interval = parts[0] || '';
    if (parts.length >= 3) group.tolerance = parts[2] || '';
    else if (parts.length === 2) group.tolerance = parts[1] || '';
  }
  return group;
}

function parseRuleLine(line) {
  const rest = line.slice('ruleset='.length);
  const comma = rest.indexOf(',');
  if (comma < 0) return null;
  const target = rest.slice(0, comma).trim();
  const value = rest.slice(comma + 1).trim();
  if (!target || !value) return null;

  if (/^https?:\/\//i.test(value)) {
    return { target, kind: 'url', type: 'URL', value, options: [] };
  }
  if (!value.startsWith('[]')) return null;

  const inner = value.slice(2);
  const parts = inner.split(',').map((s) => s.trim());
  const type = (parts.shift() || '').toUpperCase();
  if (!type) return null;
  let options = [];
  let val = parts.join(',');
  if (['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'GEOIP', 'IP-ASN'].includes(type)) {
    const last = parts[parts.length - 1];
    if (last && /^(no-resolve|src)$/i.test(last)) {
      options = [last.toLowerCase()];
      val = parts.slice(0, -1).join(',');
    }
  }
  return { target, kind: 'inline', type, value: val, options };
}

function parseIni(text) {
  const src = normalizeNewlines(text);
  const model = {
    meta: {
      title: '',
      description: '',
      targets: [],
      author: '',
      version: '',
      extra: {},
    },
    groups: [],
    rules: [],
    extras: [],
    warnings: [],
  };

  const rawMeta = parseMeta(src);
  model.meta.title = rawMeta.title || '';
  model.meta.description = rawMeta.description || '';
  model.meta.targets = (rawMeta.targets || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  model.meta.author = rawMeta.author || '';
  model.meta.version = rawMeta.version || '';
  for (const [k, v] of Object.entries(rawMeta)) {
    if (!['title', 'description', 'targets', 'author', 'version'].includes(k)) model.meta.extra[k] = v;
  }

  const lines = src.split('\n');
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) return;
    if (line === '[custom]' || line === '[Custom]' || line === '[CUSTOM]') return;
    if (line.startsWith('[') && line.endsWith(']')) {
      model.extras.push(line);
      return;
    }
    if (line.startsWith('custom_proxy_group=')) {
      const seg = line.slice('custom_proxy_group='.length).split('`');
      const group = parseGroupArgs(seg);
      if (!group.name || !group.type) {
        model.warnings.push(`第 ${idx + 1} 行策略组缺少名称或类型，已忽略`);
        return;
      }
      if (!GROUP_TYPES.includes(group.type)) {
        model.warnings.push(`第 ${idx + 1} 行策略组「${group.name}」类型 ${group.type} 暂不支持可视化，已保留为原始指令`);
        model.extras.push(line);
        return;
      }
      model.groups.push(group);
      return;
    }
    if (line.startsWith('ruleset=')) {
      const rule = parseRuleLine(line);
      if (!rule) {
        model.warnings.push(`第 ${idx + 1} 行规则无法解析，已保留为原始指令`);
        model.extras.push(line);
        return;
      }
      model.rules.push(rule);
      return;
    }
    model.extras.push(line);
  });

  return model;
}

function buildGroup(group) {
  const name = String(group.name || '').trim();
  const type = String(group.type || 'select').trim();
  if (!name) return '';
  if (type === 'select') {
    const refs = (group.refs || []).map((r) => `[]${r}`);
    const patterns = (group.patterns || []).filter(Boolean);
    return `custom_proxy_group=${[name, 'select', ...refs, ...patterns].join('`')}`;
  }
  if (type === 'relay') {
    // 中转组：`custom_proxy_group=名称`relay`节点A`节点B`
    const members = (group.refs || []).map((r) => String(r || '').trim()).filter(Boolean);
    if (!members.length) return '';
    return `custom_proxy_group=${[name, 'relay', ...members].join('`')}`;
  }
  const pattern = (group.patterns && group.patterns[0]) || '.*';
  const url = group.url || 'http://www.gstatic.com/generate_204';
  const interval = String(group.interval || 300);
  const tolerance = String(group.tolerance || 50);
  if (type === 'url-test') {
    return `custom_proxy_group=${[name, type, pattern, url, `${interval},,${tolerance}`].join('`')}`;
  }
  return `custom_proxy_group=${[name, type, pattern, url, interval].join('`')}`;
}

function buildRule(rule) {
  const target = String(rule.target || '').trim();
  if (!target) return '';
  if (rule.kind === 'url') {
    const url = String(rule.value || '').trim();
    if (!/^https?:\/\//i.test(url)) return '';
    return `ruleset=${target},${url}`;
  }
  const type = String(rule.type || '').toUpperCase().trim();
  if (!type) return '';
  const value = String(rule.value == null ? '' : rule.value).trim();
  const options = Array.isArray(rule.options) ? rule.options.filter(Boolean) : [];
  let inline = `[]${type}`;
  if (value) inline += `,${value}`;
  if (options.length) inline += `,${options.join(',')}`;
  return `ruleset=${target},${inline}`;
}

function buildIni(model) {
  const out = [];
  const meta = model.meta || {};
  out.push('; SubHub 订阅模板 · 可在 Web 可视化编辑器中修改');
  out.push(`; @title ${oneLine(meta.title || '未命名模板')}`);
  out.push(`; @description ${oneLine(meta.description || '')}`);
  const targets = Array.isArray(meta.targets) ? meta.targets.filter(Boolean) : [];
  out.push(`; @targets ${targets.join(',')}`);
  if (meta.author) out.push(`; @author ${oneLine(meta.author)}`);
  if (meta.version) out.push(`; @version ${oneLine(meta.version)}`);
  for (const [k, v] of Object.entries(meta.extra || {})) {
    if (/^[a-z][\w-]*$/i.test(k)) out.push(`; @${k} ${oneLine(v)}`);
  }
  out.push('');
  out.push('[custom]');
  out.push('');

  for (const group of model.groups || []) {
    const line = buildGroup(group);
    if (line) out.push(line);
  }
  out.push('');
  for (const rule of model.rules || []) {
    const line = buildRule(rule);
    if (line) out.push(line);
  }
  out.push('');
  for (const extra of model.extras || []) {
    const line = String(extra || '').trim();
    if (line) out.push(line);
  }
  out.push('');
  return out.join('\n');
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
}

/** 校验模型，返回 { ok, errors, warnings } */
function validateModel(model, { targetIds = [] } = {}) {
  const errors = [];
  const warnings = Array.isArray(model.warnings) ? [...model.warnings] : [];
  const groups = Array.isArray(model.groups) ? model.groups : [];
  const rules = Array.isArray(model.rules) ? model.rules : [];

  const names = new Set();
  for (const g of groups) {
    const name = String(g.name || '').trim();
    if (!name) errors.push('存在未命名策略组');
    else if (names.has(name)) errors.push(`策略组名称重复：${name}`);
    else names.add(name);
    if (!GROUP_TYPES.includes(g.type)) errors.push(`策略组「${name}」类型不支持：${g.type}`);
    if (g.type === 'relay') {
      const members = (g.refs || []).map((m) => String(m || '').trim()).filter(Boolean);
      if (members.length < 2) errors.push(`中转组「${name}」至少需要 2 个成员（按顺序串联）`);
      if (members.some((m) => BUILTIN_TARGETS.includes(m))) errors.push(`中转组「${name}」不能包含 DIRECT / REJECT 等内置出站`);
    }
    if (['url-test', 'fallback', 'load-balance'].includes(g.type) && !/^https?:\/\//i.test(g.url || '')) {
      errors.push(`策略组「${name}」的测速地址必须是 http(s) URL`);
    }
  }

  for (const g of groups) {
    if (g.type !== 'select') continue;
    for (const ref of g.refs || []) {
      if (BUILTIN_TARGETS.includes(ref) || names.has(ref)) continue;
      // 允许直接引用节点（节点来自订阅，模板里无法预知名字），仅提示不阻塞
      warnings.push(`策略组「${g.name}」的成员「${ref}」不是已定义的策略组，将按节点名引用`);
    }
  }

  // 循环引用检测
  const graph = new Map();
  for (const g of groups) graph.set(g.name, (g.refs || []).filter((r) => names.has(r)));
  const state = new Map();
  const walk = (node, stack) => {
    if (state.get(node) === 1) {
      errors.push(`策略组存在循环引用：${[...stack, node].join(' → ')}`);
      return;
    }
    if (state.get(node) === 2) return;
    state.set(node, 1);
    for (const next of graph.get(node) || []) walk(next, [...stack, node]);
    state.set(node, 2);
  };
  for (const name of names) walk(name, []);

  for (const r of rules) {
    const target = String(r.target || '').trim();
    if (!target) errors.push('存在未指定目标组的规则');
    else if (!names.has(target) && !BUILTIN_TARGETS.includes(target) && !['DIRECT', 'REJECT'].includes(target)) {
      errors.push(`规则引用了不存在的组：${target}`);
    }
    if (r.kind === 'url') {
      if (!/^https?:\/\//i.test(r.value || '')) errors.push(`规则集地址不合法：${r.value}`);
    } else if (!String(r.type || '').trim()) {
      errors.push('存在缺少类型的规则');
    } else if (!RULE_TYPES.includes(String(r.type).toUpperCase())) {
      warnings.push(`规则类型 ${r.type} 不在常用列表内，请确认目标客户端支持`);
    }
  }

  if (Array.isArray(model.meta && model.meta.targets) && targetIds.length) {
    for (const t of model.meta.targets) {
      if (!targetIds.includes(t)) warnings.push(`模板声明了未知客户端：${t}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function starterTemplate({ title = '新模板' } = {}) {
  return buildIni({
    meta: {
      title,
      description: '在可视化编辑器中配置策略组与规则',
      targets: ['mihomo', 'singbox', 'surge', 'loon', 'quanx'],
      author: '',
      version: '1',
      extra: {},
    },
    groups: [
      { name: '🚀 节点选择', type: 'select', refs: ['♻️ 自动选择', 'DIRECT'], patterns: [] },
      { name: '♻️ 自动选择', type: 'url-test', refs: [], patterns: ['.*'], url: 'http://www.gstatic.com/generate_204', interval: '300', tolerance: '50' },
      { name: '🐟 漏网之鱼', type: 'select', refs: ['🚀 节点选择', 'DIRECT'], patterns: [] },
    ],
    rules: [
      { target: '🚀 节点选择', kind: 'inline', type: 'GEOIP', value: 'CN', options: [] },
      { target: '🐟 漏网之鱼', kind: 'inline', type: 'FINAL', value: '', options: [] },
    ],
    extras: ['enable_rule_generator=true', 'overwrite_original_rules=true'],
    warnings: [],
  });
}

module.exports = {
  GROUP_TYPES,
  RULE_TYPES,
  BUILTIN_TARGETS,
  parseMeta,
  parseIni,
  buildIni,
  validateModel,
  starterTemplate,
};
