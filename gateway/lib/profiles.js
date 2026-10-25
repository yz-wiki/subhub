'use strict';

/**
 * 固定订阅（profile）仓库：token -> 源 + 模板 + 参数。
 * 订阅链接只暴露 token，客户端拿不到上游机场地址。
 */

const fs = require('node:fs');
const path = require('node:path');
const { HttpError, newId, nowIso } = require('./util');
const { TARGETS, resolveTarget } = require('./targets');
const { TemplateStore } = require('./templates');
const { normalizeNodes } = require('./nodes');

const MAX_SOURCES = 10;
const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

class ProfileStore {
  constructor({ dataDir, seedDir, logger }) {
    this.file = path.join(dataDir, 'profiles.json');
    this.seedFile = path.join(seedDir, 'profiles.json');
    this.log = logger || (() => {});
    this.profiles = {};
  }

  init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      try {
        if (fs.existsSync(this.seedFile)) fs.copyFileSync(this.seedFile, this.file);
        else fs.writeFileSync(this.file, JSON.stringify({ version: 1, profiles: {} }, null, 2) + '\n');
      } catch (e) {
        this.log('cfg', `初始化 profiles.json 失败：${e.message}`);
        fs.writeFileSync(this.file, JSON.stringify({ version: 1, profiles: {} }, null, 2) + '\n');
      }
    }
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.profiles = parsed && typeof parsed.profiles === 'object' && parsed.profiles ? parsed.profiles : {};
    } catch (e) {
      this.log('cfg', `profiles.json 读取失败：${e.message}`);
      this.profiles = {};
    }
    this.log('cfg', `已加载 ${Object.keys(this.profiles).length} 个固定订阅`);
  }

  persist() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: this.profiles }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.file);
  }

  all() {
    return Object.entries(this.profiles).map(([token, p]) => ({ token, ...p }));
  }

  get(token) {
    return this.profiles[token] || null;
  }

  create(input) {
    const token = input.token || newId(12);
    if (!TOKEN_RE.test(token)) throw new HttpError(400, 'token 只能包含字母、数字、下划线和短横线，长度 6-64');
    if (this.profiles[token]) throw new HttpError(409, '该 token 已存在');
    const profile = this.normalize(input, { partial: false });
    profile.revision = 1;
    profile.createdAt = nowIso();
    profile.updatedAt = profile.createdAt;
    this.profiles[token] = profile;
    this.persist();
    return { token, ...profile };
  }

  update(token, input) {
    const cur = this.profiles[token];
    if (!cur) throw new HttpError(404, '订阅不存在');
    const patch = this.normalize(input, { partial: true, existing: cur });
    const next = {
      ...cur,
      ...patch,
      opts: { ...cur.opts, ...(patch.opts || {}) },
      revision: (cur.revision || 1) + 1,
      updatedAt: nowIso(),
    };
    this.profiles[token] = next;
    this.persist();
    return { token, ...next };
  }

  remove(token) {
    if (!this.profiles[token]) throw new HttpError(404, '订阅不存在');
    delete this.profiles[token];
    this.persist();
  }

  normalize(input, { partial = false, existing = null } = {}) {
    const data = input || {};
    const out = {};
    const pick = (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined);

    const name = pick('name');
    if (name !== undefined) {
      const value = String(name).trim();
      if (!value) throw new HttpError(400, '订阅名称不能为空');
      if (value.length > 60) throw new HttpError(400, '订阅名称不能超过 60 个字符');
      out.name = value;
    } else if (!partial) {
      out.name = '未命名订阅';
    }

    const note = pick('note');
    if (note !== undefined) out.note = String(note).slice(0, 200);

    const sources = pick('sources');
    if (sources !== undefined) {
      if (!Array.isArray(sources)) throw new HttpError(400, 'sources 必须是数组');
      const list = sources.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
      if (list.length > MAX_SOURCES) throw new HttpError(400, `订阅源最多 ${MAX_SOURCES} 个`);
      out.sources = list;
    } else if (!partial) {
      out.sources = [];
    }

    const nodes = pick('nodes');
    if (nodes !== undefined) {
      if (!Array.isArray(nodes)) throw new HttpError(400, 'nodes 必须是数组');
      const cleaned = normalizeNodes(nodes);
      if (cleaned.errors.length) throw new HttpError(400, cleaned.errors[0]);
      out.nodes = cleaned.nodes;
    }
    if (!partial && !(out.sources && out.sources.length) && !(out.nodes && out.nodes.length)) {
      throw new HttpError(400, '至少需要一个订阅源或节点');
    }

    const template = pick('template');
    if (template !== undefined) {
      const value = String(template).trim();
      if (!TemplateStore.isValidName(value)) throw new HttpError(400, '模板名称不合法');
      out.template = value;
    } else if (!partial) {
      out.template = 'full';
    }

    const allowed = pick('allowedTargets');
    if (allowed !== undefined) {
      if (!Array.isArray(allowed)) throw new HttpError(400, 'allowedTargets 必须是数组');
      out.allowedTargets = allowed
        .map((t) => resolveTarget(t))
        .filter(Boolean)
        .map((t) => t.id);
    } else if (!partial) {
      out.allowedTargets = [];
    }

    for (const key of ['include', 'exclude']) {
      const value = pick(key);
      if (value !== undefined) {
        out[key] = String(value).trim().slice(0, 300);
      }
    }

    const opts = pick('opts');
    if (opts !== undefined) {
      if (typeof opts !== 'object' || opts === null) throw new HttpError(400, 'opts 必须是对象');
      const base = (existing && existing.opts) || {};
      out.opts = {
        emoji: opts.emoji === undefined ? base.emoji !== false : opts.emoji !== false,
        udp: opts.udp === undefined ? base.udp !== false : opts.udp !== false,
        tfo: opts.tfo === undefined ? !!base.tfo : !!opts.tfo,
        scv: opts.scv === undefined ? base.scv !== false : opts.scv !== false,
        sort: opts.sort === undefined ? !!base.sort : !!opts.sort,
      };
    } else if (!partial) {
      out.opts = { emoji: true, udp: true, tfo: false, scv: true, sort: false };
    }

    const updateInterval = pick('updateInterval');
    if (updateInterval !== undefined) {
      const n = Number(updateInterval);
      if (!Number.isFinite(n) || n < 1 || n > 168) throw new HttpError(400, '更新间隔需在 1-168 小时之间');
      out.updateInterval = Math.round(n);
    } else if (!partial) {
      out.updateInterval = 6;
    }

    const cacheTtl = pick('cacheTtl');
    if (cacheTtl !== undefined) {
      if (cacheTtl === null || cacheTtl === '') out.cacheTtl = null;
      else {
        const n = Number(cacheTtl);
        if (!Number.isFinite(n) || n < 0 || n > 86400) throw new HttpError(400, '缓存时间需在 0-86400 秒之间');
        out.cacheTtl = Math.round(n);
      }
    }

    const enabled = pick('enabled');
    if (enabled !== undefined) out.enabled = enabled !== false;

    const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
    const RULESET_ID_RE = /^(?:[a-z0-9][a-z0-9-]{0,47}|g[si]:[a-z0-9][a-z0-9._-]{0,63})$/;
    for (const key of ['baseId', 'dnsId']) {
      const value = pick(key);
      if (value === undefined) continue;
      const id = String(value || '').trim();
      if (id && !ID_RE.test(id)) throw new HttpError(400, `${key} 不合法`);
      out[key] = id;
    }

    const rulesets = pick('rulesets') !== undefined ? pick('rulesets') : pick('rulesetIds');
    if (rulesets !== undefined) {
      if (!Array.isArray(rulesets)) throw new HttpError(400, 'rulesets 必须是数组');
      const list = [];
      const seen = new Set();
      for (const raw of rulesets) {
        const ref = raw && typeof raw === 'object' ? raw : { id: raw };
        const id = String(ref.id || '').trim();
        if (!id || seen.has(id) || !RULESET_ID_RE.test(id)) continue;
        seen.add(id);
        const item = { id };
        if (ref.group) item.group = String(ref.group).slice(0, 40);
        if (ref.noResolve !== undefined) item.noResolve = !!ref.noResolve;
        if (Array.isArray(ref.inline) && ref.inline.length) {
          item.inline = ref.inline
            .map((rule) => String(rule).trim())
            .filter((rule) => rule && rule.length <= 300)
            .slice(0, 40);
          if (!item.inline.length) delete item.inline;
        }
        const plain = !item.group && item.noResolve === undefined && !item.inline;
        list.push(plain ? id : item);
      }
      if (list.length > 60) throw new HttpError(400, '规则集最多 60 个');
      out.rulesets = list;
    }

    const allowTargetOverride = pick('allowTargetOverride');
    if (allowTargetOverride !== undefined) out.allowTargetOverride = !!allowTargetOverride;

    return out;
  }
}

function profileView(token, profile, publicBase) {
  const links = { auto: `${publicBase}/s/${token}` };
  for (const t of TARGETS) links[t.id] = `${publicBase}/s/${token}/${t.id}`;
  return {
    token,
    name: profile.name,
    note: profile.note || '',
    sources: profile.sources,
    template: profile.template,
    nodes: profile.nodes || [],
    baseId: profile.baseId || '',
    dnsId: profile.dnsId || '',
    rulesets: profile.rulesets || [],
    allowedTargets: profile.allowedTargets || [],
    include: profile.include || '',
    exclude: profile.exclude || '',
    opts: profile.opts || {},
    updateInterval: profile.updateInterval || 6,
    cacheTtl: profile.cacheTtl === undefined ? null : profile.cacheTtl,
    enabled: profile.enabled !== false,
    allowTargetOverride: !!profile.allowTargetOverride,
    revision: profile.revision || 1,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null,
    links,
  };
}

module.exports = { ProfileStore, profileView, MAX_SOURCES };
