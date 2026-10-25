'use strict';

/**
 * SubHub Gateway
 * ─────────────────────────────────────────────────────────────
 * 一个链接同时服务 mihomo / sing-box / daed / Surge / Loon / Quantumult X …
 *  · /s/:token[/:target]  固定订阅（token 隐藏上游地址）
 *  · /c/:payload          临时链接（参数编码在 URL 中）
 *  · /tpl/:name.ini       模板托管（供 subconverter 拉取）
 *  · /api/*               管理接口 + 模板可视化模型
 *
 * 仅使用 Node 内置模块。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  HttpError, log: baseLog, send, json, readJson, clientIp, maskToken, sha1, safeEqual, fmtBytes,
} = require('./lib/util');
const { targetList, resolveTarget, detectTarget, countNodes } = require('./lib/targets');
const { assertSources, RateLimiter } = require('./lib/security');
const { TemplateStore } = require('./lib/templates');
const { ProfileStore, profileView, MAX_SOURCES } = require('./lib/profiles');
const { Engine } = require('./lib/engine');
const { SourceStore, prepareSources, normalizeSubscription } = require('./lib/sources');
const { TTLCache } = require('./lib/cache');
const { parseIni, buildIni, validateModel, starterTemplate } = require('./lib/ini');
const { LibraryStore } = require('./lib/library');
const { RuleCatalog, keyOf } = require('./lib/catalog');
const { normalizeNodes, nodesToYaml, parseProxyYaml } = require('./lib/nodes');
const { AuthStore, parseCookies, SESSION_TTL, ROLES, PERMISSIONS, ROLE_PERMS, effectivePerms, todayStr } = require('./lib/auth');
const { LogBuffer } = require('./lib/logs');
const { SettingsStore } = require('./lib/settings');
const { IconStore } = require('./lib/icons');
const {
  mergeYamlBase, mergeYamlDns, applyMihomoRulesets, applySingboxLayers, appendIniRulesets,
} = require('./lib/layers');

// ───────────────────────────── 配置 ─────────────────────────────
const PORT = Number(process.env.PORT || process.env.GATEWAY_PORT || 8080);
const VERSION = '1.0.0';

/** 归一化反代子路径：/subhub/ → /subhub，空或非法 → '' */
function normalizeBasePath(value) {
  let text = String(value || '').trim();
  if (!text || text === '/') return '';
  text = `/${text.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return /^\/[A-Za-z0-9._~\-/]+$/.test(text) ? text : '';
}

const PERMISSION_LABELS = {
  convert: '转换',
  subscribe: '订阅',
  'templates:write': '模板编辑',
  'library:write': '资源库编辑',
  'profiles:write': '订阅管理',
  'icons:write': '图标库',
  'catalog:refresh': '目录更新',
  'engine:write': '引擎设置',
  'logs:read': '日志',
  'logs:view': '查看全部日志',
  'users:manage': '账号管理',
};
const CONFIG_DIR = process.env.CONFIG_DIR || process.env.DATA_DIR || '/config';
const RULES_DIR = process.env.RULES_DIR || path.join(CONFIG_DIR, 'rules');
const ICONS_DIR = process.env.ICONS_DIR || path.join(CONFIG_DIR, 'icons');
const CACHE_DIR = process.env.CACHE_DIR || path.join(CONFIG_DIR, 'cache');
const TEMPLATES_DIR = process.env.TEMPLATES_DIR || path.join(CONFIG_DIR, 'templates');
const STATE_DIR = process.env.STATE_DIR || path.join(CONFIG_DIR, 'state');
for (const dir of [CONFIG_DIR, RULES_DIR, ICONS_DIR, CACHE_DIR, TEMPLATES_DIR, STATE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
const SEED_DIR = path.join(__dirname, 'seed');
const PUBLIC_DIR = path.join(__dirname, 'public');

const cfg = {
  port: PORT,
  subconverter: (process.env.SUBCONVERTER || 'http://127.0.0.1:25500').replace(/\/+$/, ''),
  selfUrl: (process.env.SELF_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, ''),
  publicBase: (process.env.PUBLIC_BASE || '').replace(/\/+$/, ''),
  basePath: normalizeBasePath(process.env.SUBHUB_BASE_PATH),
  adminKey: process.env.ADMIN_KEY || '',
  cacheTtl: Math.max(0, Number(process.env.CACHE_TTL || 300)),
  allowPrivateSources: /^(1|true|yes|on)$/i.test(process.env.ALLOW_PRIVATE_SOURCES || ''),
  trustProxy: /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || ''),
  convertLimit: Math.max(1, Number(process.env.RATE_CONVERT || 30)),
  subscribeLimit: Math.max(1, Number(process.env.RATE_SUBSCRIBE || 120)),
  maxSources: MAX_SOURCES,
  version: VERSION,
};

// ───────────────────────────── 日志 ─────────────────────────────
const logBuffer = new LogBuffer();

/** 旧日志 tag → 新分类；调用处可用 meta.cat 覆盖 */
const LOG_CAT_BY_TAG = {
  auth: 'auth',
  tpl: 'convert',
  conv: 'convert',
  sub: 'pull',
  src: 'network',
  lib: 'system',
  icons: 'system',
  catalog: 'system',
  cfg: 'system',
  engine: 'system',
  settings: 'system',
  boot: 'system',
  rate: 'system',
  test: 'system',
  warn: 'system',
  err: 'system',
};

/** 兼容旧调用：log(tag, msg) 照旧写 stdout，同时进环形缓冲。meta = {cat, level, user, ip} */
function log(tag, msg, meta = {}) {
  baseLog(tag, msg);
  logBuffer.push({
    cat: meta.cat || LOG_CAT_BY_TAG[tag] || 'system',
    level: meta.level || (tag === 'err' ? 'error' : (tag === 'warn' ? 'warn' : 'info')),
    msg,
    user: meta.user || null,
    ip: meta.ip || null,
  });
}

// ───────────────────────────── 状态 ─────────────────────────────
const templates = new TemplateStore({ dataDir: CONFIG_DIR, dir: TEMPLATES_DIR, seedDir: path.join(SEED_DIR, 'templates'), logger: log });
const profiles = new ProfileStore({ dataDir: STATE_DIR, seedDir: SEED_DIR, logger: log });
const library = new LibraryStore({ dataDir: RULES_DIR, seedDir: SEED_DIR, logger: log });
const catalog = new RuleCatalog({ dataDir: CACHE_DIR, seedDir: SEED_DIR, logger: log });
const settings = new SettingsStore({ dataDir: STATE_DIR, logger: log });
const icons = new IconStore({ dataDir: ICONS_DIR, seedDir: path.join(SEED_DIR, 'icons'), logger: log });
const engineSettings = settings.engine();
const internalEngineBase = (process.env.SUBCONVERTER || 'http://127.0.0.1:25500').replace(/\/+$/, '');
const engine = new Engine({
  base: engineSettings.mode === 'remote' ? engineSettings.base : internalEngineBase,
  token: engineSettings.mode === 'remote' ? engineSettings.token : '',
  selfUrl: cfg.selfUrl,
  timeout: Math.max(5000, Number(process.env.ENGINE_TIMEOUT || 120000)),
  logger: log,
});
settings.applyTo(engine, { internalBase: internalEngineBase });
const cache = new TTLCache({ maxEntries: 1200, maxBytes: 64 * 1024 * 1024 });

const limiters = {
  convert: new RateLimiter({ limit: cfg.convertLimit, windowMs: 60000, name: 'convert' }),
  subscribe: new RateLimiter({ limit: cfg.subscribeLimit, windowMs: 60000, name: 'subscribe' }),
  link: new RateLimiter({ limit: cfg.convertLimit * 2, windowMs: 60000, name: 'link' }),
};

const inlineTemplates = new Map(); // id -> { content, exp }
const inlineByHash = new Map(); // hash -> id
const INLINE_TTL = 10 * 60 * 1000;

const sourceStore = new SourceStore({ ttlMs: 10 * 60 * 1000, logger: log });

const bootAt = Date.now();
let lastEngineStatus = { ok: null, version: '', error: '尚未探测', at: null };

templates.init();
profiles.init();
library.init();

// ───────────────────────────── 鉴权 ─────────────────────────────
const auth = new AuthStore({ dataDir: STATE_DIR, logger: log });
auth.init();

const SESSION_COOKIE = 'subhub_session';

function sessionToken(req) {
  const header = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  const explicit = req.headers['x-auth-token'];
  if (explicit) return String(explicit);
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] || '';
}

function currentUser(req) {
  const found = auth.getSession(sessionToken(req));
  return found ? found.user : null;
}

function legacyAdmin(req, url) {
  if (!cfg.adminKey) return false;
  const provided = req.headers['x-admin-key'] || url.searchParams.get('key') || '';
  return safeEqual(provided, cfg.adminKey);
}

function isAdmin(req, url) {
  const user = currentUser(req);
  if (user && user.role === 'admin') return true;
  return legacyAdmin(req, url);
}

function permissionsOf(req, url) {
  if (legacyAdmin(req, url)) return PERMISSIONS.slice();
  const user = currentUser(req);
  return user ? effectivePerms(user) : [];
}

function can(req, url, perm) {
  if (perm === '*') return isAdmin(req, url);
  return permissionsOf(req, url).includes(perm);
}

function requirePerm(req, url, perm) {
  if (can(req, url, perm)) return;
  const user = currentUser(req);
  if (!user) throw new HttpError(401, '请先登录');
  const label = PERMISSION_LABELS[perm] || perm;
  throw new HttpError(403, `没有「${label}」权限`);
}

function requireAdmin(req, url) {
  if (!isAdmin(req, url)) {
    const user = currentUser(req);
    if (user) throw new HttpError(403, '需要管理员权限');
    throw new HttpError(401, '请先登录');
  }
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, '请先登录');
  return user;
}

/** 反代前缀：SUBHUB_BASE_PATH 优先，其次 X-Forwarded-Prefix */
function requestPrefix(req) {
  if (cfg.basePath) return cfg.basePath;
  return normalizeBasePath(String(req.headers['x-forwarded-prefix'] || '').split(',')[0]);
}

function cookiePath(req) {
  return requestPrefix(req) || '/';
}

function setSessionCookie(res, token, req) {
  const secure = /^https$/i.test((req.headers['x-forwarded-proto'] || '').split(',')[0]) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${cookiePath(req)}; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure}`);
}

function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=${cookiePath(req)}; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ───────────────────────────── 工具 ─────────────────────────────
function firstHeader(value) {
  return String(value || '').split(',')[0].trim().replace(/[^\w.\-:[\]]/g, '');
}

function externalBase(req) {
  if (cfg.publicBase) return cfg.publicBase;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = forwardedProto === 'https' ? 'https' : (forwardedProto === 'http' ? 'http' : (req.socket && req.socket.encrypted ? 'https' : 'http'));
  const host = firstHeader(req.headers['x-forwarded-host'])
    || firstHeader(req.headers.host)
    || `127.0.0.1:${cfg.port}`;
  const prefix = normalizeBasePath(String(req.headers['x-forwarded-prefix'] || '').split(',')[0]);
  let path = cfg.basePath;
  if (prefix) path = prefix + (prefix.endsWith(cfg.basePath) ? '' : cfg.basePath);
  return `${proto}://${host}${path}`.replace(/\/+$/, '');
}

// ───────────────────────────── 配额 ─────────────────────────────
/** 有效配额：匿名与 admin 不受限，返回 null */
function quotaFor(user) {
  if (!user || user.role === 'admin') return null;
  return auth.quotaOf(user.id);
}

/** 账号到期校验（到期日当天仍可用）；不通过抛 403 */
function assertQuotaActive(user) {
  const quota = quotaFor(user);
  if (!quota) return null;
  if (quota.expiresAt && quota.expiresAt < todayStr()) {
    throw new HttpError(403, `账号已于 ${quota.expiresAt} 到期，请联系管理员`);
  }
  return quota;
}

/** 转换类接口的每日次数 + 客户端白名单校验；不通过抛 429 / 403 */
function assertConvertQuota(user, quota, target) {
  if (!quota) return;
  const usage = auth.usageOf(user.id) || { convert: 0, pull: 0 };
  if (quota.dailyConvert > 0 && usage.convert >= quota.dailyConvert) {
    throw new HttpError(429, `今日转换次数已用完（配额 ${quota.dailyConvert} 次/天）`);
  }
  if (target && quota.clients.length && !quota.clients.includes(target.id)) {
    throw new HttpError(403, `当前账号未开通该客户端：${target.id}`);
  }
}

/** 成功后累加用量（admin 不计） */
function bumpQuota(user, field) {
  if (user && user.role !== 'admin') auth.bumpUsage(user.id, field);
}

/**
 * 校验前端提交的 quota：clients 必须是已知客户端 id，expiresAt 必须是 YYYY-MM-DD。
 * 数字字段的清洗留给 auth.normalizeQuota。
 */
function parseQuotaInput(input) {
  if (input === undefined || input === null) return input;
  if (typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'quota 必须是对象');
  if (input.clients !== undefined && input.clients !== null) {
    if (!Array.isArray(input.clients)) throw new HttpError(400, 'quota.clients 必须是数组');
    const known = targetList().map((t) => t.id);
    const bad = [];
    for (const raw of input.clients) {
      const id = String(raw == null ? '' : raw).trim();
      if (id && !known.includes(id) && !bad.includes(id)) bad.push(id);
    }
    if (bad.length) throw new HttpError(400, `未知客户端：${bad.join('、')}`);
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.expiresAt).trim())) {
      throw new HttpError(400, 'quota.expiresAt 需为 YYYY-MM-DD 或 null');
    }
  }
  return input;
}

/** 订阅归属账号：profile.ownerId / profile.owner 反查，取不到返回 null（不报错） */
function profileOwner(profile) {
  if (!profile) return null;
  const raw = profile.ownerId || profile.owner || '';
  if (!raw) return null;
  const key = String(raw);
  return auth.getById(key) || auth.findByUsername(key);
}

// ───────────────────────────── 事件日志 ─────────────────────────────
function eventLog(req, tag, message, meta = {}) {
  log(tag, message, {
    ...meta,
    ip: meta.ip === undefined ? clientIp(req, cfg.trustProxy) : meta.ip,
  });
}

function logConvert(req, target, message, level = 'info', user = null) {
  eventLog(req, level === 'error' ? 'err' : 'conv', `转换 ${target.id} ${message}`, {
    cat: 'convert', level, user,
  });
}

function logPull(req, token, message, level = 'info', user = null) {
  eventLog(req, level === 'error' ? 'err' : (level === 'warn' ? 'warn' : 'sub'), `拉取 ${String(token).slice(0, 6)} ${message}`, {
    cat: 'pull', level, user,
  });
}

function logNetwork(req, message, user = null) {
  eventLog(req, 'src', `上游订阅抓取失败：${message}`, { cat: 'network', level: 'warn', user });
}

function hitLimiter(limiter, req) {
  const result = limiter.hit(clientIp(req, cfg.trustProxy));
  if (result.ok) return null;
  log('rate', `限流触发：${clientIp(req, cfg.trustProxy)}`);
  throw new HttpError(429, `请求过于频繁，请 ${result.retryAfter} 秒后再试`, {
    headers: { 'Retry-After': String(result.retryAfter) },
  });
}

function registerInlineTemplate(content) {
  const hash = sha1(content);
  const existing = inlineByHash.get(hash);
  if (existing && inlineTemplates.has(existing)) {
    const entry = inlineTemplates.get(existing);
    entry.exp = Date.now() + INLINE_TTL;
    return existing;
  }
  const id = hash;
  inlineTemplates.set(id, { content, exp: Date.now() + INLINE_TTL });
  inlineByHash.set(hash, id);
  return id;
}

function normSources(input) {
  const list = Array.isArray(input)
    ? input.map((s) => String(s == null ? '' : s).trim()).filter(Boolean)
    : [];
  if (list.length > cfg.maxSources) throw new HttpError(400, `订阅源最多 ${cfg.maxSources} 个`);
  return list;
}

function normOpts(input) {
  const o = input && typeof input === 'object' ? input : {};
  return {
    emoji: o.emoji !== false,
    udp: o.udp !== false,
    tfo: !!o.tfo,
    scv: o.scv !== false,
    sort: !!o.sort,
  };
}

function resolveTargetOrThrow(value, fallback) {
  if (value) {
    const target = resolveTarget(value);
    if (!target) throw new HttpError(400, `不支持的客户端类型：${value}`);
    return target;
  }
  if (fallback) return fallback;
  throw new HttpError(400, '缺少 target 参数');
}

function engineStatusCached() {
  const e = settings.engine();
  return { ...lastEngineStatus, mode: e.mode, base: e.base || engine.base };
}

async function refreshEngineStatus() {
  const result = await engine.version();
  lastEngineStatus = { ...result, at: new Date().toISOString() };
  return lastEngineStatus;
}

// ───────────────────────────── 转换核心 ─────────────────────────────
/** 解析规则集引用：支持内置目录 id（gs:/gi:）、资源库 id，以及 {id, group, noResolve} 覆盖 */
function resolveRuleRefs(refs) {
  const list = Array.isArray(refs) ? refs : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const ref = typeof raw === 'string' ? { id: raw } : (raw && typeof raw === 'object' ? raw : null);
    const id = String((ref && ref.id) || '').trim();
    if (!ref || !id || seen.has(id)) continue;
    seen.add(id);

    let entry;
    if (Array.isArray(ref.inline) && ref.inline.length) {
      // 转换页手动添加的规则：{id, group, noResolve, inline:['DOMAIN-SUFFIX,ads.example.com']}
      const inline = ref.inline
        .map((r) => String(r).trim())
        .filter(Boolean)
        .slice(0, 80);
      inline.forEach((rule) => {
        if (rule.length > 300) throw new HttpError(400, '单条自定义规则不能超过 300 字符');
      });
      if (!inline.length) continue;
      entry = {
        id,
        key: keyOf(id || `inline-${out.length}`),
        name: String(ref.name || inline[0]).slice(0, 60),
        kind: 'inline',
        group: String(ref.group || '🚀 节点选择').slice(0, 40),
        behavior: 'classical',
        noResolve: !!ref.noResolve,
        urls: {},
        inline,
        source: 'inline',
      };
      out.push(entry);
      continue;
    }
    if (id.startsWith('gs:') || id.startsWith('gi:')) {
      const found = catalog.get(id);
      if (!found) throw new HttpError(400, `规则集不存在：${id}`);
      entry = { ...found, urls: { ...found.urls }, inline: [] };
    } else {
      const item = library.find('ruleset', id);
      if (!item) throw new HttpError(400, `规则集不存在：${id}`);
      entry = {
        id: item.id,
        key: keyOf(item.id),
        name: item.name,
        kind: 'custom',
        group: item.group,
        behavior: item.behavior || 'classical',
        noResolve: !!item.noResolve,
        urls: item.urls || {},
        inline: Array.isArray(item.inline) ? item.inline.slice() : [],
        builtin: !!item.builtin,
        source: 'library',
      };
    }
    if (ref.group) entry.group = String(ref.group).slice(0, 40);
    if (ref.noResolve !== undefined) entry.noResolve = !!ref.noResolve;
    out.push(entry);
  }
  return out;
}

/**
 * @returns {Promise<{body:string, nodes:number, bytes:number, ms:number, target:object, template:string, userinfo?:string, warnings:string[]}>}
 */
async function runConversion({
  sources, nodes, target, templateName, templateContent, include, exclude, opts,
  baseId, dnsId, rulesetIds, publicBase,
}) {
  const warnings = [];
  const sourceList = Array.isArray(sources) ? sources.filter(Boolean) : [];
  const checkedSources = sourceList.length
    ? await assertSources(sourceList, { allowPrivate: cfg.allowPrivateSources })
    : [];

  let prepared = { urls: [], userinfo: '', formats: [] };
  if (checkedSources.length) {
    prepared = await prepareSources(sourceStore, checkedSources, {
      selfUrl: cfg.selfUrl,
      timeout: 15000,
      allowPrivate: cfg.allowPrivateSources,
      logger: log,
    });
  }

  const urls = prepared.urls.slice();
  if (Array.isArray(nodes) && nodes.length) {
    const cleaned = normalizeNodes(nodes);
    if (cleaned.errors.length) throw new HttpError(400, cleaned.errors[0]);
    if (!cleaned.nodes.length) throw new HttpError(400, '自定义节点列表为空');
    warnings.push(...cleaned.warnings);
    const yaml = nodesToYaml(cleaned.nodes);
    const id = sourceStore.register(yaml, 'application/yaml');
    urls.push(`${cfg.selfUrl}/src/${id}`);
  }
  if (!urls.length) throw new HttpError(400, '请至少提供一个订阅源或节点');

  // 资源库：基础配置 / DNS / 规则集（内置目录 + 自建）
  let selection = { base: null, dns: null, rulesets: [] };
  try {
    selection = library.resolveSelection({ baseId, dnsId, rulesetIds: [] });
  } catch (e) {
    throw new HttpError(e.status || 400, e.message);
  }
  const { base, dns } = selection;
  const rulesets = resolveRuleRefs(rulesetIds);

  const nativeOk = (target.engine === 'clash' && target.id === 'mihomo') || target.engine === 'singbox';

  let templateUrl;
  let templateLabel;
  let templateIni;
  if (templateContent) {
    templateIni = String(templateContent);
    if (Buffer.byteLength(templateIni, 'utf8') > 256 * 1024) throw new HttpError(400, '模板内容超过 256KB');
    const parsed = parseIni(templateIni);
    if (!parsed.groups.length && !parsed.rules.length) {
      throw new HttpError(400, '模板中没有解析到策略组或规则，请检查 [custom] 段');
    }
    templateLabel = 'inline';
  } else {
    const name = String(templateName || 'full');
    if (!TemplateStore.isValidName(name)) throw new HttpError(400, '模板名称不合法');
    const info = templates.get(name);
    if (!info) throw new HttpError(400, `模板不存在：${name}`);
    templateIni = info.content;
    templateLabel = name;
  }

  // 规则集的目标组必须存在于模板，否则改投第一个可用组（避免生成非法配置）
  const templateGroups = parseIni(templateIni).groups.map((g) => g.name);
  const groupSet = new Set(templateGroups);
  const fallbackGroup = groupSet.has('🚀 节点选择')
    ? '🚀 节点选择'
    : (templateGroups[0] || '');
  for (const ruleset of rulesets) {
    if (!groupSet.has(ruleset.group)) {
      if (!fallbackGroup) {
        ruleset.skip = true;
        warnings.push(`模板里没有任何策略组，规则集「${ruleset.name}」已跳过`);
      } else {
        warnings.push(`模板里没有分组「${ruleset.group}」，规则集「${ruleset.name}」改投「${fallbackGroup}」`);
        ruleset.group = fallbackGroup;
      }
    }
  }

  const nativeRulesets = nativeOk
    ? rulesets.filter((r) => !r.skip && (target.engine === 'singbox'
      ? (r.urls && r.urls.singbox)
      : (r.urls && (r.urls.mihomo || r.urls.clash))))
    : [];
  const iniRulesets = rulesets.filter((r) => !r.skip && !nativeRulesets.includes(r));

  // 非原生目标：把目录里的 .yaml 展开成 Clash 规则，托管成临时规则集再交给引擎
  let inlineBudget = 24000;
  for (const ruleset of iniRulesets) {
    if (ruleset.urls && ruleset.urls.clash) continue;
    if (!ruleset.urls || !ruleset.urls.raw) continue;
    try {
      const expanded = await catalog.expand(ruleset);
      if (!expanded.length) {
        warnings.push(`规则集「${ruleset.name}」没有可用规则，已跳过`);
        continue;
      }
      if (expanded.length > inlineBudget) {
        warnings.push(`「${target.label}」规则条数过多，规则集「${ruleset.name}」只取前 ${inlineBudget} 条`);
      }
      const take = expanded.slice(0, Math.max(0, inlineBudget));
      inlineBudget -= take.length;
      const origin = String(publicBase || cfg.publicBase || cfg.selfUrl).replace(/\/+$/, '');
      const id = sourceStore.register(take.join('\n'), 'text/plain');
      ruleset.urls = { ...ruleset.urls, clash: `${origin}/src/${id}` };
    } catch (e) {
      warnings.push(`规则集「${ruleset.name}」展开失败（${e.message}），已跳过`);
    }
  }
  const effectiveIni = iniRulesets.filter(
    (r) => (r.urls && r.urls.clash) || (Array.isArray(r.inline) && r.inline.length),
  );

  if (effectiveIni.length) {
    const merged = appendIniRulesets(templateIni, effectiveIni);
    templateUrl = engine.inlineTemplateUrl(registerInlineTemplate(merged));
  } else if (templateContent) {
    templateUrl = engine.inlineTemplateUrl(registerInlineTemplate(templateIni));
  } else {
    templateUrl = engine.templateUrl(templateLabel);
  }

  const result = await engine.convert({
    sources: urls,
    target,
    templateUrl,
    include: String(include || '').trim(),
    exclude: String(exclude || '').trim(),
    opts: normOpts(opts),
  });

  let body = result.body;
  const hasLayers = !!(base || dns || nativeRulesets.length);
  if (hasLayers) {
    if (target.engine === 'clash' && target.id === 'mihomo') {
      if (base && (base.format === 'mihomo' || base.format === 'any')) body = mergeYamlBase(body, base.content);
      if (dns && (dns.format === 'mihomo' || dns.format === 'any')) body = mergeYamlDns(body, dns.content);
      body = applyMihomoRulesets(body, nativeRulesets).body;
    } else if (target.engine === 'singbox') {
      const layered = applySingboxLayers(body, {
        base: base && (base.format === 'singbox' || base.format === 'any') ? base : null,
        dns: dns && (dns.format === 'singbox' || dns.format === 'any') ? dns : null,
        rulesets: nativeRulesets,
      });
      body = layered.body;
      warnings.push(...(layered.warnings || []));
    } else {
      if (base) warnings.push(`「${target.label}」不支持合并基础配置，已忽略`);
      if (dns) warnings.push(`「${target.label}」不支持合并 DNS 配置，已忽略`);
    }
  }
  const targetFormat = target.id === 'mihomo' ? 'mihomo' : (target.engine === 'singbox' ? 'singbox' : null);
  if (base && targetFormat && !(base.format === targetFormat || base.format === 'any')) {
    warnings.push(`基础配置「${base.name}」是 ${base.format} 格式，与 ${target.label} 不匹配，已忽略`);
  }

  const bytes = Buffer.byteLength(body, 'utf8');
  return {
    ...result,
    body,
    bytes,
    userinfo: prepared.userinfo || result.userinfo || '',
    nodes: countNodes(target, body),
    target,
    template: templateLabel,
    warnings,
  };
}

/**
 * 为「一次性转换」生成可回源的临时订阅地址，用于改写 Surge 首行 MANAGED-CONFIG。
 * 返回 null 表示参数太长，调用方应直接删掉该行以免客户端去连内网引擎。
 */
/** 规则集引用可写成字符串 id 或 {id,group,noResolve}；临时链接里统一成紧凑对象 */
function encodeRuleRefs(rulesetIds) {
  if (!Array.isArray(rulesetIds) || !rulesetIds.length) return null;
  const out = rulesetIds.slice(0, 60).map((x) => {
    if (x && typeof x === 'object') {
      const id = String(x.id || '').slice(0, 48);
      if (!id) return null;
      const item = { id };
      if (x.group) item.group = String(x.group).slice(0, 48);
      if (x.noResolve) item.noResolve = true;
      if (Array.isArray(x.inline) && x.inline.length) {
        item.inline = x.inline.map((r) => String(r).slice(0, 300)).slice(0, 20);
      }
      return item;
    }
    const id = String(x).slice(0, 48);
    return id || null;
  }).filter(Boolean);
  return out.length ? out : null;
}

function ephemeralUrlFor(req, { sources, target, template, include, exclude, opts, baseId, dnsId, rulesetIds }) {
  const payload = { s: sources, t: target.id, p: template };
  if (include) payload.i = String(include).slice(0, 300);
  if (exclude) payload.e = String(exclude).slice(0, 300);
  if (baseId) payload.b = String(baseId).slice(0, 48);
  if (dnsId) payload.d = String(dnsId).slice(0, 48);
  const refs = encodeRuleRefs(rulesetIds);
  if (refs) payload.r = refs;
  payload.o = normOpts(opts);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (encoded.length > 7000) return null;
  return `${externalBase(req)}/c/${encoded}`;
}

/** Surge 等格式的首行 #!MANAGED-CONFIG 指向引擎内网地址，必须改写或删除 */
function sanitizeManagedConfig(body, publicUrl) {
  if (!String(body).startsWith('#!MANAGED-CONFIG')) return body;
  if (publicUrl) return engine.rewriteManaged(body, publicUrl);
  return String(body).split('\n').slice(1).join('\n');
}

function subscriptionHeaders({ target, ttl, nodes, cacheState, userinfo, updateInterval = 6 }) {  const headers = {
    'Content-Type': target.contentType,
    'Profile-Update-Interval': String(updateInterval),
    'Cache-Control': ttl > 0 ? `private, max-age=${Math.max(30, Math.floor(ttl / 2))}` : 'no-store',
    'X-SubHub-Target': target.id,
    'X-SubHub-Nodes': String(nodes || 0),
    'X-Cache': cacheState,
    'Access-Control-Allow-Origin': '*',
  };
  if (userinfo) headers['Subscription-Userinfo'] = userinfo;
  return headers;
}

// ───────────────────────────── 订阅路由 ─────────────────────────────
const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8' };

async function handleSubscription(req, res, url, token, explicitTarget) {
  hitLimiter(limiters.subscribe, req);
  const profile = profiles.get(token);
  if (!profile) {
    logPull(req, token, '失败：订阅不存在或已被删除', 'warn');
    return send(res, 404, '# 订阅不存在或已被删除\n', TEXT_HEADERS);
  }
  if (profile.enabled === false) {
    logPull(req, token, '失败：该订阅已被停用', 'warn');
    return send(res, 403, '# 该订阅已被停用\n', TEXT_HEADERS);
  }

  let target;
  if (explicitTarget && explicitTarget !== 'auto') {
    target = resolveTarget(explicitTarget);
    if (!target) {
      logPull(req, token, `失败：不支持的客户端 ${explicitTarget}`, 'warn');
      return send(res, 404, `# 不支持的客户端：${explicitTarget}\n`);
    }
  } else {
    const qTarget = url.searchParams.get('target');
    if (qTarget && profile.allowTargetOverride) target = resolveTarget(qTarget) || null;
    target = target || detectTarget(req.headers['user-agent'] || '');
  }

  const allowed = Array.isArray(profile.allowedTargets) && profile.allowedTargets.length
    ? profile.allowedTargets
    : null;
  if (allowed && !allowed.includes(target.id)) {
    logPull(req, token, `失败：未开放 ${target.label} 格式`, 'warn');
    return send(res, 403, `# 该订阅未开放 ${target.label} 格式\n`, TEXT_HEADERS);
  }

  // 订阅有归属账号时按账号配额限流；反查不到 owner 则跳过（不因此报错）
  const owner = profileOwner(profile);
  const quota = owner && owner.role !== 'admin' ? auth.quotaOf(owner.id) : null;
  const usage = quota ? (auth.usageOf(owner.id) || { convert: 0, pull: 0 }) : null;
  if (quota) {
    if (quota.expiresAt && quota.expiresAt < todayStr()) {
      logPull(req, token, `失败：账号已于 ${quota.expiresAt} 到期`, 'warn', owner.username);
      return send(res, 403, `# 账号已于 ${quota.expiresAt} 到期，请联系管理员\n`, TEXT_HEADERS);
    }
    if (quota.clients.length && !quota.clients.includes(target.id)) {
      logPull(req, token, `失败：未开通客户端 ${target.id}`, 'warn', owner.username);
      return send(res, 403, `# 当前账号未开通该客户端：${target.id}\n`, TEXT_HEADERS);
    }
    if (quota.dailyPull > 0 && usage.pull >= quota.dailyPull) {
      logPull(req, token, `失败：今日拉取次数已用完（${quota.dailyPull} 次/天）`, 'warn', owner.username);
      return send(res, 429, `# 今日拉取次数已用完（配额 ${quota.dailyPull} 次/天）\n`, TEXT_HEADERS);
    }
  }

  const ttl = profile.cacheTtl === null || profile.cacheTtl === undefined ? cfg.cacheTtl : Number(profile.cacheTtl);
  const base = externalBase(req);
  const publicUrl = `${base}/s/${token}/${target.id}`;
  const cacheKey = `s|${token}|${profile.revision || 1}|${templates.revision()}|${library.revision()}|${target.id}`;

  const cached = ttl > 0 ? cache.get(cacheKey) : null;
  if (cached) {
    const body = engine.rewriteManaged(cached.body, publicUrl);
    bumpQuota(owner, 'pull');
    logPull(req, token, `→ ${target.id} · ${cached.nodes} 节点 · HIT`, 'info', owner && owner.username);
    return send(res, 200, body, subscriptionHeaders({
      target,
      ttl,
      nodes: cached.nodes,
      cacheState: 'HIT',
      userinfo: cached.userinfo,
      updateInterval: profile.updateInterval,
    }));
  }

  const started = Date.now();
  try {
    const result = await runConversion({
      sources: profile.sources,
      nodes: profile.nodes,
      target,
      templateName: profile.template,
      include: profile.include,
      exclude: profile.exclude,
      opts: profile.opts,
      baseId: profile.baseId,
      dnsId: profile.dnsId,
      rulesetIds: profile.rulesets,
      publicBase: externalBase(req),
    });
    if (ttl > 0) {
      cache.set(cacheKey, { body: result.body, nodes: result.nodes, userinfo: result.userinfo || '' }, ttl * 1000);
    }
    const body = engine.rewriteManaged(result.body, publicUrl);
    bumpQuota(owner, 'pull');
    logPull(req, token, `→ ${target.id} · ${result.nodes} 节点 · ${fmtBytes(result.bytes)} · ${Date.now() - started}ms`, 'info', owner && owner.username);
    return send(res, 200, body, subscriptionHeaders({
      target,
      ttl,
      nodes: result.nodes,
      cacheState: 'MISS',
      userinfo: result.userinfo,
      updateInterval: profile.updateInterval,
    }));
  } catch (e) {
    logPull(req, token, `失败：${e.message}`, 'error', owner && owner.username);
    if (e.network) logNetwork(req, e.message, owner && owner.username);
    const status = e.status || 502;
    return send(res, status, `# 转换失败：${e.message}\n`, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-SubHub-Error': encodeURIComponent(e.message).slice(0, 200),
    });
  }
}

async function handleEphemeral(req, res, url, payload) {
  hitLimiter(limiters.subscribe, req);
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return send(res, 400, '# 临时链接无效或已损坏\n', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const target = resolveTarget(data.t);
  if (!target) return send(res, 400, '# 临时链接中的客户端类型无效\n', { 'Content-Type': 'text/plain; charset=utf-8' });
  let sources;
  try {
    sources = normSources(data.s);
  } catch (e) {
    return send(res, 400, `# ${e.message}\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const ttl = cfg.cacheTtl;
  const base = externalBase(req);
  const publicUrl = `${base}/c/${payload}`;
  const cacheKey = `c|${sha1(payload)}`;
  const cached = ttl > 0 ? cache.get(cacheKey) : null;
  if (cached) {
    return send(res, 200, engine.rewriteManaged(cached.body, publicUrl), subscriptionHeaders({
      target, ttl, nodes: cached.nodes, cacheState: 'HIT', userinfo: cached.userinfo,
    }));
  }

  try {
    const result = await runConversion({
      sources,
      target,
      templateName: data.p || 'full',
      include: data.i || '',
      exclude: data.e || '',
      opts: data.o || {},
      baseId: data.b || '',
      dnsId: data.d || '',
      rulesetIds: Array.isArray(data.r) ? data.r : [],
      publicBase: externalBase(req),
    });
    if (ttl > 0) cache.set(cacheKey, { body: result.body, nodes: result.nodes, userinfo: result.userinfo || '' }, ttl * 1000);
    return send(res, 200, engine.rewriteManaged(result.body, publicUrl), subscriptionHeaders({
      target, ttl, nodes: result.nodes, cacheState: 'MISS', userinfo: result.userinfo,
    }));
  } catch (e) {
    return send(res, e.status || 502, `# 转换失败：${e.message}\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

// ───────────────────────────── API ─────────────────────────────
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // —— 公共状态 ——
  if (method === 'GET' && parts[1] === 'state') {
    const base = externalBase(req);
    const user = currentUser(req);
    return json(res, 200, {
      version: VERSION,
      publicBase: base,
      basePath: cfg.basePath,
      adminEnabled: true,
      authenticated: isAdmin(req, url),
      user: auth.publicUser(user),
      auth: {
        enabled: true,
        defaultPassword: isAdmin(req, url) ? auth.isDefaultPassword(user) : undefined,
        roles: ROLES,
        permissions: user ? effectivePerms(user) : [],
        permissionCatalog: PERMISSIONS,
        permissionLabels: PERMISSION_LABELS,
        roleDefaults: ROLE_PERMS,
        users: auth.countUsers(),
      },
      settings: settings.publicView(),
      icons: icons.list(),
      iconsSummary: icons.summary(),
      targets: targetList(),
      templates: templates.list(),
      library: {
        rulesets: library.list('ruleset', { withContent: false }),
        bases: library.list('base', { withContent: false }),
        dns: library.list('dns', { withContent: false }),
        repos: library.list('repo'),
        categories: library.listCats(),
        formats: ['mihomo', 'singbox', 'any'],
        behaviors: ['domain', 'ipcidr', 'classical'],
      },
      catalog: catalog.summary(),
      defaults: { template: templates.list()[0] ? templates.list()[0].name : 'full', cacheTtl: cfg.cacheTtl },
      engine: engineStatusCached(),
      stats: {
        profiles: profiles.all().length,
        templates: templates.list().length,
        cache: cache.stats(),
        uptime: Math.floor((Date.now() - bootAt) / 1000),
      },
      limits: {
        sources: cfg.maxSources,
        convertPerMinute: cfg.convertLimit,
        subscribePerMinute: cfg.subscribeLimit,
        allowPrivateSources: cfg.allowPrivateSources,
      },
    });
  }

  if (method === 'GET' && parts[1] === 'health') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      uptime: Math.floor((Date.now() - bootAt) / 1000),
      profiles: profiles.all().length,
      templates: templates.list().length,
      engine: engineStatusCached(),
      cache: cache.stats(),
    });
  }

  // —— 账号体系 ——
  if (parts[1] === 'auth') {
    if (method === 'GET' && parts[2] === 'me') {
      const user = currentUser(req);
      return json(res, 200, {
        ok: true,
        user: auth.publicUser(user),
        authenticated: !!user,
        admin: !!(user && user.role === 'admin'),
        defaultPassword: user ? auth.isDefaultPassword(user) : false,
        permissions: user ? effectivePerms(user) : [],
      });
    }
    if (method === 'POST' && parts[2] === 'login') {
      const body = await readJson(req, 8 * 1024);
      const user = auth.verify(body.username, body.password);
      if (!user) return json(res, 401, { error: '用户名或密码不正确' });
      const token = auth.createSession(user.id);
      setSessionCookie(res, token, req);
      log('auth', `${user.username} 登录成功`, { user: user.username, ip: clientIp(req, cfg.trustProxy) });
      return json(res, 200, { ok: true, user: auth.publicUser(user), token });
    }
    if (method === 'POST' && parts[2] === 'logout') {
      const logoutUser = currentUser(req);
      auth.destroySession(sessionToken(req));
      clearSessionCookie(res, req);
      if (logoutUser) log('auth', `${logoutUser.username} 退出登录`, { user: logoutUser.username });
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && parts[2] === 'register') {
      const body = await readJson(req, 8 * 1024);
      const user = auth.registerWithInvite(body.code, body.username, body.password);
      const token = auth.createSession(user.id);
      setSessionCookie(res, token, req);
      return json(res, 201, { ok: true, user, token });
    }
    if (method === 'POST' && parts[2] === 'password') {
      const user = requireUser(req);
      const body = await readJson(req, 8 * 1024);
      const updated = auth.changePassword(user.id, body.current, body.next);
      auth.destroySession(sessionToken(req));
      clearSessionCookie(res, req);
      return json(res, 200, { ok: true, user: updated });
    }
    return json(res, 404, { error: '接口不存在' });
  }

  // —— 用户管理 ——
  if (parts[1] === 'users') {
    requirePerm(req, url, 'users:manage');
    const me = currentUser(req);
    if (method === 'GET' && !parts[2]) {
      return json(res, 200, {
        users: auth.listUsers(),
        roles: ROLES,
        permissionCatalog: PERMISSIONS,
        permissionLabels: PERMISSION_LABELS,
        roleDefaults: ROLE_PERMS,
      });
    }
    if (method === 'POST' && !parts[2]) {
      const body = await readJson(req, 16 * 1024);
      const user = auth.createUser({
        username: body.username,
        password: body.password,
        role: body.role,
        permissions: body.permissions,
        quota: parseQuotaInput(body.quota),
      });
      return json(res, 201, { ok: true, user });
    }
    if (method === 'PUT' && parts[2]) {
      const body = await readJson(req, 16 * 1024);
      if (body.quota !== undefined) parseQuotaInput(body.quota);
      const user = auth.updateUser(decodeURIComponent(parts[2]), body);
      return json(res, 200, { ok: true, user });
    }
    if (method === 'DELETE' && parts[2]) {
      const out = auth.removeUser(decodeURIComponent(parts[2]), me ? me.id : '');
      return json(res, 200, out);
    }
    return json(res, 404, { error: '接口不存在' });
  }

  // —— 注册码 / 兑换码 ——
  if (parts[1] === 'invites') {
    // 兑换：登录用户即可，不需要 users:manage
    if (method === 'POST' && parts[2] === 'redeem') {
      const user = requireUser(req);
      const body = await readJson(req, 8 * 1024);
      const out = auth.redeemCode(user, body.code);
      return json(res, 200, { ok: true, user: out.user, granted: out.granted });
    }
    requirePerm(req, url, 'users:manage');
    if (method === 'GET' && !parts[2]) {
      return json(res, 200, { invites: auth.listInvites() });
    }
    if (method === 'POST' && !parts[2]) {
      const body = await readJson(req, 16 * 1024);
      if (body.quota !== undefined && body.quota !== null) parseQuotaInput(body.quota);
      const invites = auth.createInvites(body, body.count);
      // invite 字段兼容旧前端/旧测试（单条）
      return json(res, 201, { ok: true, invites, invite: invites[0] });
    }
    if (method === 'DELETE' && parts[2]) {
      return json(res, 200, auth.removeInvite(decodeURIComponent(parts[2])));
    }
    return json(res, 404, { error: '接口不存在' });
  }

  // —— 运行设置 / 引擎切换 ——
  if (parts[1] === 'settings') {
    if (method === 'GET' && !parts[2]) {
      return json(res, 200, {
        settings: settings.publicView(),
        engine: engineStatusCached(),
        internalBase: internalEngineBase,
        permissions: permissionsOf(req, url),
      });
    }
    if (method === 'PUT' && parts[2] === 'engine') {
      requirePerm(req, url, 'engine:write');
      const body = await readJson(req, 16 * 1024);
      const view = settings.updateEngine(
        { mode: body.mode, base: body.base, token: body.token, clearToken: body.clearToken },
        { internalBase: internalEngineBase },
      );
      settings.applyTo(engine, { internalBase: internalEngineBase });
      let probe = null;
      if (body.test !== false) {
        try {
          const info = await refreshEngineStatus();
          probe = { ok: true, version: info.version || '' };
        } catch (err) {
          probe = { ok: false, error: err.message || String(err) };
        }
      }
      log('engine', `引擎切换为 ${view.engine.mode}${view.engine.mode === 'remote' ? `（${view.engine.base}）` : ''}`);
      return json(res, 200, { ok: true, settings: view, engine: engineStatusCached(), probe });
    }
    return json(res, 404, { error: '接口不存在' });
  }

  // —— 图标库 ——
  if (parts[1] === 'icons') {
    if (method === 'GET' && !parts[2]) {
      const q = url.searchParams.get('q') || '';
      const limit = Number(url.searchParams.get('limit') || 0);
      return json(res, 200, {
        icons: icons.list({ q, limit: Number.isFinite(limit) ? limit : 0 }),
        summary: icons.summary(),
      });
    }
    if (method === 'POST' && !parts[2]) {
      requirePerm(req, url, 'icons:write');
      const body = await readJson(req, 160 * 1024);
      return json(res, 201, { ok: true, icon: icons.create(body) });
    }
    if (method === 'PUT' && parts[2]) {
      requirePerm(req, url, 'icons:write');
      const body = await readJson(req, 8 * 1024);
      return json(res, 200, { ok: true, icon: icons.update(decodeURIComponent(parts[2]), body) });
    }
    if (method === 'DELETE' && parts[2]) {
      requirePerm(req, url, 'icons:write');
      return json(res, 200, icons.remove(decodeURIComponent(parts[2])));
    }
    return json(res, 404, { error: '接口不存在' });
  }

  // —— 模板只读 ——
  if (method === 'GET' && parts[1] === 'templates' && !parts[2]) {
    return json(res, 200, { templates: templates.list() });
  }
  if (method === 'GET' && parts[1] === 'templates' && parts[2]) {
    const info = templates.get(decodeURIComponent(parts[2]));
    if (!info) return json(res, 404, { error: '模板不存在' });
    return json(res, 200, info);
  }

  // —— 模板写入（需管理口令）——
  if (method === 'POST' && parts[1] === 'templates' && !parts[2]) {
    requirePerm(req, url, 'templates:write');
    const body = await readJson(req, 512 * 1024);
    const name = String(body.name || '').trim();
    if (!TemplateStore.isValidName(name)) return json(res, 400, { error: '模板名称只能包含字母、数字、点、下划线、短横线，长度 1-64' });
    const content = resolveTemplateContent(body);
    try {
      const info = templates.save(name, content, { create: true });
      log('tpl', `创建模板 ${name}`);
      return json(res, 201, { ok: true, template: info });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (method === 'PUT' && parts[1] === 'templates' && parts[2]) {
    requirePerm(req, url, 'templates:write');
    const name = decodeURIComponent(parts[2]);
    const body = await readJson(req, 512 * 1024);
    const content = resolveTemplateContent(body);
    try {
      const info = templates.save(name, content, { create: false });
      log('tpl', `保存模板 ${name}`);
      return json(res, 200, { ok: true, template: info });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (method === 'DELETE' && parts[1] === 'templates' && parts[2]) {
    requirePerm(req, url, 'templates:write');
    const name = decodeURIComponent(parts[2]);
    try {
      templates.remove(name);
      log('tpl', `删除模板 ${name}`);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // 可视化模型 → ini 文本（不落盘，供前端草稿预览/转换使用）
  if (method === 'POST' && parts[1] === 'templates' && parts[2] === 'build') {
    requirePerm(req, url, 'templates:write');
    const body = await readJson(req, 512 * 1024);
    try {
      const content = resolveTemplateContent(body);
      return json(res, 200, { ok: true, content });
    } catch (e) {
      return json(res, e.status || 400, { error: e.message, details: e.details || null });
    }
  }

  // 把任意 ini 文本解析成可视化模型（原始编辑 → 可视化切换用）
  if (method === 'POST' && parts[1] === 'templates' && parts[2] === 'parse') {
    requirePerm(req, url, 'templates:write');
    const body = await readJson(req, 512 * 1024);
    const content = String(body.content || '');
    const model = parseIni(content);
    return json(res, 200, { ok: true, model, meta: model.meta, warnings: model.warnings });
  }

  // 模板预览：不落盘，直接跑一次转换
  if (method === 'POST' && parts[1] === 'templates' && parts[2] === 'preview') {
    requirePerm(req, url, 'templates:write');
    if (!can(req, url, 'convert')) hitLimiter(limiters.convert, req);
    const actor = currentUser(req);
    const quota = assertQuotaActive(actor);
    const body = await readJson(req, 512 * 1024);
    const content = resolveTemplateContent(body);
    const model = parseIni(content);
    const validation = validateModel(model, { targetIds: targetList().map((t) => t.id) });
    if (!validation.ok) return json(res, 400, { error: validation.errors[0], errors: validation.errors, warnings: validation.warnings });

    const target = resolveTargetOrThrow(body.target, resolveTarget('mihomo'));
    assertConvertQuota(actor, quota, target);
    let sources;
    try {
      sources = normSources(body.sources);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    try {
      const result = await runConversion({
        sources,
        target,
        templateContent: content,
        include: body.include,
        exclude: body.exclude,
        opts: body.opts,
      });
      bumpQuota(actor, 'convert');
      logConvert(req, target, `预览成功 · ${result.nodes} 节点 · ${fmtBytes(result.bytes)} · ${result.ms}ms`, 'info', actor && actor.username);
      return json(res, 200, {
        ok: true,
        target: target.id,
        nodes: result.nodes,
        bytes: result.bytes,
        ms: result.ms,
        body: sanitizeManagedConfig(result.body, null),
        content,
        warnings: validation.warnings,
      });
    } catch (e) {
      logConvert(req, target, `预览失败：${e.message}`, 'error', actor && actor.username);
      if (e.network) logNetwork(req, e.message, actor && actor.username);
      return json(res, e.status || 502, { error: e.message, detail: e.detail || '', warnings: validation.warnings });
    }
  }

  // —— 内置规则集目录（MetaCubeX/meta-rules-dat 全量） ——
  if (method === 'POST' && parts[1] === 'catalog' && parts[2] === 'refresh') {
    requirePerm(req, url, 'catalog:refresh');
    try {
      const summary = await catalog.refresh();
      log('catalog', `规则集目录已更新：${summary.count} 条`);
      return json(res, 200, { ok: true, ...summary });
    } catch (e) {
      log('catalog', `更新规则集目录失败：${e.message}`);
      return json(res, 502, { error: `更新失败：${e.message}` });
    }
  }

  if (method === 'GET' && parts[1] === 'rules' && !parts[2]) {
    const result = catalog.search({
      q: url.searchParams.get('q') || '',
      kind: url.searchParams.get('kind') || '',
      group: url.searchParams.get('group') || '',
      limit: Number(url.searchParams.get('limit') || 40),
      offset: Number(url.searchParams.get('offset') || 0),
    });
    return json(res, 200, {
      ...result,
      total: result.total,
      catalogCount: catalog.total,
      groups: catalog.groups,
    });
  }

  if (method === 'GET' && parts[1] === 'rules' && parts[2]) {
    const item = catalog.get(decodeURIComponent(parts[2]));
    if (!item) return json(res, 404, { error: '规则集不存在' });
    return json(res, 200, item);
  }

  // —— 资源库：规则集 / 基础配置 / DNS 配置 / 来源仓库 ——
  const LIB_KINDS = { rulesets: 'ruleset', bases: 'base', dns: 'dns', repos: 'repo' };

  if (parts[1] === 'library' && parts[2] === 'settings') {
    if (method === 'GET') return json(res, 200, { settings: library.getSettings() });
    if (method === 'PUT') {
      requirePerm(req, url, 'library:write');
      const body = await readJson(req, 8 * 1024);
      try {
        const settings = library.saveSettings(body);
        return json(res, 200, { ok: true, settings });
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }
  }

  if (parts[1] === 'library' && parts[2] === 'categories') {
    if (method === 'GET' && !parts[3]) {
      return json(res, 200, { categories: library.listCats() });
    }
    if (method === 'POST' && !parts[3]) {
      requirePerm(req, url, 'library:write');
      const body = await readJson(req, 8 * 1024);
      try {
        const category = library.saveCat({ name: body.name, color: body.color, order: body.order });
        log('lib', `新增规则分类：${category.name}`);
        return json(res, 201, { ok: true, category, categories: library.listCats() });
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }
    if ((method === 'PUT' || method === 'DELETE') && parts[3]) {
      requirePerm(req, url, 'library:write');
      const name = decodeURIComponent(parts[3]);
      try {
        if (method === 'PUT') {
          const body = await readJson(req, 8 * 1024);
          const category = library.saveCat({ name: body.name || name, color: body.color, order: body.order }, name);
          log('lib', `保存规则分类：${category.name}`);
          return json(res, 200, { ok: true, category, categories: library.listCats() });
        }
        const out = library.removeCat(name, { moveTo: url.searchParams.get('moveTo') || '' });
        log('lib', `删除规则分类：${name}（迁移 ${out.moved} 项到 ${out.moveTo}）`);
        return json(res, 200, { ok: true, ...out, categories: library.listCats() });
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }
  }

  if (method === 'GET' && parts[1] === 'library' && !parts[2]) {
    return json(res, 200, {
      rulesets: library.list('ruleset'),
      bases: library.list('base'),
      dns: library.list('dns'),
      repos: library.list('repo'),
      categories: library.listCats(),
      settings: library.getSettings(),
      formats: ['mihomo', 'singbox', 'any'],
      behaviors: ['domain', 'ipcidr', 'classical'],
    });
  }

  if (method === 'POST' && parts[1] === 'library' && parts[2] === 'rulesets' && parts[3] && parts[4] === 'check') {
    requirePerm(req, url, 'library:write');
    try {
      const out = await library.checkRuleset(decodeURIComponent(parts[3]));
      log('lib', `检查规则集更新：${parts[3]}${out.changed ? ' 有更新' : ' 已是最新'}`);
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, e.status || 502, { error: e.message });
    }
  }

  if (method === 'POST' && parts[1] === 'library' && parts[2] === 'upload') {
    requirePerm(req, url, 'library:write');
    const body = await readJson(req, 24 * 1024 * 1024);
    const raw = String(body.name || 'ruleset.bin');
    const base = path.basename(raw).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const ext = path.extname(base).toLowerCase();
    if (!['.mrs', '.srs', '.yaml', '.yml', '.list', '.txt', '.conf'].includes(ext)) {
      return json(res, 400, { error: '仅支持 .mrs / .srs / .yaml / .list / .txt / .conf' });
    }
    let buf;
    try { buf = Buffer.from(String(body.data || ''), 'base64'); } catch { buf = null; }
    if (!buf || !buf.length) return json(res, 400, { error: '文件内容为空' });
    if (buf.length > 16 * 1024 * 1024) return json(res, 413, { error: '文件超过 16MB' });
    const dir = path.join(RULES_DIR, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const stored = `${Date.now().toString(36)}-${base}`;
    fs.writeFileSync(path.join(dir, stored), buf);
    log('lib', `上传本地规则文件：${stored}（${buf.length} 字节）`);
    return json(res, 200, { ok: true, url: `${externalBase(req)}/api/library/file/${encodeURIComponent(stored)}`, name: stored, size: buf.length });
  }

  if (method === 'GET' && parts[1] === 'library' && parts[2] === 'file' && parts[3]) {
    const stored = path.basename(decodeURIComponent(parts[3]));
    const full = path.join(RULES_DIR, 'uploads', stored);
    if (!stored || !fs.existsSync(full)) return json(res, 404, { error: '文件不存在' });
    const ext = path.extname(stored).toLowerCase();
    const type = ext === '.mrs' || ext === '.srs' ? 'application/octet-stream'
      : ext === '.yaml' || ext === '.yml' ? 'text/yaml; charset=utf-8'
        : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300', 'Content-Length': fs.statSync(full).size });
    return fs.createReadStream(full).pipe(res);
  }

  if (parts[1] === 'library' && parts[2]) {
    const kind = LIB_KINDS[parts[2]];
    if (!kind) return json(res, 404, { error: '未知的资源类型' });
    if (method === 'GET' && !parts[3]) {
      return json(res, 200, { kind, items: library.list(kind, { withContent: url.searchParams.get('content') === '1' }) });
    }
    if (method === 'GET' && parts[3]) {
      const item = library.get(kind, decodeURIComponent(parts[3]));
      if (!item) return json(res, 404, { error: '资源不存在' });
      return json(res, 200, item);
    }
    if (method === 'POST' && !parts[3]) {
      requirePerm(req, url, 'library:write');
      const body = await readJson(req, 256 * 1024);
      try {
        const item = library.save(kind, body, { create: true });
        log('lib', `新增 ${kind}：${item.id}`);
        return json(res, 201, { ok: true, item });
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }
    if (method === 'PUT' && parts[3]) {
      requirePerm(req, url, 'library:write');
      const body = await readJson(req, 256 * 1024);
      try {
        const item = library.save(kind, { ...body, id: decodeURIComponent(parts[3]) }, { create: false });
        log('lib', `保存 ${kind}：${item.id}`);
        return json(res, 200, { ok: true, item });
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }
    if (method === 'DELETE' && parts[3]) {
      requirePerm(req, url, 'library:write');
      try {
        library.remove(kind, decodeURIComponent(parts[3]));
        log('lib', `删除 ${kind}：${parts[3]}`);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }
  }

  // —— 节点预览：把订阅 / 链接 / YAML / JS 内容解析成可编辑节点 ——
  if (method === 'POST' && parts[1] === 'nodes' && parts[2] === 'preview') {
    if (!isAdmin(req, url)) hitLimiter(limiters.convert, req);
    const body = await readJson(req, 1024 * 1024);
    const mode = String(body.mode || 'url');
    const warnings = [];
    try {
      let listUrls = null;
      let nodes = [];
      if (mode === 'nodes') {
        const cleaned = normalizeNodes(body.nodes);
        if (cleaned.errors.length) return json(res, 400, { error: cleaned.errors[0] });
        warnings.push(...cleaned.warnings);
        nodes = cleaned.nodes;
        if (!nodes.length) return json(res, 400, { error: '没有有效节点' });
        listUrls = [`${cfg.selfUrl}/src/${sourceStore.register(nodesToYaml(nodes), 'application/yaml')}`];
      } else if (mode === 'url') {
        const sources = normSources(body.urls || body.sources);
        if (!sources.length) return json(res, 400, { error: '请填写订阅链接' });
        const checked = await assertSources(sources, { allowPrivate: cfg.allowPrivateSources });
        const prepared = await prepareSources(sourceStore, checked, {
          selfUrl: cfg.selfUrl,
          timeout: 15000,
          allowPrivate: cfg.allowPrivateSources,
          logger: log,
        });
        listUrls = prepared.urls;
      } else {
        const raw = String(body.text || '');
        if (!raw.trim()) return json(res, 400, { error: '内容为空' });
        const normalized = normalizeSubscription(raw, String(body.filename || '粘贴内容'));
        const id = sourceStore.register(normalized.body, 'application/octet-stream');
        listUrls = [`${cfg.selfUrl}/src/${id}`];
        warnings.push(...(normalized.warnings || []));
      }

      const text = await engine.listProxies(listUrls);
      const parsed = parseProxyYaml(text);
      const cleaned = normalizeNodes(parsed);
      return json(res, 200, {
        ok: true,
        count: cleaned.nodes.length,
        nodes: cleaned.nodes,
        warnings: [...warnings, ...cleaned.warnings],
      });
    } catch (e) {
      return json(res, e.status || 400, { error: e.message, warnings });
    }
  }

  // —— 转换 / 临时链接 ——
  if (method === 'POST' && parts[1] === 'convert') {
    if (!isAdmin(req, url)) hitLimiter(limiters.convert, req);
    if (currentUser(req) && !can(req, url, 'convert')) throw new HttpError(403, '没有「转换」权限');
    const actor = currentUser(req);
    const quota = assertQuotaActive(actor);
    const body = await readJson(req, 1024 * 1024);
    const target = resolveTargetOrThrow(body.target, resolveTarget('mihomo'));
    assertConvertQuota(actor, quota, target);
    const sources = normSources(body.sources);
    const nodes = Array.isArray(body.nodes) ? body.nodes : [];
    if (!sources.length && !nodes.length) return json(res, 400, { error: '请至少提供一个订阅源或节点' });
    const useInline = !!body.templateContent;
    if (useInline) requirePerm(req, url, 'templates:write');
    const layers = {
      baseId: body.baseId || '',
      dnsId: body.dnsId || '',
      rulesetIds: Array.isArray(body.rulesetIds) ? body.rulesetIds : [],
      publicBase: externalBase(req),
    };

    try {
      const result = await runConversion({
        sources,
        nodes,
        target,
        templateName: body.template,
        templateContent: useInline ? body.templateContent : null,
        include: body.include,
        exclude: body.exclude,
        opts: body.opts,
        ...layers,
      });
      const maxPreview = 1024 * 1024;
      const managedUrl = useInline
        ? null
        : ephemeralUrlFor(req, {
          sources,
          target,
          template: body.template || 'full',
          include: body.include,
          exclude: body.exclude,
          opts: body.opts,
          ...layers,
        });
      const outBody = sanitizeManagedConfig(result.body, managedUrl);
      const truncated = outBody.length > maxPreview;
      bumpQuota(actor, 'convert');
      logConvert(req, target, `成功 · ${result.nodes} 节点 · ${fmtBytes(Buffer.byteLength(outBody, 'utf8'))} · ${result.ms}ms`, 'info', actor && actor.username);
      return json(res, 200, {
        ok: true,
        target: target.id,
        targetLabel: target.label,
        template: result.template,
        nodes: result.nodes,
        bytes: Buffer.byteLength(outBody, 'utf8'),
        ms: result.ms,
        truncated,
        warnings: result.warnings,
        body: truncated ? outBody.slice(0, maxPreview) : outBody,
      });
    } catch (e) {
      logConvert(req, target, `失败：${e.message}`, 'error', actor && actor.username);
      if (e.network) logNetwork(req, e.message, actor && actor.username);
      return json(res, e.status || 502, { error: e.message, detail: e.detail || '' });
    }
  }

  if (method === 'POST' && parts[1] === 'link') {
    if (!isAdmin(req, url)) hitLimiter(limiters.link, req);
    const body = await readJson(req, 128 * 1024);
    if (Array.isArray(body.nodes) && body.nodes.length) {
      return json(res, 400, { error: '自定义节点无法放进临时链接，请改用「固定订阅」保存' });
    }
    const target = resolveTargetOrThrow(body.target, resolveTarget('mihomo'));
    const sources = normSources(body.sources);
    if (!sources.length) return json(res, 400, { error: '请至少填写一个订阅链接' });
    const templateName = String(body.template || 'full');
    if (!TemplateStore.isValidName(templateName) || !templates.has(templateName)) {
      return json(res, 400, { error: `模板不存在：${templateName}` });
    }
    try {
      await assertSources(sources, { allowPrivate: cfg.allowPrivateSources });
    } catch (e) {
      return json(res, e.status || 400, { error: e.message });
    }
    const payload = { s: sources, t: target.id, p: templateName };
    if (body.include) payload.i = String(body.include).slice(0, 300);
    if (body.exclude) payload.e = String(body.exclude).slice(0, 300);
    if (body.baseId) payload.b = String(body.baseId).slice(0, 48);
    if (body.dnsId) payload.d = String(body.dnsId).slice(0, 48);
    if (Array.isArray(body.rulesetIds) && body.rulesetIds.length) {
      const refs = encodeRuleRefs(body.rulesetIds);
      if (refs) payload.r = refs;
    }
    payload.o = normOpts(body.opts);
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    if (encoded.length > 7000) return json(res, 400, { error: '参数过长，临时链接最多支持约 7KB；请改用固定订阅' });
    return json(res, 200, {
      ok: true,
      url: `${externalBase(req)}/c/${encoded}`,
      bytes: encoded.length,
    });
  }

  // —— 固定订阅管理 ——
  if (parts[1] === 'profiles') {
    requirePerm(req, url, method === 'GET' ? 'subscribe' : 'profiles:write');

    if (method === 'GET' && !parts[2]) {
      const base = externalBase(req);
      return json(res, 200, {
        profiles: profiles.all().map((p) => profileView(p.token, p, base)),
      });
    }

    if (method === 'POST' && !parts[2]) {
      const body = await readJson(req, 512 * 1024);
      if (!templates.has(String(body.template || 'full'))) {
        return json(res, 400, { error: `模板不存在：${body.template || 'full'}` });
      }
      const refError = checkLibraryRefs(body);
      if (refError) return json(res, 400, { error: refError });
      try {
        const sources = await assertSources(normSources(body.sources), { allowPrivate: cfg.allowPrivateSources });
        const created = profiles.create({ ...body, sources });
        log('cfg', `创建固定订阅 ${maskToken(created.token)}（${created.name}）`);
        return json(res, 201, { ok: true, profile: profileView(created.token, created, externalBase(req)) });
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }

    if (method === 'PUT' && parts[2]) {
      const token = decodeURIComponent(parts[2]);
      const body = await readJson(req, 512 * 1024);
      if (body.template !== undefined && !templates.has(String(body.template))) {
        return json(res, 400, { error: `模板不存在：${body.template}` });
      }
      const refError = checkLibraryRefs(body);
      if (refError) return json(res, 400, { error: refError });
      try {
        const patch = { ...body };
        if (body.sources !== undefined) {
          patch.sources = await assertSources(normSources(body.sources), { allowPrivate: cfg.allowPrivateSources });
        }
        const updated = profiles.update(token, patch);
        log('cfg', `更新固定订阅 ${maskToken(token)} → rev ${updated.revision}`);
        return json(res, 200, { ok: true, profile: profileView(token, updated, externalBase(req)) });
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }

    if (method === 'DELETE' && parts[2]) {
      const token = decodeURIComponent(parts[2]);
      try {
        profiles.remove(token);
        log('cfg', `删除固定订阅 ${maskToken(token)}`);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, e.status || 400, { error: e.message });
      }
    }

    if (method === 'POST' && parts[2] && parts[3] === 'test') {
      const token = decodeURIComponent(parts[2]);
      const profile = profiles.get(token);
      if (!profile) return json(res, 404, { error: '订阅不存在' });
      const targets = ['mihomo', 'singbox', 'surge', 'loon', 'quanx']
        .map((id) => resolveTarget(id))
        .filter(Boolean);
      const results = await Promise.all(targets.map(async (target) => {
        const started = Date.now();
        try {
          const result = await runConversion({
            sources: profile.sources,
            nodes: profile.nodes,
            target,
            templateName: profile.template,
            include: profile.include,
            exclude: profile.exclude,
            opts: profile.opts,
            baseId: profile.baseId,
            dnsId: profile.dnsId,
            rulesetIds: profile.rulesets,
            publicBase: externalBase(req),
          });
          return { target: target.id, label: target.label, ok: true, nodes: result.nodes, bytes: result.bytes, ms: Date.now() - started };
        } catch (e) {
          return { target: target.id, label: target.label, ok: false, error: e.message, ms: Date.now() - started };
        }
      }));
      log('test', `自检 ${maskToken(token)}：${results.filter((r) => r.ok).length}/${results.length} 通过`);
      return json(res, 200, { ok: results.every((r) => r.ok), results });
    }
  }

  if (method === 'GET' && parts[1] === 'logs') {
    const user = currentUser(req);
    // admin（含管理口令）或拥有 logs:view 的用户看全部，其他登录用户只看自己
    const all = isAdmin(req, url) || (user ? can(req, url, 'logs:view') : false);
    const scope = all ? 'all' : 'self';
    const cat = String(url.searchParams.get('cat') || 'all').toLowerCase();
    const q = url.searchParams.get('q') || '';
    const limit = Number(url.searchParams.get('limit') || 200);
    if (!user) {
      const empty = logBuffer.summary({ scope: 'self', user: null });
      return json(res, 200, { items: [], cats: empty, scope: 'self' });
    }
    const items = logBuffer.list({ cat, limit, q, scope, user: user.username });
    const cats = logBuffer.summary({ scope, user: user.username, q });
    return json(res, 200, { items, cats, scope });
  }

  if (method === 'POST' && parts[1] === 'engine' && parts[2] === 'check') {
    requirePerm(req, url, 'engine:write');
    const status = await refreshEngineStatus();
    return json(res, 200, { engine: status });
  }

  if (method === 'POST' && parts[1] === 'cache' && parts[2] === 'clear') {
    requirePerm(req, url, 'engine:write');
    cache.clear();
    log('cfg', '缓存已清空');
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && parts[1] === 'admin' && parts[2] === 'check') {
    requireAdmin(req, url);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: '接口不存在' });
}

function checkLibraryRefs(body) {
  if (!body) return '';
  if (body.baseId) {
    const item = library.find('base', String(body.baseId));
    if (!item) return `基础配置不存在：${body.baseId}`;
    if (item.format !== 'any' && item.format !== 'mihomo' && item.format !== 'singbox') return '基础配置格式无效';
  }
  if (body.dnsId) {
    const item = library.find('dns', String(body.dnsId));
    if (!item) return `DNS 配置不存在：${body.dnsId}`;
  }
  if (Array.isArray(body.rulesets)) {
    for (const ref of body.rulesets) {
      const id = String((ref && typeof ref === 'object' ? ref.id : ref) || '');
      if (!id) continue;
      if (Array.isArray(ref && ref.inline) && ref.inline.length) continue;
      if (id.startsWith('gs:') || id.startsWith('gi:')) {
        if (!catalog.get(id)) return `规则集不存在：${id}`;
      } else if (!library.find('ruleset', id)) {
        return `规则集不存在：${id}`;
      }
    }
  }
  return '';
}

function resolveTemplateContent(body) {
  if (body && typeof body.content === 'string' && body.content.trim()) {
    return body.content;
  }
  if (body && body.model && typeof body.model === 'object') {
    const validation = validateModel(body.model, { targetIds: targetList().map((t) => t.id) });
    if (!validation.ok) {
      const err = new HttpError(400, validation.errors[0]);
      err.details = validation;
      throw err;
    }
    return buildIni(body.model);
  }
  throw new HttpError(400, '缺少模板内容（content 或 model）');
}

// ───────────────────────────── 静态资源 ─────────────────────────────
const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8', cache: 'no-cache' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml', cache: 'max-age=86400' },
  '/vendor/qrcode.js': { file: 'vendor/qrcode.js', type: 'application/javascript; charset=utf-8', cache: 'max-age=86400' },
  '/vendor/jsQR.js': { file: 'vendor/jsQR.js', type: 'application/javascript; charset=utf-8', cache: 'max-age=86400' },
};

const WEB_DIR = path.join(__dirname, 'web');
const HTML_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

const WEB_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function readIfExists(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

function serveStatic(res, pathname, req) {
  // ── 新版（Vue + Naive UI）单页应用 ──
  const isAsset = pathname.startsWith('/assets/');
  const reserved = /^\/(api|src|tpl|tpl-inline|s|c|health)(\/|$)/.test(pathname);
  const looksLikeRoute = !pathname.includes('.') && !reserved;
  if (pathname === '/' || pathname === '/index.html' || (looksLikeRoute && !pathname.startsWith('/legacy'))) {
    const buf = readIfExists(path.join(WEB_DIR, 'index.html'));
    if (buf) {
      // 反代子路径：注入运行时 base，前端 fetch 与相对资源据此解析
      let html = buf.toString('utf8');
      if (!html.includes('__SUBHUB_BASE__')) {
        const prefix = requestPrefix(req);
        const bp = JSON.stringify(prefix);
        // 相对资源（./assets/…）统一从子路径根解析，深链接与无尾斜杠访问都不会打偏
        const baseTag = prefix && !/<base[\s>]/i.test(html) ? `<base href="${prefix}/">` : '';
        html = html.replace('</head>', `${baseTag}<script>window.__SUBHUB_BASE__=${bp}</script></head>`);
      }
      send(res, 200, Buffer.from(html, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...HTML_HEADERS });
      return true;
    }
  }
  if (isAsset) {
    const rel = path.normalize(pathname).replace(/^([/\\])+/, '');
    const file = path.join(WEB_DIR, rel);
    if (file.startsWith(WEB_DIR)) {
      const buf = readIfExists(file);
      if (buf) {
        send(res, 200, buf, { 'Content-Type': WEB_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return true;
      }
    }
    return false;
  }

  // ── 旧版界面：/legacy/*（保留未迁移能力与老链接） ──
  if (pathname.startsWith('/legacy')) {
    const rel = pathname.replace(/^\/legacy\/?/, '') || 'index.html';
    const file = path.join(PUBLIC_DIR, rel);
    if (file.startsWith(PUBLIC_DIR)) {
      const buf = readIfExists(file);
      if (buf) {
        const type = rel.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : rel.endsWith('.js')
            ? 'application/javascript; charset=utf-8'
            : rel.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : rel.endsWith('.svg')
                ? 'image/svg+xml'
                : 'application/octet-stream';
        send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': rel.endsWith('.html') ? 'no-cache' : 'max-age=86400', ...(rel.endsWith('.html') ? HTML_HEADERS : {}) });
        return true;
      }
    }
    return false;
  }

  // ── 根路径的旧静态资源（favicon 等）──
  const item = STATIC[pathname];
  if (!item) return false;
  const file = path.join(PUBLIC_DIR, item.file);
  try {
    const buf = fs.readFileSync(file);
    const headers = { 'Content-Type': item.type, 'Cache-Control': item.cache };
    if (pathname.endsWith('.html')) Object.assign(headers, HTML_HEADERS);
    send(res, 200, buf, headers);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── 主路由 ─────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // 反代子路径：/sub 补尾斜杠，否则页面里的相对资源（./assets/…）会解析到根路径
  if ((req.method === 'GET' || req.method === 'HEAD') && cfg.basePath && url.pathname === cfg.basePath) {
    return send(res, 302, '', { Location: `${cfg.basePath}/${url.search}` });
  }
  // 反代子路径：配置了 SUBHUB_BASE_PATH 时先剥前缀，再走原有路由
  if (cfg.basePath && (url.pathname === cfg.basePath || url.pathname.startsWith(`${cfg.basePath}/`))) {
    url.pathname = url.pathname.slice(cfg.basePath.length) || '/';
  }
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
  }

  try {
    if (p === '/health' || p === '/api/health') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        uptime: Math.floor((Date.now() - bootAt) / 1000),
        profiles: profiles.all().length,
        templates: templates.list().length,
        engine: engineStatusCached(),
      });
    }

    if (req.method === 'GET' && serveStatic(res, p, req)) return undefined;

    if (p.startsWith('/tpl/')) {
      const name = p.slice('/tpl/'.length).replace(/\.ini$/, '');
      const info = templates.get(name);
      if (!info) return send(res, 404, '# 模板不存在\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return send(res, 200, info.content, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }

    if (p.startsWith('/tpl-inline/')) {
      const id = p.slice('/tpl-inline/'.length).replace(/\.ini$/, '');
      const entry = inlineTemplates.get(id);
      if (!entry || entry.exp <= Date.now()) {
        if (entry) inlineTemplates.delete(id);
        return send(res, 404, '# 模板已过期\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      return send(res, 200, entry.content, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }

    if (p.startsWith('/src/')) {
      const id = p.slice('/src/'.length);
      const item = sourceStore.get(id);
      if (!item) return send(res, 404, '# 订阅源已过期，请刷新订阅\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return send(res, 200, item.body, {
        'Content-Type': `${item.contentType}; charset=utf-8`,
        'Cache-Control': 'no-store',
      });
    }

    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    if (p.startsWith('/s/')) {
      const seg = p.split('/').filter(Boolean);
      const token = seg[1] ? decodeURIComponent(seg[1]) : '';
      if (!token) return send(res, 404, '# 缺少订阅 token\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return await handleSubscription(req, res, url, token, seg[2] ? decodeURIComponent(seg[2]) : '');
    }

    if (p.startsWith('/c/')) {
      const payload = p.slice(3).replace(/\/+$/, '');
      if (!payload) return send(res, 404, '# 缺少临时链接参数\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      return await handleEphemeral(req, res, url, payload);
    }

    if (p === '/' || p === '') {
      if (serveStatic(res, '/', req)) return undefined;
    }

    return send(res, 404, 'Not Found\n', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (e.status || 500);
    const isApi = p.startsWith('/api/');
    const headers = { ...((e && e.extra && e.extra.headers) || {}) };
    if (status >= 500) log('err', `${req.method} ${p}: ${e.stack || e.message}`);
    else log('warn', `${req.method} ${p}: ${e.message}`);
    if (isApi) return json(res, status, { error: e.message, ...(e.details ? { details: e.details } : {}) }, headers);
    return send(res, status, `# ${e.message}\n`, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  }
});

// ───────────────────────────── 启动 / 清理 ─────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of inlineTemplates) {
    if (entry.exp <= now) {
      inlineTemplates.delete(id);
      inlineByHash.delete(sha1(entry.content));
    }
  }
  sourceStore.sweep();
}, 60 * 1000).unref();

setInterval(() => {
  refreshEngineStatus().catch(() => {});
}, 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  log('boot', `SubHub Gateway v${VERSION} 监听 :${PORT}`);
  log('boot', `引擎地址   = ${cfg.subconverter}`);
  log('boot', `内部地址   = ${cfg.selfUrl}`);
  log('boot', `对外地址   = ${cfg.publicBase || '(按请求 Host 自动推断)'}`);
  log('boot', `反代前缀   = ${cfg.basePath || '(无)'}`);
  log('boot', `管理口令   = ${cfg.adminKey ? '已设置' : '未设置（管理接口关闭）'}`);
  log('boot', `私网订阅源 = ${cfg.allowPrivateSources ? '允许' : '禁止'}`);
  const hostRoot = process.env.CONFIG_HOST_ROOT || '';
  log('boot', `配置根目录 = ${CONFIG_DIR}${hostRoot ? `（宿主机 ${hostRoot}）` : ''}`);
  for (const [label, dir] of [['规则', RULES_DIR], ['图标', ICONS_DIR], ['模板', TEMPLATES_DIR], ['缓存', CACHE_DIR], ['状态', STATE_DIR]]) {
    const host = hostRoot ? `${hostRoot}/${path.basename(dir)}` : '';
    log('boot', `  ${label} = ${dir}${host ? `（宿主机 ${host}）` : ''}`);
  }
  probeEngine();
});

// 网络规则集自动更新：每 30 分钟检查一次到期的规则集，启动 90 秒后先跑一轮
const autoUpdateTimer = setInterval(() => {
  library.autoUpdateDue(6).then((rows) => {
    const changed = rows.filter((r) => r.changed).length;
    if (rows.length) log('lib', `规则集自动检查：${rows.length} 项，${changed} 项有更新`);
  }).catch((e) => log('err', `规则集自动检查失败：${e.message}`));
}, 30 * 60 * 1000);
autoUpdateTimer.unref();
setTimeout(() => {
  library.autoUpdateDue(3).catch(() => {});
}, 90 * 1000).unref();

// 引擎可能比网关晚就绪（compose 只保证启动顺序），启动后带退避重试几次
async function probeEngine() {
  for (let i = 0; i < 6; i += 1) {
    try {
      const status = await refreshEngineStatus();
      if (status.ok) {
        log('boot', `引擎就绪   = ${status.version}`);
        return;
      }
    } catch (e) {
      log('warn', `引擎探测失败：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  log('warn', '引擎暂不可用，转换请求将直接报错；60 秒后自动重试');
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('boot', `收到 ${sig}，正在退出`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

process.on('unhandledRejection', (e) => {
  log('err', `unhandledRejection: ${(e && e.stack) || e}`);
});





