'use strict';

/**
 * 内置规则集目录（MetaCubeX/meta-rules-dat）。
 *
 * 目录只存元数据（名称、默认分组、mihomo .mrs / sing-box .srs / 原始 .yaml 地址），
 * 具体规则在需要时按客户端能力选择：
 *   - mihomo：直接用 rule-providers（.mrs）
 *   - sing-box：直接用 route.rule_set（.srs）
 *   - 其他客户端：拉取 .yaml 展开成 DOMAIN-SUFFIX / IP-CIDR 内联进 ini
 */

const fs = require('node:fs');
const path = require('node:path');

const CACHE_TTL = 10 * 60 * 1000;
const MAX_RULES = 6000;
const MAX_FETCH_BYTES = 6 * 1024 * 1024;

function keyOf(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '-');
}

/** 给规则集条目生成展示用标签：类型 / 动作 / 分类 / 分组 / 属性子集 */
function deriveTags(entry) {
  const tags = [entry.kind === 'geoip' ? 'IP' : '域名'];
  if (entry.act) tags.push(String(entry.act));
  if (entry.cat) tags.push(String(entry.cat));
  const group = String(entry.group || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (group && group !== '节点选择') tags.push(group);
  if (entry.empty) tags.push('空集合');
  const name = String(entry.idName || '');
  for (const suffix of ['@cn', '@!cn', '@ads', '@telemetry']) {
    if (name.endsWith(suffix)) tags.push(suffix);
  }
  const out = [];
  for (const t of tags) {
    const clean = String(t).trim().slice(0, 16);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out.slice(0, 6);
}

class RuleCatalog {
  constructor({ seedDir, dataDir, logger = () => {} }) {
    this.logger = logger;
    this.file = path.join(dataDir || seedDir, 'rules-catalog.json');
    this.seedFile = path.join(seedDir, 'rules-catalog.json');
    this.items = [];
    this.byId = new Map();
    this.groups = [];
    this.cache = new Map();
    this.loadedAt = 0;

    try {
      const seedExists = fs.existsSync(this.seedFile);
      if (seedExists) fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const readDoc = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
      let doc = null;
      if (fs.existsSync(this.file)) doc = readDoc(this.file);
      if (seedExists) {
        const seedDoc = readDoc(this.seedFile);
        // 旧版本的数据文件没有中文名/说明（enriched 字段），遇到带注释的新种子就升级；
        // 之后的差异（例如「更新目录」拿到的上游变更）不再用种子覆盖。
        const dataEnriched = doc && Array.isArray(doc.items) && doc.items.some((it) => it && it.zh);
        const seedEnriched = Array.isArray(seedDoc.items) && seedDoc.items.some((it) => it && it.zh);
        const needCopy = !doc
          || (seedEnriched && !dataEnriched)
          || fs.statSync(this.seedFile).mtimeMs > fs.statSync(this.file).mtimeMs + 1000;
        if (needCopy) {
          fs.copyFileSync(this.seedFile, this.file);
          doc = seedDoc;
        }
      }
      if (!doc) throw new Error('目录文件不存在');
      this.load(doc);
      this.loadedAt = Date.now();
      this.logger('catalog', `已加载内置规则集目录 ${this.items.length} 条`);
    } catch (e) {
      this.logger('catalog', `规则集目录加载失败：${e.message}`);
    }
  }

  load(doc) {
    const seen = new Set();
    const items = [];
    for (const raw of Array.isArray(doc && doc.items) ? doc.items : []) {
      if (!raw || !raw.id || seen.has(raw.id)) continue;
      seen.add(raw.id);
      const entry = {
        id: String(raw.id),
        key: keyOf(raw.id),
        name: String(raw.label || raw.name || raw.id),
        idName: String(raw.name || raw.id),
        kind: raw.kind === 'geoip' ? 'geoip' : 'geosite',
        group: String(raw.group || '🚀 节点选择'),
        behavior: raw.behavior || (raw.kind === 'geoip' ? 'ipcidr' : 'domain'),
        noResolve: !!raw.noResolve,
        urls: raw.urls && typeof raw.urls === 'object' ? raw.urls : {},
        source: 'catalog',
        builtin: true,
      };
      if (raw.zh) entry.zh = String(raw.zh);
      if (raw.cat) entry.cat = String(raw.cat);
      if (Number.isFinite(raw.cnt)) entry.cnt = Number(raw.cnt);
      if (raw.desc) entry.desc = String(raw.desc);
      if (raw.act) entry.act = String(raw.act);
      if (raw.sample) entry.sample = String(raw.sample);
      if (raw.empty) entry.empty = true;
      entry.tags = deriveTags(entry);
      items.push(entry);
    }
    this.items = items;
    this.byId = new Map(items.map((it) => [it.id, it]));
    const counter = new Map();
    for (const it of items) counter.set(it.group, (counter.get(it.group) || 0) + 1);
    this.groups = [...counter.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count);
  }

  get total() {
    return this.items.length;
  }

  summary() {
    return {
      count: this.items.length,
      groups: this.groups,
      kinds: [
        { id: 'geosite', label: '域名', count: this.items.filter((i) => i.kind === 'geosite').length },
        { id: 'geoip', label: 'IP', count: this.items.filter((i) => i.kind === 'geoip').length },
      ],
      generatedAt: this.loadedAt,
    };
  }

  get(id) {
    return this.byId.get(String(id)) || null;
  }

  /** 关键词/分组/类型过滤，按相关度排序 */
  search({ q = '', kind = '', group = '', limit = 40, offset = 0 } = {}) {
    const query = String(q || '').trim().toLowerCase();
    const wantedKind = String(kind || '').trim();
    const wantedGroup = String(group || '').trim();

    let pool = this.items;
    if (wantedKind) pool = pool.filter((i) => i.kind === wantedKind);
    if (wantedGroup) {
      pool = pool.filter((i) => i.group === wantedGroup || i.group.includes(wantedGroup));
    }
    if (query) {
      const score = (item) => {
        const name = item.idName.toLowerCase();
        const label = item.name.toLowerCase();
        const id = item.id.toLowerCase();
        const zh = (item.zh || '').toLowerCase();
        if (name === query || label === query || zh === query) return 0;
        if (name.startsWith(query) || label.startsWith(query) || zh.startsWith(query)) return 1;
        if (id.includes(query)) return 2;
        if (label.includes(query) || zh.includes(query)) return 3;
        if (item.group.toLowerCase().includes(query)) return 4;
        if ((item.desc || '').toLowerCase().includes(query)) return 5;
        return -1;
      };
      pool = pool
        .map((item) => ({ item, s: score(item) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.item.idName.localeCompare(b.item.idName))
        .map((x) => x.item);
    }

    const total = pool.length;
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(200, Math.max(1, Number(limit) || 40));
    return {
      total,
      offset: start,
      limit: size,
      items: pool.slice(start, start + size),
    };
  }

  /** 把 .yaml 规则集展开成 Clash 风格规则（带缓存） */
  async expand(entry, { timeout = 20000 } = {}) {
    if (!entry || !entry.urls || !entry.urls.raw) return [];
    const cached = this.cache.get(entry.id);
    if (cached && cached.expires > Date.now()) return cached.rules;
    if (cached && cached.pending) return cached.pending;

    const pending = (async () => {
      const res = await fetch(entry.urls.raw, {
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': 'subhub-gateway/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_FETCH_BYTES) throw new Error('规则集文件过大');
      const rules = this.parseRules(text, entry);
      return rules;
    })();

    this.cache.set(entry.id, { pending, expires: Date.now() + CACHE_TTL, rules: null });
    try {
      const rules = await pending;
      this.cache.set(entry.id, { rules, expires: Date.now() + CACHE_TTL });
      if (this.cache.size > 400) {
        const now = Date.now();
        for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
      }
      return rules;
    } catch (e) {
      this.cache.delete(entry.id);
      throw e;
    }
  }

  /**
   * 从 MetaCubeX/meta-rules-dat 重新生成目录（GitHub Trees API）。
   * 旧条目的中文名/说明/分组会按 id 保留下来。
   */
  async refresh({ timeout = 25000 } = {}) {
    const api = 'https://api.github.com/repos/MetaCubeX/meta-rules-dat/git/trees/';
    const getTree = async (ref) => {
      const res = await fetch(`${api}${ref}`, {
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': 'subhub-gateway/1.0', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
      const doc = await res.json();
      return Array.isArray(doc.tree) ? doc.tree : [];
    };
    const namesOf = (tree, ext) => {
      const out = [];
      for (const node of tree) {
        if (!node || node.type !== 'blob' || !node.path) continue;
        if (!node.path.endsWith(ext)) continue;
        out.push(node.path.slice(0, -ext.length));
      }
      return out;
    };

    const metaRoot = await getTree('meta');
    const singRoot = await getTree('sing');
    const pick = (tree, name) => (tree.find((n) => n.path === name) || {}).sha;
    const metaGeo = pick(metaRoot, 'geo');
    const singGeo = pick(singRoot, 'geo');
    if (!metaGeo || !singGeo) throw new Error('仓库结构变化，找不到 geo 目录');

    const metaGeoTree = await getTree(metaGeo);
    const singGeoTree = await getTree(singGeo);
    const metaSite = pick(metaGeoTree, 'geosite');
    const metaIp = pick(metaGeoTree, 'geoip');
    const singSite = pick(singGeoTree, 'geosite');
    const singIp = pick(singGeoTree, 'geoip');
    if (!metaSite || !metaIp) throw new Error('仓库结构变化，找不到 geosite/geoip');

    const [siteTree, ipTree, singSiteTree, singIpTree] = await Promise.all([
      getTree(metaSite),
      getTree(metaIp),
      singSite ? getTree(singSite) : Promise.resolve([]),
      singIp ? getTree(singIp) : Promise.resolve([]),
    ]);
    const siteNames = namesOf(siteTree, '.mrs');
    const ipNames = namesOf(ipTree, '.mrs');
    const singSiteNames = new Set(namesOf(singSiteTree, '.srs'));
    const singIpNames = new Set(namesOf(singIpTree, '.srs'));

    const prev = new Map(this.items.map((it) => [it.id, it]));
    const base = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat';
    const items = [];
    const push = (kind, name) => {
      const id = `${kind === 'geosite' ? 'gs' : 'gi'}:${name}`;
      const old = prev.get(id) || {};
      const dir = kind === 'geosite' ? 'geosite' : 'geoip';
      const hasSite = kind === 'geosite' ? singSiteNames.has(name) : singIpNames.has(name);
      let group = old.group;
      if (!group) {
        if (/^(cn|private)$/.test(name)) group = '🎯 全球直连';
        else if (/ad|ads/.test(name)) group = '🛑 广告拦截';
        else group = '🚀 节点选择';
      }
      const item = {
        id,
        name,
        label: old.name && old.name !== id ? old.name : name,
        kind,
        group,
        behavior: kind === 'geoip' ? 'ipcidr' : 'domain',
        noResolve: kind === 'geoip',
        urls: {
          mihomo: `${base}/meta/geo/${dir}/${name}.mrs`,
          singbox: hasSite ? `${base}/sing/geo/${dir}/${name}.srs` : '',
          raw: `${base}/meta/geo/${dir}/${name}.yaml`,
        },
      };
      for (const k of ['zh', 'cat', 'cnt', 'desc', 'act', 'sample']) if (old[k] !== undefined) item[k] = old[k];
      if (old.empty) item.empty = true;
      items.push(item);
    };

    for (const n of siteNames) push('geosite', n);
    for (const n of ipNames) push('geoip', n);
    items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'geosite' ? -1 : 1));

    const doc = {
      version: 2,
      source: 'https://github.com/MetaCubeX/meta-rules-dat',
      count: items.length,
      generatedAt: new Date().toISOString(),
      items,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
    fs.renameSync(tmp, this.file);
    this.load(doc);
    this.loadedAt = Date.now();
    this.cache.clear();
    this.logger('catalog', `规则集目录已更新：${items.length} 条`);
    return this.summary();
  }

  parseRules(text, entry) {
    const out = [];
    const seen = new Set();
    const isIp = entry.behavior === 'ipcidr' || entry.kind === 'geoip';
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith('#') || line === 'payload:') continue;
      line = line.replace(/^-\s+/, '').replace(/^['"]|['"]$/g, '').trim();
      if (!line || line.startsWith('#')) continue;
      let rule;
      if (isIp) {
        if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(line)) continue;
        rule = `IP-CIDR,${line},no-resolve`;
      } else {
        const value = line.replace(/^\+\.[.\s]*/, '').replace(/^\*\./, '').replace(/^\./, '').trim();
        if (!value || !/^[^\s,]+$/.test(value)) continue;
        rule = `DOMAIN-SUFFIX,${value}`;
      }
      if (seen.has(rule)) continue;
      seen.add(rule);
      out.push(rule);
      if (out.length >= MAX_RULES) break;
    }
    return out;
  }
}

module.exports = { RuleCatalog, keyOf };
