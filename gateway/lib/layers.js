'use strict';

/**
 * 配置分层：在引擎输出上叠加「基础配置」「DNS 配置」「原生规则集」。
 *
 * - mihomo：按顶层 YAML 块合并（不引第三方 YAML 库），并把规则集写成 rule-providers
 * - sing-box：按 JSON 顶层键合并，并把规则集写成 route.rule_set
 * - 其他客户端：规则集改写入 ini（由引擎内联），基础/DNS 跳过并给出提示
 */

const MIHOMO_PROTECTED = new Set(['proxies', 'proxy-groups', 'rules', 'rule-providers']);
const SINGBOX_ALLOWED = new Set(['log', 'dns', 'inbounds', 'ntp', 'experimental', 'certificate', 'endpoints', 'services', 'http_clients', 'route']);

const TOP_KEY = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(\s|$)/;

function splitYamlBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const preamble = [];
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(TOP_KEY);
    if (m) {
      current = { key: m[1], lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, blocks };
}

function joinYamlBlocks({ preamble, blocks }) {
  const head = preamble.join('\n');
  const body = blocks.map((b) => b.lines.join('\n')).join('\n');
  return `${head ? `${head.replace(/\n+$/, '')}\n` : ''}${body}`.replace(/\n{3,}/g, '\n\n');
}

function findBlock(doc, key) {
  return doc.blocks.find((b) => b.key === key) || null;
}

function replaceBlock(doc, key, text) {
  const parsed = splitYamlBlocks(text);
  const first = parsed.blocks[0];
  if (!first) return;
  const existing = findBlock(doc, key);
  if (existing) {
    existing.lines = first.lines;
  } else {
    doc.blocks.push({ key, lines: first.lines });
  }
}

/** 基础配置：合并顶层键，跳过受保护段 */
function mergeYamlBase(body, baseText) {
  if (!baseText) return body;
  const doc = splitYamlBlocks(body);
  const frag = splitYamlBlocks(baseText);
  for (const block of frag.blocks) {
    if (MIHOMO_PROTECTED.has(block.key)) continue;
    if (block.key === 'dns') continue;
    const existing = findBlock(doc, block.key);
    if (existing) existing.lines = block.lines;
    else doc.blocks.push({ key: block.key, lines: block.lines });
  }
  return joinYamlBlocks(doc);
}

/** DNS 配置：替换/追加 dns: 块 */
function mergeYamlDns(body, dnsText) {
  if (!dnsText) return body;
  const frag = splitYamlBlocks(dnsText);
  const block = findBlock(frag, 'dns');
  if (!block) return body;
  const doc = splitYamlBlocks(body);
  const existing = findBlock(doc, 'dns');
  if (existing) existing.lines = block.lines;
  else doc.blocks.unshift({ key: 'dns', lines: block.lines });
  return joinYamlBlocks(doc);
}

function providerBlock(ruleset) {
  const behavior = ruleset.behavior || 'classical';
  const url = ruleset.urls.mihomo || ruleset.urls.clash;
  const format = /\.mrs(\?|$)/i.test(url)
    ? 'mrs'
    : (/\.ya?ml(\?|$)/i.test(url) ? 'yaml' : 'text');
  const key = ruleset.key || ruleset.id;
  return [
    `  ${key}:`,
    '    type: http',
    `    behavior: ${behavior}`,
    `    format: ${format}`,
    `    url: '${url}'`,
    `    path: ./ruleset/${key}.${format}`,
    '    interval: 86400',
  ].join('\n');
}

/** 把 Clash 风格的规则（DOMAIN-SUFFIX,x 等）转成 sing-box 规则对象 */
function clashRulesToSingbox(rules, group) {
  const out = [];
  for (const raw of rules || []) {
    const parts = String(raw).split(',').map((s) => s.trim());
    const type = (parts[0] || '').toUpperCase();
    const value = parts[1];
    if (!value) continue;
    if (type === 'DOMAIN') out.push({ domain: [value], outbound: group });
    else if (type === 'DOMAIN-SUFFIX') out.push({ domain_suffix: [value], outbound: group });
    else if (type === 'DOMAIN-KEYWORD') out.push({ domain_keyword: [value], outbound: group });
    else if (type === 'IP-CIDR' || type === 'IP-CIDR6') out.push({ ip_cidr: [value], outbound: group });
    else if (type === 'GEOIP') out.push({ geoip: [value.toLowerCase()], outbound: group });
  }
  return out;
}

/** 把原生规则集注入 mihomo 输出：rule-providers + rules 顶部 RULE-SET */
function applyMihomoRulesets(body, rulesets) {
  const usable = (rulesets || []).filter((r) => r.urls && (r.urls.mihomo || r.urls.clash));
  const inlineOnly = (rulesets || []).filter((r) => Array.isArray(r.inline) && r.inline.length > 0);
  if (!usable.length && !inlineOnly.length) return { body };
  const doc = splitYamlBlocks(body);
  if (usable.length) {
    let providers = findBlock(doc, 'rule-providers');
    if (!providers) {
      providers = { key: 'rule-providers', lines: ['rule-providers:'] };
      doc.blocks.push(providers);
    }
    for (const ruleset of usable) {
      providers.lines.push(providerBlock(ruleset));
    }
  }
  const rules = findBlock(doc, 'rules');
  if (rules) {
    const injected = [];
    // 保持用户选择的顺序
    for (const r of rulesets || []) {
      const key = r.key || r.id;
      if (r.urls && (r.urls.mihomo || r.urls.clash)) {
        injected.push(`  - RULE-SET,${key},${r.group}${r.noResolve ? ',no-resolve' : ''}`);
      }
      for (const rule of r.inline || []) injected.push(`  - ${rule},${r.group}`);
    }
    rules.lines.splice(1, 0, ...injected);
  }
  return { body: joinYamlBlocks(doc) };
}

function applySingboxLayers(body, { base, dns, rulesets }) {
  let conf;
  try {
    conf = JSON.parse(body);
  } catch {
    return { body, warnings: ['sing-box 输出不是合法 JSON，已跳过基础/DNS 合并'] };
  }
  const warnings = [];

  if (base && base.content) {
    let frag;
    try {
      frag = JSON.parse(base.content);
    } catch {
      warnings.push(`基础配置「${base.name}」不是合法 JSON，已跳过`);
    }
    if (frag && typeof frag === 'object') {
      for (const [key, value] of Object.entries(frag)) {
        if (!SINGBOX_ALLOWED.has(key) || key === 'dns' || key === 'route') continue;
        conf[key] = value;
      }
    }
  }

  if (dns && dns.content) {
    try {
      const frag = JSON.parse(dns.content);
      if (!frag.dns) warnings.push(`DNS 配置「${dns.name}」缺少 dns 键，已跳过`);
      else conf.dns = frag.dns;
    } catch {
      warnings.push(`DNS 配置「${dns.name}」不是合法 JSON，已跳过`);
    }
  }

  const usable = (rulesets || []).filter(
    (r) => (r.urls && r.urls.singbox) || (Array.isArray(r.inline) && r.inline.length > 0),
  );
  if (usable.length) {
    conf.route = conf.route && typeof conf.route === 'object' ? conf.route : {};
    const tags = new Set((conf.outbounds || []).map((o) => o.tag).filter(Boolean));
    const ruleSets = Array.isArray(conf.route.rule_set) ? conf.route.rule_set : [];
    const injectedRules = [];
    for (const ruleset of usable) {
      const key = ruleset.key || ruleset.id;
      if (!tags.has(ruleset.group)) {
        warnings.push(`sing-box：模板里没有策略组「${ruleset.group}」，规则集「${ruleset.name}」已跳过`);
        continue;
      }
      if (ruleset.urls && ruleset.urls.singbox) {
        if (!ruleSets.some((x) => x.tag === key)) {
          ruleSets.push({
            tag: key,
            type: 'remote',
            format: /\.srs(\?|$)/i.test(ruleset.urls.singbox) ? 'binary' : 'source',
            url: ruleset.urls.singbox,
          });
        }
        injectedRules.push({ rule_set: key, outbound: ruleset.group });
      }
      injectedRules.push(...clashRulesToSingbox(ruleset.inline, ruleset.group));
    }
    if (ruleSets.length) conf.route.rule_set = ruleSets;
    if (injectedRules.length) {
      const rules = Array.isArray(conf.route.rules) ? conf.route.rules : [];
      conf.route.rules = [...injectedRules, ...rules];
    }
  }

  return { body: `${JSON.stringify(conf, null, 2)}\n`, warnings };
}

/**
 * 把规则集追加进 ini（给不能原生引用规则集的客户端）。
 * 插入到第一条 FINAL 规则之前，保证兜底规则仍然最后生效。
 */
function appendIniRulesets(iniText, rulesets) {
  const lines = String(iniText || '').split(/\r?\n/);
  const injected = [];
  for (const ruleset of rulesets || []) {
    if (Array.isArray(ruleset.inline) && ruleset.inline.length) {
      for (const rule of ruleset.inline) injected.push(`ruleset=${ruleset.group},[]${rule}`);
    }
    if (ruleset.urls && ruleset.urls.clash) injected.push(`ruleset=${ruleset.group},${ruleset.urls.clash}`);
  }
  if (!injected.length) return iniText;

  let insertAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^ruleset=/.test(lines[i]) && /\[\]FINAL\b/i.test(lines[i])) {
      insertAt = i;
      break;
    }
  }
  if (insertAt < 0) {
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*enable_rule_generator\s*=/.test(lines[i])) {
        insertAt = i;
        break;
      }
    }
  }
  if (insertAt < 0) insertAt = lines.length;
  lines.splice(insertAt, 0, ...injected);
  return lines.join('\n');
}

module.exports = {
  splitYamlBlocks,
  mergeYamlBase,
  mergeYamlDns,
  applyMihomoRulesets,
  applySingboxLayers,
  appendIniRulesets,
};
