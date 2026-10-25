'use strict';

/**
 * 资源库：规则集（ruleset）、基础配置（base）、DNS 配置（dns）、来源仓库（repo）。
 * 存成一个 JSON 文件，首次启动从 seed 复制；写入原子化。
 */

const fs = require('fs');
const path = require('path');
const { HttpError, log: baseLog, newId, sha1 } = require('./util');

const KINDS = ['ruleset', 'base', 'dns', 'repo'];
const FORMATS = ['mihomo', 'singbox', 'any'];
const BEHAVIORS = ['domain', 'ipcidr', 'classical'];
const MAX_CONTENT = 64 * 1024;
const MAX_ITEMS = 400;
const CAT_COLORS = ['#6d7dff', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#ef4444', '#14b8a6', '#f97316', '#8b5cf6'];
const UPDATE_MODES = ['replace', 'append', 'check'];

/** 从 URL 猜规则集格式：mrs / srs 为官方编译二进制，其余按文本规则集处理。 */
function detectRulesetFormat(url) {
  const s = String(url || '').toLowerCase();
  if (/\.mrs(\?|#|$)/.test(s)) return 'mrs';
  if (/\.srs(\?|#|$)/.test(s)) return 'srs';
  if (/\.ya?ml(\?|#|$)/.test(s)) return 'yaml';
  if (/\.(list|txt|conf)(\?|#|$)/.test(s)) return 'text';
  return 'text';
}

function isValidId(value) {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(String(value || ''));
}

function slugify(value) {
  const base = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || `item-${newId(4).toLowerCase()}`;
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new HttpError(404, `未知的资源类型：${kind}`);
}

function cleanUrl(value, field) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.length > 2048) throw new HttpError(400, `${field} 太长了`);
  if (!/^https?:\/\//i.test(s)) throw new HttpError(400, `${field} 必须以 http:// 或 https:// 开头`);
  return s;
}

class LibraryStore {
  constructor({ dataDir, seedDir, logger }) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'library.json');
    this.seedFile = path.join(seedDir || path.join(__dirname, '..', 'seed'), 'library.json');
    this.log = logger || baseLog;
    this.data = {
      version: 1,
      settings: { autoUpdate: true, mode: 'item', scope: 'all', defaultMode: 'check', intervalHours: 24 },
      items: { ruleset: [], base: [], dns: [], repo: [] },
    };
    this._rev = null;
    this._revAt = 0;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      if (fs.existsSync(this.seedFile)) {
        fs.copyFileSync(this.seedFile, this.file);
        this.log('lib', '已初始化资源库（内置规则集 / 基础配置 / DNS）');
      } else {
        this.persist();
      }
    }
    this.load();
    this.syncBuiltins();
  }

  /** 把 seed 里的内置条目同步进来（新增/更新内置，保留用户自建） */
  syncBuiltins() {
    if (!fs.existsSync(this.seedFile)) return;
    let seed;
    try {
      seed = JSON.parse(fs.readFileSync(this.seedFile, 'utf8'));
    } catch (e) {
      this.log('err', `内置资源库解析失败：${e.message}`);
      return;
    }
    const seedItems = (seed && seed.items) || {};
    let changed = false;
    for (const kind of KINDS) {
      const withRepo = (item) => {
        if (kind === 'ruleset' && !item.repo) {
          const u = item.urls || {};
          item.repo = /meta-rules-dat/i.test(u.mihomo || u.singbox || '') ? 'MetaCubeX'
            : /blackmatrix7/i.test(u.clash || '') ? 'blackmatrix7'
              : item.builtin ? '内置' : '自建';
        }
        return item;
      };
      const wanted = (Array.isArray(seedItems[kind]) ? seedItems[kind] : [])
        .filter((x) => x && x.builtin && x.id)
        .map(withRepo);
      const current = this.data.items[kind];
      const byId = new Map(current.map((x) => [x.id, x]));
      const next = [];
      for (const item of wanted) {
        const existing = byId.get(item.id);
        byId.delete(item.id);
        if (!existing) {
          next.push(item);
          changed = true;
          continue;
        }
        if (existing.builtin && JSON.stringify(existing) !== JSON.stringify(item)) {
          next.push(item);
          changed = true;
          continue;
        }
        next.push(existing);
      }
      // 内置条目在 seed 里被移除时一并移除，用户自建原样保留
      for (const item of byId.values()) {
        if (!item.builtin) next.push(item);
        else changed = true;
      }
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        this.data.items[kind] = next;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
      this.log('lib', '已同步内置资源库');
    }
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const items = parsed && parsed.items && typeof parsed.items === 'object' ? parsed.items : {};
      this.data = {
        version: 1,
        cats: Array.isArray(parsed && parsed.cats) ? parsed.cats : [],
        settings: {
          autoUpdate: parsed?.settings?.autoUpdate !== false,
          mode: ['item', 'global'].includes(parsed?.settings?.mode) ? parsed.settings.mode : 'item',
          scope: ['all', 'builtin', 'custom'].includes(parsed?.settings?.scope) ? parsed.settings.scope : 'all',
          defaultMode: UPDATE_MODES.includes(parsed?.settings?.defaultMode) ? parsed.settings.defaultMode : 'check',
          intervalHours: Math.min(720, Math.max(1, Number(parsed?.settings?.intervalHours) || 24)),
        },
        items: {
          ruleset: Array.isArray(items.ruleset) ? items.ruleset : [],
          base: Array.isArray(items.base) ? items.base : [],
          dns: Array.isArray(items.dns) ? items.dns : [],
          repo: Array.isArray(items.repo) ? items.repo : [],
        },
      };
    } catch (e) {
      this.log('err', `资源库文件损坏，已重置：${e.message}`);
      this.data = { version: 1, cats: [], settings: { autoUpdate: true, mode: 'item', scope: 'all', defaultMode: 'check', intervalHours: 24 }, items: { ruleset: [], base: [], dns: [], repo: [] } };
      this.persist();
    }
    // 旧数据补上来源仓库标签，便于界面区分官方 / 第三方 / 自建
    for (const it of this.data.items.ruleset) {
      if (!it.repo) {
        const urls = it.urls || {};
        it.repo = /meta-rules-dat/i.test(urls.mihomo || urls.singbox || '') ? 'MetaCubeX'
          : /blackmatrix7/i.test(urls.clash || '') ? 'blackmatrix7'
            : it.builtin ? '内置' : '自建';
      }
    }
    // 只保留 mihomo 官方规则源：清理 blackmatrix7 / ios_rule_script 的历史数据
    const dropThirdParty = (it) => /blackmatrix7|ios_rule_script/i.test(`${it.repo || ''} ${JSON.stringify(it.urls || {})}`);
    const keptRulesets = this.data.items.ruleset.filter((it) => !dropThirdParty(it));
    const keptRepos = this.data.items.repo.filter((it) => !/blackmatrix7|ios_rule_script/i.test(it.name || ''));
    if (keptRulesets.length !== this.data.items.ruleset.length || keptRepos.length !== this.data.items.repo.length) {
      const removed = this.data.items.ruleset.length - keptRulesets.length + this.data.items.repo.length - keptRepos.length;
      this.data.items.ruleset = keptRulesets;
      this.data.items.repo = keptRepos;
      this.persist();
      this.log('ok', `已移除第三方规则集来源 ${removed} 项，仅保留 mihomo 官方规则源`);
    }
    this.ensurePresets();
  }

  /** 预置常用 MetaCubeX 官方规则集（缺失时补齐，不覆盖用户修改） */
  ensurePresets() {
    const base = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo';
    const presets = [
      ['adblock', '广告拦截', '广告', 'geosite/category-ads-all.mrs', '常见广告联盟、追踪与推广域名。', ['广告', '拦截', '去广告']],
      ['privacy', '隐私防护', '广告', 'geosite/category-ads-all.mrs', '隐私追踪与统计域名集合。', ['隐私', '追踪']],
      ['proxy', '国外网站', '常用', 'geosite/geolocation-!cn.mrs', '常见境外站点，适合走代理。', ['国外', '代理']],
      ['cn-domain', '国内域名', '国内', 'geosite/cn.mrs', '中国大陆常见域名，直连优先。', ['国内', '直连']],
      ['cn-ip', '国内 IP', '国内', 'geoip/cn.mrs', '中国大陆 IP 段。', ['国内', 'IP']],
      ['telegram', 'Telegram', '社交', 'geosite/telegram.mrs', 'Telegram 域名与 IP。', ['社交', 'Telegram']],
      ['youtube', 'YouTube', '流媒体', 'geosite/youtube.mrs', 'YouTube 域名与 CDN。', ['流媒体', 'YouTube']],
      ['netflix', 'Netflix', '流媒体', 'geosite/netflix.mrs', 'Netflix 域名与 CDN。', ['流媒体', 'Netflix']],
      ['disney', 'Disney+', '流媒体', 'geosite/disney.mrs', 'Disney+ 与相关流媒体域名。', ['流媒体', 'Disney']],
      ['openai', 'OpenAI', 'AI', 'geosite/openai.mrs', 'OpenAI、ChatGPT 相关域名。', ['AI', 'OpenAI']],
      ['apple', 'Apple 服务', '常用', 'geosite/apple.mrs', 'Apple 推送、App Store、iCloud 等域名。', ['Apple', '服务']],
      ['microsoft', '微软服务', '常用', 'geosite/microsoft.mrs', '微软账号、Office、OneDrive 等域名。', ['微软', '服务']],
      ['google', '谷歌服务', '常用', 'geosite/google.mrs', 'Google 搜索、Gmail、Google Play 等域名。', ['谷歌', '服务']],
      ['github', 'GitHub', '开发', 'geosite/github.mrs', 'GitHub 与 GitHub Pages 域名。', ['开发', 'GitHub']],
      ['spotify', 'Spotify', '音乐', 'geosite/spotify.mrs', 'Spotify 域名。', ['音乐', 'Spotify']],
      ['steam', 'Steam', '游戏', 'geosite/steam.mrs', 'Steam 商店与社区域名。', ['游戏', 'Steam']],
    ];
    let added = 0;
    for (const [id, name, cat, file, desc, tags] of presets) {
      const key = `preset-${id}`;
      if (this.data.items.ruleset.some((it) => it.id === key)) continue;
      this.data.items.ruleset.push({
        id: key, name, cat, group: '', desc, tags: ['预置', ...tags],
        behavior: /geoip\//.test(file) ? 'ipcidr' : 'domain',
        format: 'mrs', preset: true, builtin: false, repo: 'MetaCubeX',
        autoUpdate: true, updateMode: 'replace', intervalHours: 24,
        urls: { mihomo: `${base}/${file}`, singbox: '', clash: '' },
      });
      added += 1;
    }
    if (added) {
      this.persist();
      this.log('ok', `已补齐 ${added} 条预置常用规则集`);
    }
  }

  persist() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
    this._rev = null;
  }

  revision() {
    const now = Date.now();
    if (this._rev && now - this._revAt < 500) return this._rev;
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return 'none';
    }
    this._rev = sha1(`${stat.mtimeMs}:${stat.size}:${KINDS.map((k) => this.data.items[k].length).join(',')}`).slice(0, 12);
    this._revAt = now;
    return this._rev;
  }

  list(kind, { withContent = true } = {}) {
    assertKind(kind);
    return this.data.items[kind].map((item) => (withContent ? item : this.summarize(kind, item)));
  }

  /** 分类：以规则集的 cat 字段为准，显式 cats 只补充颜色/排序/空分类。 */
  listCats({ withCount = true } = {}) {
    const counts = new Map();
    for (const it of this.data.items.ruleset) {
      const name = String(it.cat || '未分类').trim() || '未分类';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const out = [];
    const seen = new Set();
    for (const [i, c] of (Array.isArray(this.data.cats) ? this.data.cats : []).entries()) {
      const name = String(c && c.name ? c.name : '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        color: /^#[0-9a-f]{3,8}$/i.test(String(c.color || '')) ? c.color : CAT_COLORS[i % CAT_COLORS.length],
        order: Number.isFinite(c.order) ? c.order : i,
        count: counts.get(name) || 0,
      });
    }
    let extra = 0;
    for (const name of counts.keys()) {
      if (seen.has(name)) continue;
      out.push({ name, color: CAT_COLORS[(out.length + extra) % CAT_COLORS.length], order: 1000 + out.length, count: counts.get(name) });
      extra += 1;
    }
    out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN'));
    return withCount ? out : out.map(({ count, ...rest }) => rest);
  }

  saveCat({ name, color, order, rename }, oldName) {
    const clean = String(name || '').trim().slice(0, 20);
    if (!clean) throw new HttpError(400, '请填写分类名称');
    const list = Array.isArray(this.data.cats) ? this.data.cats : (this.data.cats = []);
    const prev = String(oldName || '').trim();
    if (prev && prev !== clean) {
      const target = list.find((c) => String(c && c.name).trim() === clean);
      if (target) throw new HttpError(400, `分类已存在：${clean}`);
      for (const it of this.data.items.ruleset) {
        if (String(it.cat || '').trim() === prev) it.cat = clean;
      }
    }
    let entry = list.find((c) => String(c && c.name).trim() === (prev || clean));
    if (!entry) {
      entry = { name: clean, color: CAT_COLORS[list.length % CAT_COLORS.length], order: list.length };
      list.push(entry);
    } else if (entry.name !== clean) {
      entry.name = clean;
    }
    if (/^#[0-9a-f]{3,8}$/i.test(String(color || ''))) entry.color = color;
    if (Number.isFinite(order)) entry.order = order;
    // 把散落在规则集上的 cat 收进 cats，保证顺序稳定
    for (const c of this.listCats({ withCount: false })) {
      if (!list.some((x) => String(x && x.name).trim() === c.name)) list.push(c);
    }
    this.persist();
    return this.listCats().find((c) => c.name === clean);
  }

  removeCat(name, { moveTo } = {}) {
    const target = String(name || '').trim();
    if (!target) throw new HttpError(400, '缺少分类名称');
    const dest = String(moveTo || '未分类').trim() || '未分类';
    if (dest === target) throw new HttpError(400, '不能迁移到自身');
    if (target === '未分类') throw new HttpError(400, '默认分类不能删除');
    let moved = 0;
    for (const it of this.data.items.ruleset) {
      if (String(it.cat || '未分类').trim() === target) {
        it.cat = dest;
        moved += 1;
      }
    }
    if (Array.isArray(this.data.cats)) this.data.cats = this.data.cats.filter((c) => String(c && c.name).trim() !== target);
    this.persist();
    return { moved, moveTo: dest };
  }

  summarize(kind, item) {
    const copy = { ...item };
    if (kind !== 'ruleset') delete copy.content;
    else if (Array.isArray(copy.inline) && copy.inline.length > 6) {
      copy.inlineCount = copy.inline.length;
      copy.inline = copy.inline.slice(0, 6);
    }
    return copy;
  }

  get(kind, id) {
    assertKind(kind);
    const item = this.data.items[kind].find((x) => x.id === id);
    if (!item) throw new HttpError(404, `资源不存在：${kind}/${id}`);
    return item;
  }

  find(kind, id) {
    if (!id) return null;
    return this.data.items[kind].find((x) => x.id === id) || null;
  }

  save(kind, input, { create = true } = {}) {
    assertKind(kind);
    const body = input && typeof input === 'object' ? input : {};
    const list = this.data.items[kind];
    if (create && list.length >= MAX_ITEMS) throw new HttpError(400, `资源数量已达上限（${MAX_ITEMS}）`);
    const existing = body.id ? list.find((x) => x.id === body.id) : null;
    if (create && existing) throw new HttpError(400, `资源已存在：${kind}/${body.id}`);

    let id = String(body.id || '').trim();
    if (!id) id = slugify(body.name);
    if (!isValidId(id)) throw new HttpError(400, '资源 id 只能包含小写字母、数字与短横线（1-48）');
    if (create && list.some((x) => x.id === id)) throw new HttpError(400, `资源 id 已存在：${id}`);

    // PATCH 语义：更新时用现有条目做底，允许只传要改的字段
    const merged = existing ? { ...existing, ...body, id } : { ...body, id };
    if (existing && body.urls && existing.urls) merged.urls = { ...existing.urls, ...body.urls };

    const name = String(merged.name || '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, '请填写资源名称');

    const entry = kind === 'ruleset'
      ? this.normalizeRuleset({ ...merged, id, name })
      : kind === 'repo'
        ? this.normalizeRepo({ ...merged, id, name })
        : this.normalizeConfig(kind, { ...merged, id, name });

    if (existing) {
      entry.builtin = existing.builtin === true;
      Object.assign(existing, entry);
    } else {
      entry.builtin = body.builtin === true;
      list.push(entry);
    }
    this.persist();
    return findIn(list, id);
  }

  normalizeRuleset(body) {
    const group = String(body.group || '').trim().slice(0, 40);
    if (!group) throw new HttpError(400, '请填写规则指向的策略组');
    const behavior = BEHAVIORS.includes(body.behavior) ? body.behavior : 'classical';
    const urlsIn = body.urls && typeof body.urls === 'object' ? body.urls : {};
    const urls = {
      clash: cleanUrl(urlsIn.clash, 'Clash 规则集地址'),
      mihomo: cleanUrl(urlsIn.mihomo, 'mihomo 规则集地址'),
      singbox: cleanUrl(urlsIn.singbox, 'sing-box 规则集地址'),
    };
    if (!urls.clash && !urls.mihomo && !urls.singbox) {
      const inline = Array.isArray(body.inline) ? body.inline : [];
      if (!inline.length) throw new HttpError(400, '至少填写一个规则集地址，或写几条内联规则');
    }
    const inline = (Array.isArray(body.inline) ? body.inline : [])
      .map((rule) => String(rule).trim())
      .filter(Boolean)
      .slice(0, 500);
    inline.forEach((rule) => {
      if (rule.length > 300) throw new HttpError(400, '单条内联规则不能超过 300 字符');
    });
    const primaryUrl = urls.mihomo || urls.clash || urls.singbox || '';
    const format = body.format && ['mrs', 'srs', 'yaml', 'text', 'inline'].includes(body.format)
      ? body.format
      : (primaryUrl ? detectRulesetFormat(primaryUrl) : 'inline');
    const intervalHours = Math.min(720, Math.max(1, Number(body.intervalHours) || 24));
    return {
      id: body.id,
      name: body.name,
      group,
      behavior,
      cat: String(body.cat || '').trim().slice(0, 20),
      tags: (Array.isArray(body.tags) ? body.tags : [])
        .map((t) => String(t).trim().slice(0, 16))
        .filter(Boolean)
        .slice(0, 8),
      repo: String(body.repo || '自建').trim().slice(0, 40) || '自建',
      desc: String(body.desc || '').trim().slice(0, 300),
      urls,
      inline,
      format,
      autoUpdate: body.autoUpdate !== false && !!primaryUrl,
      updateMode: UPDATE_MODES.includes(body.updateMode) ? body.updateMode : 'replace',
      intervalHours,
      remoteHash: String(body.remoteHash || ''),
      remoteEtag: String(body.remoteEtag || ''),
      checkedAt: body.checkedAt || null,
      changedAt: body.changedAt || null,
      checkError: body.checkError || null,
      updatedAt: new Date().toISOString(),
    };
  }

  getSettings() {
    return { ...this.data.settings };
  }

  saveSettings(body = {}) {
    const cur = this.data.settings;
    this.data.settings = {
      autoUpdate: body.autoUpdate !== false,
      mode: ['item', 'global'].includes(body.mode) ? body.mode : cur.mode,
      scope: ['all', 'builtin', 'custom'].includes(body.scope) ? body.scope : cur.scope,
      defaultMode: UPDATE_MODES.includes(body.defaultMode) ? body.defaultMode : cur.defaultMode,
      intervalHours: Math.min(720, Math.max(1, Number(body.intervalHours) || cur.intervalHours)),
    };
    this.persist();
    this.log('lib', `规则集更新设置：${this.data.settings.mode === 'global' ? '统一更新' : '单项设置'}，范围 ${this.data.settings.scope}，默认 ${this.data.settings.defaultMode}/${this.data.settings.intervalHours}h`);
    return this.getSettings();
  }

  /** 单项实际生效的更新配置：统一模式下忽略单项，单项模式优先单项。 */
  effectiveUpdate(item) {
    const s = this.data.settings;
    if (!s.autoUpdate) return { autoUpdate: false, mode: s.defaultMode, intervalHours: s.intervalHours, source: 'off' };
    if (s.mode === 'global') {
      return { autoUpdate: true, mode: s.defaultMode, intervalHours: s.intervalHours, source: 'global' };
    }
    return {
      autoUpdate: item.autoUpdate !== false,
      mode: UPDATE_MODES.includes(item.updateMode) ? item.updateMode : 'check',
      intervalHours: Math.min(720, Math.max(1, Number(item.intervalHours) || 24)),
      source: 'item',
    };
  }

  /**
   * 检查一个网络规则集是否有更新。官方 mrs/srs 是编译产物，只能整文件替换；
   * 文本规则集同样按整体文件处理（追加会造成重复规则），这里只做变更检测。
   */
  async checkRuleset(id, { timeout = 10000 } = {}) {
    const item = this.get('ruleset', id);
    const url = item.urls.mihomo || item.urls.clash || item.urls.singbox;
    if (!url) throw new HttpError(400, '该规则集没有网络地址');
    const started = Date.now();
    let hash = '';
    let etag = '';
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'SubHub/1.0 (+https://github.com/subhub)',
          ...(item.remoteEtag ? { 'if-none-match': item.remoteEtag } : {}),
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 304) {
        item.checkedAt = new Date().toISOString();
        item.checkError = null;
        this.persist();
        return { ok: true, changed: false, notModified: true, ms: Date.now() - started };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) throw new Error('规则集超过 8MB，已跳过');
      hash = sha1(buf);
      etag = res.headers.get('etag') || '';
    } catch (e) {
      item.checkedAt = new Date().toISOString();
      item.checkError = String(e.message || e).slice(0, 200);
      this.persist();
      throw new HttpError(502, `规则集检查失败：${item.checkError}`);
    }
    const changed = !!item.remoteHash && item.remoteHash !== hash;
    item.remoteHash = hash;
    item.remoteEtag = etag;
    item.checkedAt = new Date().toISOString();
    item.checkError = null;
    if (changed) item.changedAt = item.checkedAt;
    this.persist();
    return { ok: true, changed, hash, etag, mode: item.updateMode, format: item.format, bytes: 0, ms: Date.now() - started };
  }

  async autoUpdateDue(limit = 10) {
    const now = Date.now();
    const s = this.data.settings;
    const due = this.data.items.ruleset.filter((it) => {
      const hasUrl = !!(it.urls.mihomo || it.urls.clash || it.urls.singbox);
      if (!hasUrl) return false;
      if (s.scope === 'builtin' && !it.builtin) return false;
      if (s.scope === 'custom' && it.builtin) return false;
      const eff = this.effectiveUpdate(it);
      if (!eff.autoUpdate) return false;
      const last = Date.parse(it.checkedAt || 0) || 0;
      return now - last >= eff.intervalHours * 3600 * 1000;
    }).slice(0, limit);
    const out = [];
    for (const it of due) {
      try {
        const r = await this.checkRuleset(it.id);
        out.push({ id: it.id, name: it.name, ...r });
        if (r.changed) this.log('lib', `规则集「${it.name}」检测到更新（${it.format}，${this.effectiveUpdate(it).mode === 'append' ? '增量' : this.effectiveUpdate(it).mode === 'check' ? '仅检查' : '整文件替换'}）`);
      } catch (e) {
        out.push({ id: it.id, name: it.name, ok: false, error: e.message });
      }
    }
    return out;
  }

  /** 来源仓库：仅元数据，用于给规则集标注出处、批量拼装规则集地址 */
  normalizeRepo(body) {
    const pickUrl = (value, field) => {
      const s = String(value || '').trim();
      if (!s) return '';
      if (s.length > 300) throw new HttpError(400, `${field} 太长了`);
      if (!/^https?:\/\//i.test(s)) throw new HttpError(400, `${field} 必须以 http:// 或 https:// 开头`);
      return s.replace(/\/+$/, '');
    };
    const home = String(body.home || '').trim().slice(0, 300);
    if (home && !/^https?:\/\//i.test(home)) throw new HttpError(400, '仓库主页必须以 http:// 或 https:// 开头');
    return {
      id: body.id,
      name: body.name,
      home,
      clash: pickUrl(body.clash, 'Clash 规则集前缀'),
      mihomo: pickUrl(body.mihomo, 'mihomo 规则集前缀'),
      singbox: pickUrl(body.singbox, 'sing-box 规则集前缀'),
      note: String(body.note || '').trim().slice(0, 160),
      updatedAt: new Date().toISOString(),
    };
  }

  normalizeConfig(kind, body) {
    const format = FORMATS.includes(body.format) ? body.format : 'any';
    const content = String(body.content || '');
    if (!content.trim()) throw new HttpError(400, '配置内容不能为空');
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) throw new HttpError(400, '配置内容超过 64KB');
    if (kind === 'dns' && format === 'singbox') {
      const parsed = parseJson(content, 'sing-box DNS 配置');
      if (!parsed.dns) throw new HttpError(400, 'sing-box DNS 配置必须是包含 dns 键的 JSON');
    }
    if (kind === 'base' && format === 'singbox') {
      parseJson(content, 'sing-box 基础配置');
    }
    if (kind === 'dns' && format === 'mihomo' && !/^\s*dns\s*:/m.test(content)) {
      throw new HttpError(400, 'mihomo DNS 配置需要以 dns: 开头');
    }
    return {
      id: body.id,
      name: body.name,
      format,
      desc: String(body.desc || '').trim().slice(0, 300),
      content,
      updatedAt: new Date().toISOString(),
    };
  }

  remove(kind, id) {
    assertKind(kind);
    const list = this.data.items[kind];
    const index = list.findIndex((x) => x.id === id);
    if (index < 0) throw new HttpError(404, `资源不存在：${kind}/${id}`);
    if (list[index].builtin) throw new HttpError(400, '内置资源不能删除，可以复制一份再改');
    list.splice(index, 1);
    this.persist();
  }

  /** 把前端的 {baseId,dnsId,rulesets} 解析成实际内容 */
  resolveSelection({ baseId, dnsId, rulesetIds }) {
    const pick = (kind, id) => {
      if (!id) return null;
      const item = this.get(kind, String(id));
      if (!item) throw new HttpError(400, `资源不存在：${kind}/${id}`);
      return item;
    };
    const base = pick('base', baseId);
    const dns = pick('dns', dnsId);
    const rulesets = (Array.isArray(rulesetIds) ? [...new Set(rulesetIds)] : [])
      .map((id) => pick('ruleset', id))
      .filter(Boolean);
    return { base, dns, rulesets };
  }
}

function findIn(list, id) {
  return list.find((x) => x.id === id) || null;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, `${label}不是合法 JSON`);
  }
}

module.exports = { LibraryStore, KINDS, isValidId, slugify };

