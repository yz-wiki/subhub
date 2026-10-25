'use strict';

/**
 * 账号与会话：SQLite 存储（node:sqlite）+ scrypt 口令 + 角色/细粒度权限。
 *
 * 数据文件：CONFIG_DIR/subhub.db
 *   users(id, username, role, salt, hash, perms, created_at, last_login_at, quota, usage)
 *   invites(code, role, perms, created_at, expires_at, used_by, used_at,
 *           kind, max_uses, used_count, note, quota, used_log)
 *
 * quota/usage 与邀请码扩展列由 migrateColumns() 用 ALTER TABLE 补齐，重复启动安全。
 * 首次启动会从旧的 users.json 迁移账号，迁移后 users.json 仍保留作为备份。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL = 12 * 60 * 60 * 1000;
const ROLES = ['admin', 'operator', 'user'];
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 4;

/** 可分配的权限；admin 恒定拥有全部 */
const PERMISSIONS = [
  'convert', // 转换 / 临时链接
  'subscribe', // 订阅 CRUD 与会话内查看
  'templates:write', // 模板写
  'library:write', // 规则集 / 基础 / DNS / 仓库写
  'profiles:write', // 固定订阅写
  'icons:write', // 图标库写
  'catalog:refresh', // 更新官方规则集目录
  'engine:write', // 引擎切换
  'logs:read', // 运行日志
  'logs:view', // 查看全部账号的日志（否则只能看自己的）
  'users:manage', // 账号 / 注册码
];

const ROLE_PERMS = {
  admin: PERMISSIONS.slice(),
  operator: [
    'convert', 'subscribe', 'templates:write', 'library:write',
    'profiles:write', 'icons:write', 'catalog:refresh', 'logs:read', 'logs:view',
  ],
  user: ['convert', 'subscribe'],
};

/** 配额默认值：数字 0 表示不限，clients 空数组表示不限制客户端 */
const QUOTA_DEFAULTS = {
  dailyConvert: 0,
  dailyPull: 0,
  maxProfiles: 0,
  clients: [],
  expiresAt: null,
};

/** 邀请码字符集：去掉 0/O/1/I，避免手抄歧义 */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LEN = 12;
const MAX_INVITE_USES = 1000;
const MAX_USED_LOG = 50;

function todayStr() {
  return dateStr(new Date());
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function quotaNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 基础清洗配额；clients 的合法性由 server.js 用 targets 列表校验 */
function normalizeQuota(input) {
  const src = input && typeof input === 'object' ? input : {};
  const clients = [];
  if (Array.isArray(src.clients)) {
    for (const raw of src.clients) {
      const id = String(raw == null ? '' : raw).trim();
      if (id && !clients.includes(id)) clients.push(id);
    }
  }
  let expiresAt = null;
  if (typeof src.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.expiresAt.trim())) {
    expiresAt = src.expiresAt.trim();
  }
  return {
    dailyConvert: quotaNumber(src.dailyConvert),
    dailyPull: quotaNumber(src.dailyPull),
    maxProfiles: quotaNumber(src.maxProfiles),
    clients,
    expiresAt,
  };
}

function normalizeUsage(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    date: typeof src.date === 'string' ? src.date : '',
    convert: quotaNumber(src.convert),
    pull: quotaNumber(src.pull),
  };
}

function parseInviteQuota(raw) {
  if (!raw) return null;
  try {
    return normalizeQuota(JSON.parse(raw));
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function newId(bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

function cleanPerms(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    const p = String(raw || '').trim();
    if (PERMISSIONS.includes(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

function effectivePerms(user) {
  if (!user) return [];
  if (user.role === 'admin') return PERMISSIONS.slice();
  const custom = Array.isArray(user.permissions) ? user.permissions : null;
  if (custom) return custom.slice();
  return (ROLE_PERMS[user.role] || []).slice();
}

function loadSqlite() {
  // node:sqlite 在 Node 22 上是实验特性，仅打印一次警告，可接受
  const { DatabaseSync } = require('node:sqlite');
  return DatabaseSync;
}

class AuthStore {
  constructor({ dataDir, logger = () => {} }) {
    this.dir = dataDir;
    this.dbFile = path.join(dataDir, 'subhub.db');
    this.legacyFile = path.join(dataDir, 'users.json');
    this.log = logger;
    this.sessions = new Map();
    this.db = null;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    const DatabaseSync = loadSqlite();
    this.db = new DatabaseSync(this.dbFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        perms TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT,
        quota TEXT,
        usage TEXT
      );
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        perms TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_by TEXT,
        used_at TEXT,
        kind TEXT DEFAULT 'register',
        max_uses INTEGER DEFAULT 1,
        used_count INTEGER DEFAULT 0,
        note TEXT,
        quota TEXT,
        used_log TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    this.migrateColumns();
    this.migrateLegacy();
    if (!this.countUsers()) {
      this.createUser({ username: 'admin', password: 'admin', role: 'admin' }, { quiet: true });
      this.log('auth', '已创建默认管理员 admin / admin，请尽快在「系统」页修改密码');
    }
    setInterval(() => this.sweepSessions(), 10 * 60 * 1000).unref();
  }

  /**
   * 给旧库补列。CREATE TABLE IF NOT EXISTS 不会改已存在的表，
   * 所以这里逐列 ALTER；重复启动会命中 duplicate column，由 try/catch 忽略。
   */
  migrateColumns() {
    this.addColumn('users', 'quota', 'quota TEXT');
    this.addColumn('users', 'usage', 'usage TEXT');
    this.addColumn('invites', 'kind', "kind TEXT DEFAULT 'register'");
    this.addColumn('invites', 'max_uses', 'max_uses INTEGER DEFAULT 1');
    const addedUsedCount = this.addColumn('invites', 'used_count', 'used_count INTEGER DEFAULT 0');
    this.addColumn('invites', 'note', 'note TEXT');
    this.addColumn('invites', 'quota', 'quota TEXT');
    this.addColumn('invites', 'used_log', 'used_log TEXT');
    if (addedUsedCount) {
      // 旧库里的注册码都是单次使用：已用过的补记 1 次，防止升级后被重复使用
      this.db.exec("UPDATE invites SET used_count = 1, used_log = '[]' WHERE used_by IS NOT NULL AND used_count = 0");
    }
  }

  hasColumn(table, column) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  }

  addColumn(table, column, ddl) {
    if (this.hasColumn(table, column)) return false;
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      return true;
    } catch (e) {
      if (!/duplicate column/i.test(String(e.message))) this.log('warn', `迁移 ${table}.${column} 失败：${e.message}`);
      return false;
    }
  }

  /** 把旧的 users.json 账号导入 SQLite（只做一次） */
  migrateLegacy() {
    if (!fs.existsSync(this.legacyFile)) return;
    const done = this.db.prepare("SELECT value FROM meta WHERE key = 'migrated_json'").get();
    if (done) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
      const users = Object.values((parsed && parsed.users) || {});
      const invites = Object.values((parsed && parsed.invites) || {});
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO users (id, username, role, salt, hash, perms, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const u of users) {
        if (!u || !u.id || !u.username) continue;
        insert.run(u.id, u.username, ROLES.includes(u.role) ? u.role : 'user', String(u.salt || ''), String(u.hash || ''), null, u.createdAt || nowIso(), u.lastLoginAt || null);
      }
      const insertInvite = this.db.prepare(
        'INSERT OR IGNORE INTO invites (code, role, perms, created_at, expires_at, used_by, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const i of invites) {
        if (!i || !i.code) continue;
        insertInvite.run(i.code, ROLES.includes(i.role) ? i.role : 'user', null, i.createdAt || nowIso(), i.expiresAt || nowIso(), i.usedBy || null, i.usedAt || null);
      }
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_json', ?)").run(nowIso());
      if (users.length) this.log('auth', `已从 users.json 迁移 ${users.length} 个账号到 SQLite`);
    } catch (err) {
      this.log('warn', `迁移 users.json 失败：${err.message}`);
    }
  }

  sweepSessions() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }

  // ── 用户 ────────────────────────────────────────────────
  rowToUser(row) {
    if (!row) return null;
    let permissions = null;
    if (row.perms) {
      try {
        permissions = JSON.parse(row.perms);
      } catch {
        permissions = null;
      }
    }
    let quota = null;
    let usage = null;
    try {
      if (row.quota) quota = JSON.parse(row.quota);
    } catch {
      quota = null;
    }
    try {
      if (row.usage) usage = JSON.parse(row.usage);
    } catch {
      usage = null;
    }
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      salt: row.salt,
      hash: row.hash,
      permissions,
      quota,
      usage,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at || null,
    };
  }

  publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions: effectivePerms(user),
      customPermissions: Array.isArray(user.permissions) ? user.permissions : null,
      quota: normalizeQuota(user.quota),
      usage: this.todayUsage(user.usage),
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt || null,
    };
  }

  /** 今天的用量；跨天自动视为 0（不写库，真正累加时由 bumpUsage 落盘） */
  todayUsage(usage) {
    const u = normalizeUsage(usage);
    const today = todayStr();
    if (u.date === today) return u;
    return { date: today, convert: 0, pull: 0 };
  }

  /** 原始用户对象（含 quota/usage，供配额校验用） */
  getRaw(id) {
    return this.rowToUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(String(id)));
  }

  quotaOf(id) {
    const user = this.getRaw(id);
    return user ? normalizeQuota(user.quota) : null;
  }

  usageOf(id) {
    const user = this.getRaw(id);
    return user ? this.todayUsage(user.usage) : null;
  }

  /** 累加当天用量（convert / pull），跨天自动清零；返回新的 usage */
  bumpUsage(id, field) {
    const key = field === 'pull' ? 'pull' : 'convert';
    const user = this.getRaw(id);
    if (!user) return null;
    const usage = this.todayUsage(user.usage);
    usage[key] = Math.max(0, Number(usage[key]) || 0) + 1;
    this.db.prepare('UPDATE users SET usage = ? WHERE id = ?').run(JSON.stringify(usage), String(id));
    return usage;
  }

  countUsers() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n || 0);
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all()
      .map((row) => this.publicUser(this.rowToUser(row)));
  }

  getById(id) {
    return this.getRaw(id);
  }

  isDefaultPassword(user) {
    if (!user) return false;
    return user.username === 'admin' && safeEqual(hashPassword('admin', user.salt), user.hash);
  }

  findByUsername(username) {
    const name = String(username || '').trim();
    return this.rowToUser(this.db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(name));
  }

  createUser(input, { quiet = false } = {}) {
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    const role = ROLES.includes(input.role) ? input.role : 'user';
    if (!USERNAME_RE.test(username)) throw httpError(400, '用户名需为 3–32 位字母、数字、下划线、点或短横线');
    if (!quiet && password.length < MIN_PASSWORD) throw httpError(400, `密码至少 ${MIN_PASSWORD} 位`);
    if (this.findByUsername(username)) throw httpError(409, '用户名已存在');
    const salt = crypto.randomBytes(16).toString('hex');
    const id = newId(8);
    const perms = cleanPerms(input.permissions);
    const quota = input.quota === undefined || input.quota === null ? null : JSON.stringify(normalizeQuota(input.quota));
    const usage = JSON.stringify({ date: todayStr(), convert: 0, pull: 0 });
    this.db.prepare(
      'INSERT INTO users (id, username, role, salt, hash, perms, created_at, last_login_at, quota, usage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, username, role, salt, hashPassword(password, salt), perms ? JSON.stringify(perms) : null, nowIso(), null, quota, usage);
    const user = this.getById(id);
    if (!quiet) this.log('auth', `新建账号 ${username}（${role}${perms ? '，自定义权限' : ''}）`);
    return this.publicUser(user);
  }

  updateUser(id, input) {
    const user = this.getById(id);
    if (!user) throw httpError(404, '账号不存在');
    let username = user.username;
    let role = user.role;
    let salt = user.salt;
    let hash = user.hash;
    let permissions = user.permissions;
    let quota = user.quota ? JSON.stringify(normalizeQuota(user.quota)) : null;
    if (input.username !== undefined) {
      const next = String(input.username || '').trim();
      if (!USERNAME_RE.test(next)) throw httpError(400, '用户名需为 3–32 位字母、数字、下划线、点或短横线');
      const dup = this.findByUsername(next);
      if (dup && dup.id !== id) throw httpError(409, '用户名已存在');
      username = next;
    }
    if (input.role !== undefined) {
      if (!ROLES.includes(input.role)) throw httpError(400, `角色只能是 ${ROLES.join(' / ')}`);
      if (user.role === 'admin' && input.role !== 'admin' && this.adminCount() <= 1) {
        throw httpError(400, '至少要保留一个管理员账号');
      }
      role = input.role;
    }
    if (input.permissions !== undefined) {
      permissions = input.permissions === null ? null : cleanPerms(input.permissions);
    }
    if (input.quota !== undefined) {
      quota = input.quota === null ? null : JSON.stringify(normalizeQuota(input.quota));
    }
    if (input.password) {
      const password = String(input.password);
      if (password.length < MIN_PASSWORD) throw httpError(400, `密码至少 ${MIN_PASSWORD} 位`);
      salt = crypto.randomBytes(16).toString('hex');
      hash = hashPassword(password, salt);
      for (const [token, session] of this.sessions) {
        if (session.userId === id) this.sessions.delete(token);
      }
    }
    this.db.prepare(
      'UPDATE users SET username = ?, role = ?, salt = ?, hash = ?, perms = ?, quota = ? WHERE id = ?',
    ).run(username, role, salt, hash, permissions ? JSON.stringify(permissions) : null, quota, id);
    const next = this.getById(id);
    this.log('auth', `更新账号 ${next.username}`);
    return this.publicUser(next);
  }

  removeUser(id, actorId) {
    const user = this.getById(id);
    if (!user) throw httpError(404, '账号不存在');
    if (id === actorId) throw httpError(400, '不能删除当前登录的账号');
    if (user.role === 'admin' && this.adminCount() <= 1) throw httpError(400, '至少要保留一个管理员账号');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(String(id));
    for (const [token, session] of this.sessions) {
      if (session.userId === id) this.sessions.delete(token);
    }
    this.log('auth', `删除账号 ${user.username}`);
    return { ok: true };
  }

  adminCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n || 0);
  }

  verify(username, password) {
    const user = this.findByUsername(username);
    if (!user) return null;
    const hash = hashPassword(password, user.salt);
    if (!safeEqual(hash, user.hash)) return null;
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
    return this.getById(user.id);
  }

  changePassword(id, currentPassword, nextPassword) {
    const user = this.getById(id);
    if (!user) throw httpError(404, '账号不存在');
    const hash = hashPassword(currentPassword || '', user.salt);
    if (!safeEqual(hash, user.hash)) throw httpError(400, '当前密码不正确');
    return this.updateUser(id, { password: nextPassword });
  }

  // ── 会话 ────────────────────────────────────────────────
  createSession(userId) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(token, { userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
    return token;
  }

  getSession(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    const user = this.getById(session.userId);
    if (!user) {
      this.sessions.delete(token);
      return null;
    }
    return { session, user };
  }

  destroySession(token) {
    if (token) this.sessions.delete(token);
  }

  /**
   * 给账号叠加额度（兑换码用）。语义：
   *  · days：在原到期日（不早于今天）上顺延；原为永久（null）则保持永久
   *  · dailyConvert / dailyPull / maxProfiles：原值 0（不限）保持不变，否则取较大值
   *  · clients：原数组为空（全部客户端）保持不变，否则取并集
   */
  redeemForUser(userId, delta = {}) {
    const user = this.getRaw(userId);
    if (!user) throw httpError(404, '账号不存在');
    const quota = normalizeQuota(user.quota);
    const add = normalizeQuota(delta);
    const days = Math.max(0, Math.trunc(Number(delta && delta.days) || 0));
    if (days > 0 && quota.expiresAt) {
      const start = quota.expiresAt > todayStr() ? quota.expiresAt : todayStr();
      const base = new Date(`${start}T00:00:00`);
      base.setDate(base.getDate() + days);
      quota.expiresAt = dateStr(base);
    } else if (add.expiresAt && quota.expiresAt && add.expiresAt > quota.expiresAt) {
      // 兑换码直接给到期日：只延长、不缩短；永久账号（null）保持不变
      quota.expiresAt = add.expiresAt;
    }
    const merge = (current, extra) => (current === 0 ? 0 : Math.max(current, extra));
    quota.dailyConvert = merge(quota.dailyConvert, add.dailyConvert);
    quota.dailyPull = merge(quota.dailyPull, add.dailyPull);
    quota.maxProfiles = merge(quota.maxProfiles, add.maxProfiles);
    if (quota.clients.length) {
      for (const id of add.clients) {
        if (!quota.clients.includes(id)) quota.clients.push(id);
      }
    }
    this.db.prepare('UPDATE users SET quota = ? WHERE id = ?').run(JSON.stringify(quota), String(userId));
    this.log('auth', `${user.username} 额度已更新（到期 ${quota.expiresAt || '永久'}）`, { user: user.username });
    return this.publicUser(this.getById(userId));
  }

  // ── 邀请码 / 兑换码 ─────────────────────────────────────
  /**
   * 生成一个 12 位大写字母数字码（去掉 0 O 1 I），单条。
   * kind=register 用于注册新账号，kind=redeem 用于已登录账号兑换额度。
   */
  createInvite(input = {}, { quiet = false } = {}) {
    const spec = this.inviteSpec(input);
    const code = this.insertInvite(spec);
    if (!quiet) {
      const label = spec.kind === 'redeem' ? '兑换码' : '注册码';
      this.log('auth', `生成${label} ${code}（${spec.role}，${spec.maxUses} 次，${spec.expiresAt ? spec.expiresAt.slice(0, 10) : '永久'}）`);
    }
    return this.inviteView(this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code));
  }

  /** 批量生成（1–50 个），参数只校验一次 */
  createInvites(input = {}, count = 1) {
    const spec = this.inviteSpec(input);
    const n = Math.min(50, Math.max(1, Math.trunc(Number(count) || 1)));
    const codes = [];
    for (let i = 0; i < n; i += 1) codes.push(this.insertInvite(spec));
    const label = spec.kind === 'redeem' ? '兑换码' : '注册码';
    this.log('auth', `批量生成 ${n} 个${label}（${spec.role}，${spec.maxUses} 次）`);
    return codes.map((code) => this.inviteView(this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code)));
  }

  /** 校验并归一化邀请码参数（不落库） */
  inviteSpec(input = {}) {
    const kind = input.kind === undefined || input.kind === null || input.kind === '' ? 'register' : String(input.kind);
    if (kind !== 'register' && kind !== 'redeem') throw httpError(400, '类型只能是 register / redeem');
    const role = ROLES.includes(input.role) ? input.role : 'user';
    const perms = cleanPerms(input.permissions);
    const maxUsesRaw = input.maxUses === undefined || input.maxUses === null || input.maxUses === ''
      ? 1
      : Number(input.maxUses);
    if (!Number.isFinite(maxUsesRaw) || maxUsesRaw < 1 || maxUsesRaw > MAX_INVITE_USES) {
      throw httpError(400, `使用次数需在 1–${MAX_INVITE_USES} 之间`);
    }
    const maxUses = Math.trunc(maxUsesRaw);
    const note = String(input.note || '').trim().slice(0, 200) || null;
    let quota = null;
    if (input.quota !== undefined && input.quota !== null) {
      quota = JSON.stringify(normalizeQuota(input.quota));
    }
    return {
      kind,
      role,
      perms,
      note,
      maxUses,
      quota,
      expiresAt: this.parseInviteExpiry(input.expiresAt, input.ttlHours),
    };
  }

  /** null/'' = 永久（存空串，兼容旧库 expires_at NOT NULL）；undefined = 按 ttlHours（默认 72 小时） */
  parseInviteExpiry(value, ttlHours) {
    if (value === null) return '';
    if (value === undefined) {
      const ttl = Math.min(24 * 30, Math.max(1, Number(ttlHours) || 72));
      return new Date(Date.now() + ttl * 3600 * 1000).toISOString();
    }
    const text = String(value).trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const d = new Date(`${text}T23:59:59.999`);
      if (Number.isNaN(d.getTime())) throw httpError(400, '到期时间格式不正确');
      return d.toISOString();
    }
    const ts = Date.parse(text);
    if (!Number.isFinite(ts)) throw httpError(400, '到期时间格式不正确');
    return new Date(ts).toISOString();
  }

  insertInvite(spec) {
    let code = '';
    do {
      code = this.randomInviteCode();
    } while (this.db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code));
    this.db.prepare(
      `INSERT INTO invites (code, role, perms, created_at, expires_at, used_by, used_at,
        kind, max_uses, used_count, note, quota, used_log)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, ?, '[]')`,
    ).run(
      code,
      spec.role,
      spec.perms ? JSON.stringify(spec.perms) : null,
      nowIso(),
      spec.expiresAt,
      spec.kind,
      spec.maxUses,
      spec.note,
      spec.quota,
    );
    return code;
  }

  randomInviteCode() {
    const bytes = crypto.randomBytes(INVITE_CODE_LEN);
    let out = '';
    for (let i = 0; i < INVITE_CODE_LEN; i += 1) out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
    return out;
  }

  inviteView(row) {
    if (!row) return null;
    const maxUses = Math.max(1, Number(row.max_uses) || 1);
    const usedCount = Math.max(0, Number(row.used_count) || 0);
    let permissions = null;
    try {
      if (row.perms) permissions = JSON.parse(row.perms);
    } catch {
      permissions = null;
    }
    let usedLog = [];
    try {
      const parsed = JSON.parse(row.used_log || '[]');
      if (Array.isArray(parsed)) usedLog = parsed;
    } catch {
      usedLog = [];
    }
    const expired = !!row.expires_at && Date.parse(row.expires_at) <= Date.now();
    return {
      code: row.code,
      kind: row.kind || 'register',
      role: row.role,
      permissions,
      note: row.note || '',
      maxUses,
      usedCount,
      remaining: Math.max(0, maxUses - usedCount),
      expiresAt: row.expires_at || null,
      createdAt: row.created_at,
      quota: parseInviteQuota(row.quota),
      status: usedCount >= maxUses ? 'used' : (expired ? 'expired' : 'active'),
      usedLog,
      // 兼容旧前端：首次使用信息与 expired 布尔
      usedBy: row.used_by || null,
      usedAt: row.used_at || null,
      expired,
    };
  }

  listInvites() {
    return this.db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all().map((row) => this.inviteView(row));
  }

  removeInvite(code) {
    const key = String(code || '').toUpperCase();
    if (!this.db.prepare('SELECT 1 FROM invites WHERE code = ?').get(key)) throw httpError(404, '注册码不存在');
    this.db.prepare('DELETE FROM invites WHERE code = ?').run(key);
    return { ok: true };
  }

  /** 记录一次使用：used_count+1、used_log 追加（最多 50 条）、首次使用时写 used_by/used_at */
  consumeInvite(code, row, user) {
    const maxUses = Math.max(1, Number(row.max_uses) || 1);
    const usedCount = Math.min(maxUses, Math.max(0, Number(row.used_count) || 0) + 1);
    let usedLog = [];
    try {
      const parsed = JSON.parse(row.used_log || '[]');
      if (Array.isArray(parsed)) usedLog = parsed;
    } catch {
      usedLog = [];
    }
    usedLog.push({ user: user.username, at: nowIso() });
    if (usedLog.length > MAX_USED_LOG) usedLog = usedLog.slice(-MAX_USED_LOG);
    const at = nowIso();
    this.db.prepare(
      'UPDATE invites SET used_count = ?, used_log = ?, used_by = COALESCE(used_by, ?), used_at = COALESCE(used_at, ?) WHERE code = ?',
    ).run(usedCount, JSON.stringify(usedLog), user.id, at, code);
    return usedCount;
  }

  /** 注册码使用校验：返回 { row, maxUses, usedCount }（失败直接抛中文错误） */
  openInvite(code, expectedKind) {
    const key = String(code || '').trim().toUpperCase();
    const row = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(key);
    if (!row) throw httpError(400, '注册码无效');
    const kind = row.kind || 'register';
    if (kind !== expectedKind) {
      throw httpError(400, expectedKind === 'register' ? '这是兑换码，请登录后在账号页兑换' : '该码是注册码，不能兑换额度');
    }
    const maxUses = Math.max(1, Number(row.max_uses) || 1);
    const usedCount = Math.max(0, Number(row.used_count) || 0);
    if (usedCount >= maxUses) throw httpError(400, '使用次数已用完');
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) throw httpError(400, '已过期');
    return { row, maxUses, usedCount };
  }

  registerWithInvite(code, username, password) {
    const { row, maxUses, usedCount } = this.openInvite(code, 'register');
    let permissions = null;
    try {
      if (row.perms) permissions = JSON.parse(row.perms);
    } catch {
      permissions = null;
    }
    const quota = parseInviteQuota(row.quota);
    const user = this.createUser({ username, password, role: row.role, permissions, quota });
    this.consumeInvite(row.code, row, user);
    this.log('auth', `通过注册码创建账号 ${user.username}（已用 ${usedCount + 1}/${maxUses}）`, { user: user.username });
    return user;
  }

  /**
   * 已登录用户用兑换码加额度。
   * 注意：与「给账号叠加额度」的 redeemForUser(userId, quota) 不同，这是校验码并调用它。
   */
  redeemCode(user, code) {
    if (!user) throw httpError(401, '请先登录');
    const key = String(code || '').trim().toUpperCase();
    const row = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(key);
    if (!row) throw httpError(404, '兑换码不存在');
    if ((row.kind || 'register') !== 'redeem') throw httpError(403, '该码不是兑换码，不能兑换额度');
    const maxUses = Math.max(1, Number(row.max_uses) || 1);
    const usedCount = Math.max(0, Number(row.used_count) || 0);
    if (usedCount >= maxUses) throw httpError(400, '兑换码使用次数已用完');
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) throw httpError(400, '兑换码已过期');
    const granted = parseInviteQuota(row.quota) || normalizeQuota(null);
    const updated = this.redeemForUser(user.id, granted);
    this.consumeInvite(row.code, row, user);
    this.log('auth', `${user.username} 使用兑换码 ${row.code}（已用 ${usedCount + 1}/${maxUses}）`, { user: user.username });
    return { user: updated, granted };
  }
}

module.exports = {
  AuthStore,
  parseCookies,
  SESSION_TTL,
  ROLES,
  PERMISSIONS,
  ROLE_PERMS,
  MIN_PASSWORD,
  QUOTA_DEFAULTS,
  normalizeQuota,
  todayStr,
  effectivePerms,
};

