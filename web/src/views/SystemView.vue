<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  NCard, NButton, NTag, NInput, NSelect, NAlert, NModal, NForm, NFormItem,
  NInputNumber, NDatePicker, NSwitch, NCheckbox, NPopover, useMessage,
} from 'naive-ui';
import { state, loadState, can } from '../state.js';
import { api } from '../api.js';

const message = useMessage();

/* ── 常量与格式化 ──────────────────────────────────────── */
const ROLE_LABELS = { admin: '管理员', operator: '操作员', user: '普通用户' };
const ROLE_TAG_TYPE = { admin: 'warning', operator: 'info', user: 'default' };
const engineModeOptions = [
  { label: '内置引擎（随本服务运行）', value: 'internal' },
  { label: '远程后端（自建 subconverter）', value: 'remote' },
];
const roleOptions = [
  { label: '管理员（全部权限）', value: 'admin' },
  { label: '操作员（内容管理）', value: 'operator' },
  { label: '普通用户（转换/订阅）', value: 'user' },
];
const roleFilterOptions = [
  { label: '全部角色', value: '' },
  { label: '管理员', value: 'admin' },
  { label: '操作员', value: 'operator' },
  { label: '普通用户', value: 'user' },
];
const kindOptions = [
  { label: '注册码（注册新账号）', value: 'register' },
  { label: '兑换码（给已有账号加额度）', value: 'redeem' },
];
const kindFilterOptions = [
  { label: '全部类型', value: '' },
  { label: '注册码', value: 'register' },
  { label: '兑换码', value: 'redeem' },
];
const inviteExpiryOptions = [
  { label: '永久有效', value: 'permanent' },
  { label: '72 小时', value: '72h' },
  { label: '指定天数', value: 'days' },
  { label: '指定日期', value: 'custom' },
];
const inviteCountOptions = [1, 5, 10, 20, 50];
const quotaDayOptions = [30, 90, 365];
const CAT_LABELS = { system: '系统', network: '网络', convert: '转换', pull: '拉取', auth: '认证' };
const LEVEL_LABELS = { info: '信息', warn: '警告', error: '错误' };
const LEVEL_FILTER_OPTIONS = [
  { label: '全部级别', value: '' },
  { label: '信息', value: 'info' },
  { label: '警告', value: 'warn' },
  { label: '错误', value: 'error' },
];
const STATUS_LABELS = { unused: '未使用', partial: '使用中', used: '已使用', expired: '已过期', revoked: '已撤销' };
const LOG_CAT_META = {
  system: { label: '系统', color: '#3b82f6' },
  network: { label: '网络', color: '#06b6d4' },
  convert: { label: '转换', color: '#8b5cf6' },
  pull: { label: '拉取', color: '#10b981' },
  auth: { label: '认证', color: '#f59e0b' },
};
const LOG_TAB_DEFS = [
  { id: 'all', label: '全部' },
  { id: 'system', label: '系统' },
  { id: 'network', label: '网络' },
  { id: 'convert', label: '转换' },
  { id: 'pull', label: '拉取' },
  { id: 'auth', label: '认证' },
];

const roleLabel = (role) => ROLE_LABELS[role] || role || '—';
const roleTag = (role) => ROLE_TAG_TYPE[role] || 'default';

function pad2(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 0 / 空 = 不限 */
function quotaNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function quotaText(quota) {
  const q = quota || {};
  const convert = quotaNumber(q.dailyConvert);
  const pull = quotaNumber(q.dailyPull);
  const profiles = quotaNumber(q.maxProfiles);
  return `转换 ${convert ? `${convert}/天` : '不限'} · 拉取 ${pull ? `${pull}/天` : '不限'} · 订阅 ${profiles || '不限'}`;
}

function isExpired(quota) {
  const at = quota && quota.expiresAt;
  return !!at && String(at) < todayStr();
}

/** 距离到期还有多少天（负数 = 已过期） */
function daysLeft(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!m) return null;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** 到期展示：永久 / 已过期 / 7 天内橙色 / 其余常规 */
function expiryInfo(value) {
  const at = value && value.expiresAt !== undefined ? value.expiresAt : value;
  if (!at) return { label: '永久', note: '', cls: '' };
  const date = String(at).slice(0, 10);
  const d = daysLeft(at);
  if (d === null) return { label: date, note: '', cls: '' };
  if (d < 0) return { label: date, note: '已过期', cls: 'danger' };
  if (d === 0) return { label: date, note: '今天到期', cls: 'warn' };
  if (d <= 7) return { label: date, note: `剩 ${d} 天`, cls: 'warn' };
  return { label: date, note: `剩 ${d} 天`, cls: '' };
}

function dateAfter(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 账号配额进度：used = 今日用量，limit = 0 表示不限 */
function usageBar(user, key) {
  const usage = usageOf(user);
  const used = key === 'convert' ? usage.convert : usage.pull;
  const limit = quotaNumber(user && user.quota && user.quota[key === 'convert' ? 'dailyConvert' : 'dailyPull']);
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = !limit ? 'unlimited' : pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  return { used, limit, pct, width: limit ? Math.max(2, pct) : 100, tone };
}

function clientChips(clients) {
  const list = (clients || []).map((id) => ({ id, label: targetLabels.value[id] || id }));
  return { shown: list.slice(0, 4), more: Math.max(0, list.length - 4), total: list.length };
}

function avatarText(u) {
  return String((u && u.username) || '?').slice(0, 1).toUpperCase();
}

function setQuotaExpiry(days) {
  inviteForm.value.quota.expiresAt = days ? dateAfter(days) : null;
}

function inviteStatus(iv) {
  const used = Number(iv.usedCount) || 0;
  const max = Number(iv.maxUses) || 1;
  if (iv.status === 'revoked') return { key: 'revoked', label: STATUS_LABELS.revoked };
  if (iv.status === 'expired') return { key: 'expired', label: STATUS_LABELS.expired };
  if (iv.status === 'used' || used >= max) return { key: 'used', label: STATUS_LABELS.used };
  // 后端未回传 status 时，用 expires_at 兜底判断过期
  if (iv.expiresAt && Date.parse(iv.expiresAt) <= Date.now()) return { key: 'expired', label: STATUS_LABELS.expired };
  if (used > 0) return { key: 'partial', label: STATUS_LABELS.partial };
  return { key: 'unused', label: STATUS_LABELS.unused };
}

function invitePct(iv) {
  const max = Number(iv.maxUses) || 1;
  return Math.min(100, Math.round(((Number(iv.usedCount) || 0) / max) * 100));
}

function logCatMeta(cat) {
  return LOG_CAT_META[cat] || { label: CAT_LABELS[cat] || cat || '其他', color: '#94a3b8' };
}

const targetLabels = computed(() => {
  const map = {};
  for (const t of state.targets || []) map[t.id] = t.label || t.id;
  return map;
});

const clientOptions = computed(() => (state.targets || []).map((t) => ({ label: t.label || t.id, value: t.id })));

/** 客户端 id 必须存在于 state.targets，否则后端会 400 */
function unknownClients(list) {
  const known = targetLabels.value;
  const out = [];
  for (const raw of list || []) {
    const id = String(raw == null ? '' : raw).trim();
    if (id && !known[id] && !out.includes(id)) out.push(id);
  }
  return out;
}

function clientsText(clients) {
  const list = (clients || []).map((id) => targetLabels.value[id] || id);
  if (!list.length) return '全部';
  if (list.length <= 2) return list.join('、');
  return `${list.slice(0, 2).join('、')} +${list.length - 2}`;
}

function usageOf(user) {
  const u = (user && user.usage) || {};
  return { convert: Number(u.convert) || 0, pull: Number(u.pull) || 0 };
}

function usageText(user) {
  const u = usageOf(user);
  return `今日转换 ${u.convert} · 拉取 ${u.pull}`;
}

function quotaSummary(quota) {
  if (!quota) return '';
  const parts = [quotaText(quota)];
  parts.push((quota.clients || []).length ? `客户端 ${quota.clients.length} 个` : '客户端 全部');
  parts.push(quota.expiresAt ? `到期 ${quota.expiresAt}` : '到期 永久');
  return parts.join(' · ');
}

function freshQuota() {
  return { dailyConvert: null, dailyPull: null, maxProfiles: null, clients: [], expiresAt: null };
}

function buildQuota(src) {
  const q = src || {};
  return {
    dailyConvert: quotaNumber(q.dailyConvert),
    dailyPull: quotaNumber(q.dailyPull),
    maxProfiles: quotaNumber(q.maxProfiles),
    clients: [...(q.clients || [])],
    expiresAt: q.expiresAt || null,
  };
}

async function copy(text, { silent = false } = {}) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    if (!silent) message.success('已复制');
    return true;
  } catch {
    message.error('复制失败，请手动选择');
    return false;
  }
}

const copiedCode = ref('');
let copiedTimer = null;

async function copyCode(code) {
  const ok = await copy(code, { silent: true });
  if (!ok) return;
  copiedCode.value = code;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copiedCode.value = ''; }, 1600);
}

/* ── 转换引擎（沿用原有逻辑） ──────────────────────────── */
const engineForm = reactive({ mode: 'internal', base: '', token: '', clearToken: false });
const engineBusy = ref(false);
const busy = ref(false);
const cacheBusy = ref(false);

const engine = computed(() => state.status.engine || {});
const stats = computed(() => state.status.stats || {});
const limits = computed(() => state.status.limits || {});

async function saveEngine() {
  engineBusy.value = true;
  try {
    const body = { mode: engineForm.mode, test: true };
    if (engineForm.mode === 'remote') body.base = engineForm.base;
    if (engineForm.token) body.token = engineForm.token;
    if (engineForm.clearToken) body.clearToken = true;
    const out = await api('/api/settings/engine', { method: 'PUT', body });
    engineForm.token = '';
    engineForm.clearToken = false;
    if (out.probe && !out.probe.ok) message.warning(`已保存，但连接测试失败：${out.probe.error}`);
    else message.success('引擎设置已保存');
    await loadState();
  } catch (e) {
    message.error(e.payload?.error || e.message || '保存失败');
  }
  engineBusy.value = false;
}

function syncEngineForm() {
  const e = (state.settings && state.settings.engine) || {};
  engineForm.mode = e.mode || 'internal';
  engineForm.base = e.base || '';
  engineForm.token = '';
  engineForm.clearToken = false;
}

// 状态可能晚于本组件挂载返回，拿到设置后同步一次表单
watch(() => (state.settings && state.settings.engine) || null, () => syncEngineForm(), { deep: true });

async function checkEngine() {
  busy.value = true;
  try {
    await api('/api/engine/check', { method: 'POST' });
    await loadState();
    message.success('引擎状态已刷新');
  } catch (e) {
    message.error(e.payload?.error || e.message || '检测失败');
  }
  busy.value = false;
}

async function clearCache() {
  if (!window.confirm('确定清空转换缓存？清空后首次转换会重新拉取上游，速度会变慢。')) return;
  cacheBusy.value = true;
  try {
    await api('/api/cache/clear', { method: 'POST' });
    message.success('缓存已清空');
    await loadState();
  } catch (e) {
    message.error(e.payload?.error || e.message || '清空失败');
  }
  cacheBusy.value = false;
}

/* ── 账号与权限 ────────────────────────────────────────── */
const users = ref([]);
const usersLoading = ref(false);
const userOpen = ref(false);
const editingUser = ref(null);
const userSaving = ref(false);
const deletingUserId = ref('');
const userQuery = ref('');
const roleFilter = ref('');
const permissionCatalog = ref([]);
const permissionLabels = ref({});
const roleDefaults = ref({});

const permOptions = computed(() => permissionCatalog.value.map((p) => ({ label: permissionLabels.value[p] || p, value: p })));

const userForm = ref(freshUserForm());

function freshUserForm() {
  return {
    username: '',
    password: '',
    role: 'user',
    useRoleDefaults: true,
    permissions: [],
    quota: freshQuota(),
  };
}

const filteredUsers = computed(() => {
  const needle = userQuery.value.trim().toLowerCase();
  return users.value.filter((u) => {
    if (roleFilter.value && u.role !== roleFilter.value) return false;
    if (needle && !String(u.username || '').toLowerCase().includes(needle)) return false;
    return true;
  });
});

const accountRows = computed(() => filteredUsers.value.map((u) => ({
  ...u,
  _self: isSelf(u),
  _convert: usageBar(u, 'convert'),
  _pull: usageBar(u, 'pull'),
  _profiles: quotaNumber(u.quota && u.quota.maxProfiles),
  _clients: clientChips(u.quota && u.quota.clients),
  _expiry: expiryInfo(u.quota),
})));

const isSelf = (u) => !!(state.auth.user && state.auth.user.id === u.id);

async function fetchUsers() {
  usersLoading.value = true;
  try {
    const data = await api('/api/users');
    users.value = data.users || [];
    permissionCatalog.value = data.permissionCatalog || [];
    permissionLabels.value = data.permissionLabels || {};
    roleDefaults.value = data.roleDefaults || {};
  } catch (e) {
    message.error(e.payload?.error || e.message || '账号列表加载失败');
  } finally {
    usersLoading.value = false;
  }
}

function openCreateUser() {
  editingUser.value = null;
  userForm.value = freshUserForm();
  applyRoleDefaults();
  userOpen.value = true;
}

function openEditUser(u) {
  editingUser.value = u;
  const quota = u.quota || {};
  userForm.value = {
    username: u.username || '',
    password: '',
    role: u.role || 'user',
    useRoleDefaults: !Array.isArray(u.customPermissions),
    permissions: [...(u.customPermissions || roleDefaults.value[u.role] || u.permissions || [])],
    quota: {
      dailyConvert: quotaNumber(quota.dailyConvert) || null,
      dailyPull: quotaNumber(quota.dailyPull) || null,
      maxProfiles: quotaNumber(quota.maxProfiles) || null,
      clients: [...(quota.clients || [])],
      expiresAt: quota.expiresAt || null,
    },
  };
  userOpen.value = true;
}

function applyRoleDefaults() {
  userForm.value.permissions = [...(roleDefaults.value[userForm.value.role] || [])];
}

function onRoleChange(role) {
  if (userForm.value.useRoleDefaults) applyRoleDefaults();
}

function onUseRoleDefaultsChange(checked) {
  if (checked) applyRoleDefaults();
  else if (!userForm.value.permissions.length) applyRoleDefaults();
}

async function saveUser() {
  const username = String(userForm.value.username || '').trim();
  const password = String(userForm.value.password || '');
  if (!username) { message.warning('请填写用户名'); return; }
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) { message.warning('用户名需为 3–32 位字母、数字、下划线、点或短横线'); return; }
  if (!editingUser.value && !password) { message.warning('请填写初始密码'); return; }
  if (password && password.length < 4) { message.warning('密码至少 4 位'); return; }
  if (!userForm.value.role) { message.warning('请选择角色'); return; }
  const unknown = unknownClients(userForm.value.quota.clients);
  if (unknown.length) {
    message.warning(`未知客户端：${unknown.join('、')}（留空表示全部客户端）`);
    return;
  }

  const self = !!editingUser.value && isSelf(editingUser.value);
  const body = {
    username,
    role: userForm.value.role,
    permissions: userForm.value.useRoleDefaults ? null : [...userForm.value.permissions],
    quota: buildQuota(userForm.value.quota),
  };
  if (password) body.password = password;

  userSaving.value = true;
  try {
    if (editingUser.value) {
      await api(`/api/users/${encodeURIComponent(editingUser.value.id)}`, { method: 'PUT', body });
      message.success('账号已更新');
    } else {
      await api('/api/users', { method: 'POST', body });
      message.success('账号已创建');
    }
    userOpen.value = false;
    await fetchUsers();
    if (self) await loadState();
  } catch (e) {
    message.error(e.payload?.error || e.message || '保存失败');
  } finally {
    userSaving.value = false;
  }
}

async function removeUser(u) {
  if (!window.confirm(`确定删除账号「${u.username}」？该账号的登录会话会立即失效，操作不可撤销。`)) return;
  deletingUserId.value = u.id;
  try {
    await api(`/api/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' });
    message.success('账号已删除');
    await fetchUsers();
  } catch (e) {
    message.error(e.payload?.error || e.message || '删除失败');
  } finally {
    deletingUserId.value = '';
  }
}

/* ── 注册码 / 兑换码 ───────────────────────────────────── */
const invites = ref([]);
const invitesLoading = ref(false);
const inviteOpen = ref(false);
const inviteSaving = ref(false);
const deletingCode = ref('');
const inviteKindFilter = ref('');
const inviteQuery = ref('');
const inviteStatusFilter = ref('all');
const inviteSelected = ref([]);
const inviteBatchDeleting = ref(false);
const inviteForm = ref(freshInviteForm());

function freshInviteForm() {
  return {
    kind: 'register',
    role: 'user',
    count: 1,
    maxUses: 1,
    expiryMode: '72h',
    ttlDays: 7,
    expiresAt: null,
    note: '',
    withQuota: false,
    quota: freshQuota(),
  };
}

const INVITE_STATUS_TABS = [
  { id: 'all', label: '全部' },
  { id: 'unused', label: '未使用' },
  { id: 'partial', label: '使用中' },
  { id: 'used', label: '已使用' },
  { id: 'expired', label: '过期' },
];

/**
 * 分类口径与后端 invites.status 保持一致：用尽 > 过期 > 使用中 > 未使用。
 * 这样列表状态胶囊与分类计数不会互相矛盾（后端 status 只在未用尽时才判 expired）。
 */
function inviteBucket(iv) {
  const used = Number(iv.usedCount) || 0;
  const max = Number(iv.maxUses) || 1;
  if (used >= max) return 'used';
  if (iv.expiresAt && Date.parse(iv.expiresAt) <= Date.now()) return 'expired';
  if (used > 0) return 'partial';
  return 'unused';
}

/** 类型筛选 + 关键词搜索（code / note） */
const inviteScoped = computed(() => {
  const kind = inviteKindFilter.value;
  const needle = inviteQuery.value.trim().toLowerCase();
  return (invites.value || []).filter((iv) => {
    if (kind && (iv.kind || 'register') !== kind) return false;
    if (needle) {
      const code = String(iv.code || '').toLowerCase();
      const note = String(iv.note || '').toLowerCase();
      if (!code.includes(needle) && !note.includes(needle)) return false;
    }
    return true;
  });
});

/** 分类 tab 计数：基于当前类型 + 搜索条件下的已加载列表 */
const inviteStatusTabs = computed(() => {
  const counts = { all: 0, unused: 0, partial: 0, used: 0, expired: 0 };
  for (const iv of inviteScoped.value) {
    counts.all += 1;
    const key = inviteBucket(iv);
    counts[key] = (counts[key] || 0) + 1;
  }
  return INVITE_STATUS_TABS.map((t) => ({ ...t, count: counts[t.id] || 0 }));
});

const filteredInvites = computed(() => {
  if (inviteStatusFilter.value === 'all') return inviteScoped.value;
  return inviteScoped.value.filter((iv) => inviteBucket(iv) === inviteStatusFilter.value);
});

const inviteSelectedSet = computed(() => new Set(inviteSelected.value));
const inviteVisibleCodes = computed(() => filteredInvites.value.map((iv) => iv.code));
const inviteAllSelected = computed(() => inviteVisibleCodes.value.length > 0
  && inviteVisibleCodes.value.every((code) => inviteSelectedSet.value.has(code)));
const inviteSomeSelected = computed(() => inviteVisibleCodes.value.some((code) => inviteSelectedSet.value.has(code)));

const inviteRows = computed(() => filteredInvites.value.map((iv) => ({
  ...iv,
  _kind: iv.kind || 'register',
  _status: inviteStatus(iv),
  _pct: invitePct(iv),
  _expiry: expiryInfo({ expiresAt: iv.expiresAt }),
  _grant: iv.kind === 'redeem' && iv.quota ? quotaSummary(iv.quota) : '',
  _log: Array.isArray(iv.usedLog) ? iv.usedLog : [],
})));

/* ── 批量选择 ── */
function toggleInviteSelect(code, on) {
  const set = new Set(inviteSelected.value);
  if (on) set.add(code); else set.delete(code);
  inviteSelected.value = [...set];
}

/** 表头全选：只作用于当前分类（含类型 / 关键词筛选）的可见行 */
function toggleInviteSelectAll(on) {
  const set = new Set(inviteSelected.value);
  for (const code of inviteVisibleCodes.value) {
    if (on) set.add(code); else set.delete(code);
  }
  inviteSelected.value = [...set];
}

function clearInviteSelection() {
  inviteSelected.value = [];
}

/** 只保留当前可见行，切分类/改搜索后不会误删看不见的码 */
function pruneInviteSelection() {
  const alive = new Set(inviteVisibleCodes.value);
  const next = inviteSelected.value.filter((code) => alive.has(code));
  if (next.length !== inviteSelected.value.length) inviteSelected.value = next;
}

watch([inviteKindFilter, inviteStatusFilter, inviteQuery, invites], pruneInviteSelection);

function selectedInviteRows() {
  return inviteRows.value.filter((iv) => inviteSelectedSet.value.has(iv.code));
}

async function copySelectedInvites() {
  const codes = selectedInviteRows().map((iv) => iv.code);
  if (!codes.length) return;
  const ok = await copy(codes.join('\n'), { silent: true });
  if (!ok) return;
  message.success(`已复制 ${codes.length} 个注册码`);
}

async function removeSelectedInvites() {
  const rows = selectedInviteRows();
  if (!rows.length) return;
  if (!window.confirm(`确定删除选中的 ${rows.length} 个注册码？已发出的码将立即失效。`)) return;
  inviteBatchDeleting.value = true;
  let ok = 0;
  let fail = 0;
  for (const iv of rows) {
    try {
      await api(`/api/invites/${encodeURIComponent(iv.code)}`, { method: 'DELETE' });
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  inviteBatchDeleting.value = false;
  inviteSelected.value = [];
  if (!fail) message.success(`已删除 ${ok} 个注册码`);
  else if (!ok) message.error(`${fail} 个注册码删除失败`);
  else message.warning(`删除完成：成功 ${ok} 个，失败 ${fail} 个`);
  await fetchInvites();
}

function setInviteKind(kind) {
  inviteForm.value.kind = kind;
  if (kind === 'redeem') inviteForm.value.withQuota = true;
}

function setInviteCount(n) {
  inviteForm.value.count = n;
}

async function fetchInvites() {
  invitesLoading.value = true;
  try {
    const data = await api('/api/invites');
    invites.value = data.invites || [];
  } catch (e) {
    message.error(e.payload?.error || e.message || '注册码加载失败');
  } finally {
    invitesLoading.value = false;
  }
}

function openCreateInvite() {
  inviteForm.value = freshInviteForm();
  inviteOpen.value = true;
}

async function createInvite() {
  const form = inviteForm.value;
  const body = {
    kind: form.kind,
    role: form.role,
    count: Math.min(50, Math.max(1, Math.trunc(Number(form.count) || 1))),
    maxUses: Math.min(1000, Math.max(1, Math.trunc(Number(form.maxUses) || 1))),
    note: String(form.note || '').trim(),
  };
  if (form.expiryMode === 'permanent') body.expiresAt = null;
  else if (form.expiryMode === 'days') {
    const days = Math.min(365, Math.max(1, Math.trunc(Number(form.ttlDays) || 0)));
    // 后端 ttlHours 上限 720h（30 天），长有效期改用精确到期时间
    body.expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  } else if (form.expiryMode === 'custom') {
    if (!form.expiresAt) { message.warning('请选择到期日期，或改为永久有效'); return; }
    body.expiresAt = form.expiresAt;
  }
  if (form.kind === 'redeem' || form.withQuota) {
    const unknown = unknownClients(form.quota.clients);
    if (unknown.length) { message.warning(`未知客户端：${unknown.join('、')}`); return; }
    body.quota = buildQuota(form.quota);
  }

  inviteSaving.value = true;
  try {
    const out = await api('/api/invites', { method: 'POST', body });
    const list = out.invites || (out.invite ? [out.invite] : []);
    message.success(`已生成 ${list.length} 个${form.kind === 'redeem' ? '兑换码' : '注册码'}`);
    inviteOpen.value = false;
    await fetchInvites();
  } catch (e) {
    message.error(e.payload?.error || e.message || '生成失败');
  } finally {
    inviteSaving.value = false;
  }
}

async function removeInvite(iv) {
  const label = (iv.kind || 'register') === 'redeem' ? '兑换码' : '注册码';
  if (!window.confirm(`确定删除${label}「${iv.code}」？已发出的码将立即失效。`)) return;
  deletingCode.value = iv.code;
  try {
    await api(`/api/invites/${encodeURIComponent(iv.code)}`, { method: 'DELETE' });
    message.success('已删除');
    await fetchInvites();
  } catch (e) {
    message.error(e.payload?.error || e.message || '删除失败');
  } finally {
    deletingCode.value = '';
  }
}

/* ── 运行日志 ──────────────────────────────────────────── */
const logItems = ref([]);
const logCats = ref([]);
const logScope = ref('all');
const logCat = ref('all');
const logQuery = ref('');
const logUser = ref('');
const logLevel = ref('');
const logUpdatedAt = ref('');
const logsBusy = ref(false);
const autoLogs = ref(true);
let logTimer = null;
let logSeq = 0;
let logDebounce = null;

const logTabs = computed(() => {
  const counts = {};
  for (const c of logCats.value || []) counts[c.id] = Number(c.count) || 0;
  const total = (logCats.value || []).reduce((n, c) => n + (Number(c.count) || 0), 0);
  return LOG_TAB_DEFS.map((t) => ({
    ...t,
    color: t.id === 'all' ? '' : (LOG_CAT_META[t.id] || {}).color || '#94a3b8',
    count: t.id === 'all' ? total : (counts[t.id] || 0),
  }));
});

const filteredLogs = computed(() => {
  const needle = logUser.value.trim().toLowerCase();
  return (logItems.value || []).filter((l) => {
    if (logLevel.value && l.level !== logLevel.value) return false;
    if (logScope.value !== 'self' && needle && !String(l.user || '').toLowerCase().includes(needle)) return false;
    return true;
  });
});

const logFiltered = computed(() => !!(logQuery.value.trim() || logUser.value.trim() || logLevel.value));

function clearLogFilters() {
  logQuery.value = '';
  logUser.value = '';
  logLevel.value = '';
}

// scope=self 时用户/级别筛选是隐藏的，避免残留条件静默过滤掉日志
watch(logScope, (scope) => {
  if (scope === 'self') {
    logUser.value = '';
    logLevel.value = '';
  }
});

function logCatLabel(id) {
  const hit = (logCats.value || []).find((c) => c.id === id);
  return CAT_LABELS[id] || (hit && hit.label) || id;
}

async function fetchLogs({ silent = false } = {}) {
  const seq = ++logSeq;
  if (!silent) logsBusy.value = true;
  try {
    const params = new URLSearchParams({ cat: logCat.value || 'all', limit: '200' });
    const q = logQuery.value.trim();
    if (q) params.set('q', q);
    const data = await api(`/api/logs?${params.toString()}`);
    if (seq !== logSeq) return;
    logItems.value = data.items || [];
    logCats.value = data.cats || [];
    logScope.value = data.scope || 'all';
    logUpdatedAt.value = new Date().toISOString();
  } catch (e) {
    if (!silent) message.error(e.payload?.error || e.message || '日志加载失败');
  } finally {
    if (seq === logSeq) logsBusy.value = false;
  }
}

function pickLogCat(id) {
  if (logCat.value === id) return;
  logCat.value = id;
  fetchLogs();
}

function stopLogTimer() {
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
}

function startLogTimer() {
  stopLogTimer();
  logTimer = setInterval(() => fetchLogs({ silent: true }), 10000);
}

watch(autoLogs, (on) => {
  if (on) { startLogTimer(); fetchLogs({ silent: true }); } else stopLogTimer();
});

watch(logQuery, () => {
  if (logDebounce) clearTimeout(logDebounce);
  logDebounce = setTimeout(() => fetchLogs(), 300);
});

/* ── 概览统计 ──────────────────────────────────────────── */
const statCards = computed(() => {
  const today = todayStr();
  const todayLogs = (logItems.value || []).filter((l) => String(l.at || '').slice(0, 10) === today).length;
  let activeInvites = 0;
  let totalUses = 0;
  for (const iv of invites.value || []) {
    const st = inviteStatus(iv);
    if (st.key === 'unused' || st.key === 'partial') activeInvites += 1;
    totalUses += Number(iv.usedCount) || 0;
  }
  let limitedUsers = 0;
  for (const u of users.value || []) {
    const q = u.quota || {};
    if (quotaNumber(q.dailyConvert) || quotaNumber(q.dailyPull) || quotaNumber(q.maxProfiles)
      || (q.clients || []).length || q.expiresAt) limitedUsers += 1;
  }
  return {
    todayLogs,
    activeInvites,
    totalUses,
    limitedUsers,
    loadedLogs: (logItems.value || []).length,
  };
});

/* ── 初始化 ────────────────────────────────────────────── */
let adminLoaded = false;

async function loadAdminData() {
  if (!can('users:manage')) return;
  adminLoaded = true;
  await Promise.all([fetchUsers(), fetchInvites()]);
}

watch(() => can('users:manage'), (allowed) => {
  if (allowed) { if (!adminLoaded) loadAdminData(); }
  else adminLoaded = false;
});

watch(() => (state.auth.user && state.auth.user.id) || '', () => {
  fetchLogs({ silent: true });
});

onMounted(() => {
  syncEngineForm();
  fetchLogs();
  loadAdminData();
  if (autoLogs.value) startLogTimer();
});

onBeforeUnmount(() => {
  stopLogTimer();
  if (logDebounce) clearTimeout(logDebounce);
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>
<template>
  <div class="page sys-page">
    <div class="page-head sys-head">
      <div>
        <h1 class="page-title">系统</h1>
        <p class="page-desc">引擎状态、账号与配额、注册码与运行日志（含认证事件）。</p>
      </div>
      <div class="head-pills">
        <span class="pill" :class="engine.ok ? 'ok' : engine.error ? 'bad' : 'wait'">
          <i />{{ engine.ok ? '引擎在线' : engine.error ? '引擎异常' : '检测中' }}
        </span>
      </div>
    </div>

    <n-alert v-if="state.auth.defaultPassword" type="warning" :bordered="false" class="pw-alert">
      检测到默认密码 admin/admin，请点右上角头像修改密码。
    </n-alert>

    <div class="stat-grid">
      <n-card v-if="can('users:manage')" size="small" class="stat-card">
        <div class="stat-body">
          <span class="stat-ico indigo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          <div class="stat-main">
            <b>{{ users.length }}</b>
            <span>账号总数<template v-if="statCards.limitedUsers"> · 受限 {{ statCards.limitedUsers }}</template></span>
          </div>
        </div>
      </n-card>

      <n-card v-if="can('users:manage')" size="small" class="stat-card">
        <div class="stat-body">
          <span class="stat-ico amber">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
              <circle cx="7.5" cy="7.5" r="1.3" />
            </svg>
          </span>
          <div class="stat-main">
            <b>{{ invites.length }}</b>
            <span>注册码 / 兑换码 · 可用 {{ statCards.activeInvites }} · 已用 {{ statCards.totalUses }} 次</span>
          </div>
        </div>
      </n-card>

      <n-card size="small" class="stat-card">
        <div class="stat-body">
          <span class="stat-ico green">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </span>
          <div class="stat-main">
            <b>{{ statCards.todayLogs }}</b>
            <span :title="`按已加载的 ${statCards.loadedLogs} 条统计`">今日日志 · 载入 {{ statCards.loadedLogs }} 条<template v-if="logScope === 'self'"> · 仅自己</template></span>
          </div>
        </div>
      </n-card>
    </div>

    <div class="engine-grid">
      <n-card size="small">
        <template #header>
          <div class="sec-head">
            <span class="sec-ico blue">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </span>
            <div>
              <b>转换引擎</b>
              <span class="sec-sub">subconverter 连接方式与缓存</span>
            </div>
          </div>
        </template>
        <template #header-extra>
          <span class="status-pill" :class="engine.ok ? 'ok' : engine.error ? 'bad' : 'wait'">
            <i />{{ engine.ok ? '在线' : engine.error ? '异常' : '检测中' }}
          </span>
        </template>

        <div class="engine-body">
          <div class="engine-meta">
            <span class="mono hint">{{ engine.version || '—' }}</span>
            <span class="soft-tag">{{ engineForm.mode === 'remote' ? '远程后端' : '内置引擎' }}</span>
          </div>
          <n-select v-model:value="engineForm.mode" :options="engineModeOptions" />
          <template v-if="engineForm.mode === 'remote'">
            <n-input v-model:value="engineForm.base" placeholder="远程地址，例如 https://sub.example.com" />
            <n-input v-model:value="engineForm.token" type="password" show-password-on="click" placeholder="访问令牌（可选，留空保持原值）" />
            <n-checkbox v-model:checked="engineForm.clearToken">清空已保存的访问令牌</n-checkbox>
          </template>
          <div class="row engine-actions">
            <n-button size="tiny" type="primary" :loading="engineBusy" :disabled="!can('engine:write')" @click="saveEngine">保存并测试</n-button>
            <n-button size="tiny" :loading="busy" @click="checkEngine">检测状态</n-button>
            <n-button size="tiny" quaternary :loading="cacheBusy" @click="clearCache">清空缓存</n-button>
          </div>
          <div class="kv-list">
            <div class="kv">
              <span>当前地址</span>
              <b class="mono">{{ ((state.settings || {}).engine || {}).base || engine.base || 'http://subconverter:25500' }}</b>
            </div>
            <div class="kv">
              <span>缓存</span>
              <b>{{ (stats.cache || {}).entries || 0 }} 条 · 命中率 {{ ((stats.cache || {}).hitRate || 0) }}%</b>
            </div>
          </div>
        </div>
      </n-card>

      <n-card size="small">
        <template #header>
          <div class="sec-head">
            <span class="sec-ico green">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="3" width="20" height="8" rx="2" />
                <rect x="2" y="13" width="20" height="8" rx="2" />
                <line x1="6" y1="7" x2="6.01" y2="7" />
                <line x1="6" y1="17" x2="6.01" y2="17" />
              </svg>
            </span>
            <div>
              <b>服务状态</b>
              <span class="sec-sub">地址、资源与限流</span>
            </div>
          </div>
        </template>
        <div class="kv-list service-kv">
          <div class="kv">
            <span>公开地址</span>
            <b class="mono">{{ state.status.publicBase }}</b>
          </div>
          <div class="kv">
            <span>本地资源</span>
            <b>模板 {{ state.templates.length }} · 规则集 {{ state.library.rulesets.length }} · 基础 {{ state.library.bases.length }} · DNS {{ state.library.dns.length }}</b>
          </div>
          <div class="kv">
            <span>官方目录</span>
            <b>{{ state.catalog.count }} 条</b>
          </div>
          <div class="kv">
            <span>限流</span>
            <b>转换 {{ limits.convertPerMinute }}/分 · 订阅 {{ limits.subscribePerMinute }}/分</b>
          </div>
        </div>
      </n-card>
    </div>

    <n-card v-if="can('users:manage')" size="small" class="section-card">
      <template #header>
        <div class="sec-head">
          <span class="sec-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          <div>
            <b>账号与权限</b>
            <span class="sec-sub">成员、角色、每日配额、可用客户端与到期时间</span>
          </div>
        </div>
      </template>
      <template #header-extra>
        <div class="card-tools">
          <span class="count-pill">{{ filteredUsers.length }} / {{ users.length }}</span>
          <n-button size="tiny" quaternary :loading="usersLoading" @click="fetchUsers">刷新</n-button>
        </div>
      </template>

      <div class="toolbar">
        <n-button size="small" type="primary" @click="openCreateUser">＋ 新建账号</n-button>
        <n-input v-model:value="userQuery" size="small" clearable placeholder="搜索账号" class="w200" />
        <n-select v-model:value="roleFilter" size="small" :options="roleFilterOptions" class="w140" />
        <span class="toolbar-hint">配额 0 = 不限；客户端不选 = 全部允许</span>
      </div>

      <div v-if="accountRows.length" class="user-list">
        <div v-for="u in accountRows" :key="u.id" class="user-row">
          <div class="user-id">
            <span class="avatar" :class="'role-' + u.role">{{ avatarText(u) }}</span>
            <div class="user-id-main">
              <div class="user-name">
                <b>{{ u.username }}</b>
                <span class="role-tag" :class="'role-' + u.role">{{ roleLabel(u.role) }}</span>
                <span v-if="u._self" class="mark self">自己</span>
                <span v-else-if="u.customPermissions" class="mark info">自定义权限</span>
              </div>
              <div class="user-sub">最近登录 {{ u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : '从未登录' }}</div>
            </div>
          </div>

          <div class="quota-cell">
            <div class="qline">
              <div class="qtop">
                <span>每日转换</span>
                <b>{{ u._convert.used }}<em>/ {{ u._convert.limit || '不限' }}</em></b>
              </div>
              <div class="qbar" :class="u._convert.tone"><i :style="{ width: u._convert.width + '%' }" /></div>
            </div>
            <div class="qline">
              <div class="qtop">
                <span>每日拉取</span>
                <b>{{ u._pull.used }}<em>/ {{ u._pull.limit || '不限' }}</em></b>
              </div>
              <div class="qbar" :class="u._pull.tone"><i :style="{ width: u._pull.width + '%' }" /></div>
            </div>
            <div class="qfoot">订阅上限 <b>{{ u._profiles || '不限' }}</b></div>
          </div>

          <div class="clients-cell">
            <template v-if="u._clients.total">
              <span v-for="c in u._clients.shown" :key="c.id" class="client-chip">{{ c.label }}</span>
              <span v-if="u._clients.more" class="client-chip more">+{{ u._clients.more }}</span>
            </template>
            <span v-else class="client-chip all">全部客户端</span>
          </div>

          <div class="expiry-cell" :class="u._expiry.cls">
            <b>{{ u._expiry.label }}</b>
            <span v-if="u._expiry.note">{{ u._expiry.note }}</span>
          </div>

          <div class="row-actions">
            <n-button size="tiny" secondary @click="openEditUser(u)">编辑</n-button>
            <n-button
              size="tiny" quaternary type="error"
              :disabled="u._self" :loading="deletingUserId === u.id"
              @click="removeUser(u)"
            >删除</n-button>
          </div>
        </div>
      </div>
      <div v-else class="empty">
        <span class="empty-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </span>
        <b>{{ users.length ? '没有匹配的账号' : '还没有账号' }}</b>
        <p>{{ users.length ? '换个关键词或角色筛选再试试。' : '新建账号后即可分配角色、每日配额与可用客户端。' }}</p>
        <n-button v-if="!users.length" size="small" type="primary" @click="openCreateUser">＋ 新建账号</n-button>
      </div>

      <div class="hint foot-hint">
        当前登录：{{ (state.auth.user && state.auth.user.username) || '—' }}（{{ roleLabel(state.auth.user && state.auth.user.role) }}）。账号数据保存在网关 CONFIG_DIR 下的 subhub.db（SQLite），备份该目录即可迁移。
      </div>
    </n-card>

    <n-card v-if="can('users:manage')" size="small" class="section-card">
      <template #header>
        <div class="sec-head">
          <span class="sec-ico amber">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
              <circle cx="7.5" cy="7.5" r="1.3" />
            </svg>
          </span>
          <div>
            <b>注册码管理</b>
            <span class="sec-sub">注册码开新账号，兑换码给已有账号加配额</span>
          </div>
        </div>
      </template>
      <template #header-extra>
        <div class="card-tools">
          <span class="count-pill" :title="`当前筛选 / 已加载 ${invites.length} 个`">{{ filteredInvites.length }} / {{ invites.length }}</span>
          <n-button size="tiny" quaternary :loading="invitesLoading" @click="fetchInvites">刷新</n-button>
        </div>
      </template>

      <div class="toolbar">
        <n-button size="small" type="primary" @click="openCreateInvite">＋ 生成注册码</n-button>
        <n-select v-model:value="inviteKindFilter" size="small" :options="kindFilterOptions" class="w150" />
        <n-input
          v-model:value="inviteQuery" size="small" clearable
          placeholder="搜索注册码 / 备注" class="w200"
        />
        <span class="toolbar-hint">可限制使用次数、有效期与附带配额</span>
      </div>

      <div class="iv-tabs" :title="`按当前类型与搜索条件统计，共 ${invites.length} 个已加载`">
        <button
          v-for="t in inviteStatusTabs" :key="t.id" type="button"
          :class="['iv-tab', { active: inviteStatusFilter === t.id }]"
          @click="inviteStatusFilter = t.id"
        >
          {{ t.label }}<span class="iv-count">{{ t.count }}</span>
        </button>
      </div>

      <div v-if="inviteSelected.length" class="iv-batch-bar">
        <span class="iv-batch-note">已选 <b>{{ inviteSelected.length }}</b> 个</span>
        <div class="iv-batch-actions">
          <n-button size="tiny" secondary @click="copySelectedInvites">批量复制</n-button>
          <n-button size="tiny" secondary type="error" :loading="inviteBatchDeleting" @click="removeSelectedInvites">批量删除</n-button>
          <n-button size="tiny" quaternary @click="clearInviteSelection">取消选择</n-button>
        </div>
      </div>

      <div v-if="inviteRows.length" class="iv-wrap">
        <div class="iv-head">
          <div class="iv-check">
            <n-checkbox
              :checked="inviteAllSelected"
              :indeterminate="inviteSomeSelected && !inviteAllSelected"
              :disabled="!inviteRows.length"
              @update:checked="toggleInviteSelectAll"
            />
          </div>
          <div>注册码</div>
          <div>类型</div>
          <div>状态</div>
          <div>已用次数</div>
          <div>到期</div>
          <div>备注 / 授予配额</div>
          <div class="ta-r">操作</div>
        </div>
        <div
          v-for="iv in inviteRows" :key="iv.code"
          class="iv-row" :class="{ sel: inviteSelectedSet.has(iv.code) }"
        >
          <div class="iv-check">
            <n-checkbox
              :checked="inviteSelectedSet.has(iv.code)"
              @update:checked="(on) => toggleInviteSelect(iv.code, on)"
            />
          </div>
          <div class="iv-code">
            <span class="code mono" :title="iv.code">{{ iv.code }}</span>
            <button
              type="button" class="copy-btn"
              :class="{ done: copiedCode === iv.code }"
              @click="copyCode(iv.code)"
            >{{ copiedCode === iv.code ? '已复制' : '复制' }}</button>
            <n-popover trigger="click" placement="bottom-start" :width="250">
              <template #trigger>
                <button type="button" class="copy-btn log-btn" :class="{ done: iv._log.length }">
                  记录 {{ iv._log.length }}
                </button>
              </template>
              <div class="ulog">
                <div v-if="!iv._log.length" class="ulog-empty">还没有人使用这个码</div>
                <div v-for="(rec, idx) in iv._log" :key="idx" class="ulog-row">
                  <b>{{ rec.user || '—' }}</b>
                  <span class="mono">{{ fmtDateTime(rec.at) }}</span>
                </div>
              </div>
            </n-popover>
          </div>
          <div>
            <span class="type-tag" :class="iv._kind">{{ iv._kind === 'redeem' ? '兑换码' : '注册码' }}</span>
          </div>
          <div>
            <span class="status-tag" :class="iv._status.key">{{ iv._status.label }}</span>
          </div>
          <div class="used-cell">
            <div class="used-top"><b>{{ iv.usedCount || 0 }}</b><span>/ {{ iv.maxUses || 1 }}</span></div>
            <div class="mini-bar"><i :style="{ width: iv._pct + '%' }" /></div>
          </div>
          <div class="iv-expiry" :class="iv._expiry.cls">
            <b>{{ iv._expiry.label }}</b>
            <span v-if="iv._expiry.note">{{ iv._expiry.note }}</span>
          </div>
          <div class="iv-note">
            <span class="txt" :title="iv.note || ''">{{ iv.note || '无备注' }}</span>
            <span v-if="iv._grant" class="grant" :title="iv._grant">{{ iv._grant }}</span>
          </div>
          <div class="row-actions">
            <n-button
              size="tiny" quaternary type="error"
              :loading="deletingCode === iv.code"
              @click="removeInvite(iv)"
            >删除</n-button>
          </div>
        </div>
      </div>
      <div v-else class="empty">
        <span class="empty-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
            <circle cx="7.5" cy="7.5" r="1.3" />
          </svg>
        </span>
        <b>{{ invites.length ? '没有匹配的注册码' : '还没有注册码' }}</b>
        <p>{{ invites.length ? '换个类型 / 状态分类，或清空搜索关键词再试试。' : '生成注册码发给朋友注册，或生成兑换码给已有账号增加配额。' }}</p>
        <n-button v-if="!invites.length" size="small" type="primary" @click="openCreateInvite">＋ 生成注册码</n-button>
      </div>
    </n-card>

    <n-card size="small" class="section-card">
      <template #header>
        <div class="sec-head">
          <span class="sec-ico slate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </span>
          <div>
            <b>运行日志 <span class="count-inline">{{ filteredLogs.length }}</span></b>
            <span class="sec-sub">
              <template v-if="logScope === 'self'">普通用户只能看到自己的操作日志</template>
              <template v-else>系统、网络、转换、拉取与认证事件</template>
            </span>
          </div>
          <span v-if="logScope === 'self'" class="self-tag" title="后端按当前账号限定日志范围">仅自己</span>
        </div>
      </template>
      <template #header-extra>
        <div class="card-tools">
          <span v-if="logUpdatedAt" class="hint updated">更新于 {{ fmtTime(logUpdatedAt) }}</span>
          <n-button size="tiny" quaternary :loading="logsBusy" @click="fetchLogs()">刷新</n-button>
          <span class="hint">自动刷新</span>
          <n-switch v-model:value="autoLogs" size="small" />
        </div>
      </template>

      <div class="log-toolbar">
        <span
          class="scope-chip" :class="logScope === 'self' ? 'self' : 'all'"
          :title="logScope === 'self' ? '后端已按当前账号限定日志范围，不可切换' : '当前账号可查看所有用户的日志'"
        >{{ logScope === 'self' ? '范围：仅看我' : '范围：全部' }}</span>
        <n-input v-model:value="logQuery" size="small" clearable placeholder="搜索日志内容" class="w220" />
        <n-input v-if="logScope !== 'self'" v-model:value="logUser" size="small" clearable placeholder="按用户筛选" class="w160" />
        <n-select v-if="logScope !== 'self'" v-model:value="logLevel" size="small" :options="LEVEL_FILTER_OPTIONS" class="w130" />
        <span class="hint">{{ logScope === 'self' ? '已隐藏用户 / 级别筛选' : '可按用户与级别组合筛选' }}</span>
      </div>

      <div class="log-tabs">
        <button
          v-for="t in logTabs" :key="t.id" type="button"
          :class="['log-tab', { active: logCat === t.id }]"
          @click="pickLogCat(t.id)"
        >
          <span v-if="t.color" class="cat-dot" :style="{ background: t.color }" />
          {{ t.label }}<span class="log-count">{{ t.count }}</span>
        </button>
      </div>

      <div v-if="filteredLogs.length" class="log-list" :class="{ self: logScope === 'self' }">
        <div v-for="l in filteredLogs" :key="l.id" class="log-row">
          <span class="log-time mono">{{ fmtTime(l.at) }}</span>
          <span class="log-cat">
            <i :style="{ background: logCatMeta(l.cat).color }" />{{ logCatMeta(l.cat).label }}
          </span>
          <span class="lv-dot" :class="l.level" :title="LEVEL_LABELS[l.level] || l.level" />
          <span class="log-msg" :title="l.msg">{{ l.msg }}</span>
          <span v-if="logScope !== 'self'" class="log-who" :title="l.user || ''">{{ l.user || '—' }}</span>
          <span class="log-ip mono" :title="l.ip || ''">{{ l.ip || '' }}</span>
        </div>
      </div>
      <div v-else class="empty compact">
        <b>没有日志</b>
        <p>{{ logFiltered ? '当前筛选条件下没有日志，试试清除筛选。' : '有转换、拉取或系统事件后会在这里显示。' }}</p>
        <n-button v-if="logFiltered" size="small" @click="clearLogFilters">清除筛选</n-button>
      </div>
    </n-card>

    <!-- 新建 / 编辑账号 -->
    <n-modal
      v-model:show="userOpen" preset="card"
      :title="editingUser ? `编辑账号：${editingUser.username}` : '新建账号'"
      style="width: 780px; max-width: 94vw"
    >
      <div class="modal-scroll">
        <n-form label-placement="top" :show-feedback="false">
          <div class="form-cols">
            <n-form-item label="用户名">
              <n-input v-model:value="userForm.username" placeholder="3–32 位字母、数字、下划线、点或短横线" />
            </n-form-item>
            <n-form-item :label="editingUser ? '密码（留空不修改）' : '初始密码'">
              <n-input v-model:value="userForm.password" type="password" show-password-on="click" placeholder="至少 4 位" />
            </n-form-item>
          </div>

          <n-form-item label="角色">
            <n-select v-model:value="userForm.role" :options="roleOptions" @update:value="onRoleChange" />
          </n-form-item>

          <div class="form-block">
            <div class="block-head">
              <b>配额</b>
              <span>0 = 不限；每日用量按自然日重置</span>
            </div>
            <div class="quota-grid">
              <div class="field">
                <div class="field-label">每日转换</div>
                <n-input-number v-model:value="userForm.quota.dailyConvert" :min="0" :precision="0" placeholder="0" style="width: 100%" />
                <div class="field-hint">0 = 不限</div>
              </div>
              <div class="field">
                <div class="field-label">每日拉取</div>
                <n-input-number v-model:value="userForm.quota.dailyPull" :min="0" :precision="0" placeholder="0" style="width: 100%" />
                <div class="field-hint">0 = 不限</div>
              </div>
              <div class="field">
                <div class="field-label">订阅上限</div>
                <n-input-number v-model:value="userForm.quota.maxProfiles" :min="0" :precision="0" placeholder="0" style="width: 100%" />
                <div class="field-hint">0 = 不限</div>
              </div>
              <div class="field">
                <div class="field-label">账号到期</div>
                <n-date-picker
                  v-model:formatted-value="userForm.quota.expiresAt"
                  type="date" value-format="yyyy-MM-dd" clearable
                  placeholder="永久" style="width: 100%"
                />
                <div class="field-hint">留空 = 永久</div>
              </div>
            </div>
          </div>

          <div class="form-block">
            <div class="block-head">
              <b>允许的客户端</b>
              <span>不选表示全部客户端；选择后仅这些客户端可拉取</span>
            </div>
            <n-select
              v-model:value="userForm.quota.clients"
              multiple filterable tag
              :options="clientOptions"
              :max-tag-count="3"
              placeholder="不选表示全部客户端，可搜索或输入客户端 id"
            />
            <div class="field-hint picker-note">
              已选 {{ userForm.quota.clients.length }} 个{{ userForm.quota.clients.length ? '' : '（全部客户端）' }}
            </div>
          </div>

          <div class="form-block">
            <div class="block-head">
              <b>权限</b>
              <span>默认跟随角色，也可单独勾选</span>
            </div>
            <div class="stack" style="gap: 8px">
              <n-checkbox :checked="userForm.useRoleDefaults" @update:checked="onUseRoleDefaultsChange">
                使用角色默认权限
              </n-checkbox>
              <n-select
                v-model:value="userForm.permissions"
                multiple filterable
                :disabled="userForm.useRoleDefaults"
                :options="permOptions"
                :max-tag-count="4"
                placeholder="选择权限"
              />
            </div>
          </div>
        </n-form>
      </div>
      <template #footer>
        <div class="modal-foot">
          <span class="hint">保存后立即生效</span>
          <div class="row">
            <n-button @click="userOpen = false">取消</n-button>
            <n-button type="primary" :loading="userSaving" @click="saveUser">保存</n-button>
          </div>
        </div>
      </template>
    </n-modal>

    <!-- 生成注册码 / 兑换码 -->
    <n-modal
      v-model:show="inviteOpen" preset="card"
      :title="inviteForm.kind === 'redeem' ? '生成兑换码' : '生成注册码'"
      style="width: 800px; max-width: 94vw"
    >
      <div class="modal-scroll">
        <n-form label-placement="top" :show-feedback="false">
          <div class="kind-pick">
            <button
              type="button" class="kind-opt" :class="{ active: inviteForm.kind === 'register' }"
              @click="setInviteKind('register')"
            >
              <b>注册码</b>
              <span>注册新账号，可指定角色、使用次数与有效期</span>
            </button>
            <button
              type="button" class="kind-opt" :class="{ active: inviteForm.kind === 'redeem' }"
              @click="setInviteKind('redeem')"
            >
              <b>兑换码</b>
              <span>给已有账号增加配额或延长有效期</span>
            </button>
          </div>

          <div class="form-cols">
            <n-form-item label="生成数量（1–50）">
              <div class="stack" style="gap: 6px; width: 100%">
                <n-input-number v-model:value="inviteForm.count" :min="1" :max="50" :precision="0" style="width: 100%" />
                <div class="quick-row">
                  <button
                    v-for="n in inviteCountOptions" :key="n" type="button"
                    class="quick" :class="{ on: inviteForm.count === n }"
                    @click="setInviteCount(n)"
                  >{{ n }} 个</button>
                </div>
              </div>
            </n-form-item>
            <n-form-item label="每个码可用次数">
              <n-input-number v-model:value="inviteForm.maxUses" :min="1" :max="1000" :precision="0" style="width: 100%" />
            </n-form-item>
          </div>

          <n-form-item v-if="inviteForm.kind === 'register'" label="角色">
            <n-select v-model:value="inviteForm.role" :options="roleOptions" />
          </n-form-item>

          <div class="form-block">
            <div class="block-head">
              <b>有效期</b>
              <span>从生成时刻开始计算</span>
            </div>
            <div class="seg">
              <button
                v-for="opt in inviteExpiryOptions" :key="opt.value" type="button"
                class="seg-btn" :class="{ active: inviteForm.expiryMode === opt.value }"
                @click="inviteForm.expiryMode = opt.value"
              >{{ opt.label }}</button>
            </div>
            <div class="expiry-extra">
              <template v-if="inviteForm.expiryMode === 'days'">
                <n-input-number v-model:value="inviteForm.ttlDays" :min="1" :max="365" :precision="0" style="width: 140px" />
                <span class="hint">天后失效（最多 365 天）</span>
              </template>
              <n-date-picker
                v-else-if="inviteForm.expiryMode === 'custom'"
                v-model:formatted-value="inviteForm.expiresAt"
                type="date" value-format="yyyy-MM-dd" clearable
                placeholder="选择到期日期" style="width: 200px"
              />
              <span v-else class="hint">{{ inviteForm.expiryMode === 'permanent' ? '不设到期时间，长期可用' : '生成后 72 小时内有效' }}</span>
            </div>
          </div>

          <n-form-item label="备注">
            <n-input v-model:value="inviteForm.note" maxlength="200" show-count placeholder="例如：给朋友的一次性注册码" />
          </n-form-item>

          <div class="form-block">
            <div class="block-head">
              <b>授予配额</b>
              <span>{{ inviteForm.kind === 'redeem' ? '兑换时叠加到账号现有配额' : '可选，注册成功后一并授予' }}</span>
              <n-checkbox v-if="inviteForm.kind === 'register'" v-model:checked="inviteForm.withQuota" class="block-check">
                附带配额
              </n-checkbox>
            </div>
            <template v-if="inviteForm.kind === 'redeem' || inviteForm.withQuota">
              <div class="quota-grid">
                <div class="field">
                  <div class="field-label">每日转换</div>
                  <n-input-number v-model:value="inviteForm.quota.dailyConvert" :min="0" :precision="0" placeholder="0" style="width: 100%" />
                  <div class="field-hint">0 = 不限</div>
                </div>
                <div class="field">
                  <div class="field-label">每日拉取</div>
                  <n-input-number v-model:value="inviteForm.quota.dailyPull" :min="0" :precision="0" placeholder="0" style="width: 100%" />
                  <div class="field-hint">0 = 不限</div>
                </div>
                <div class="field">
                  <div class="field-label">订阅上限</div>
                  <n-input-number v-model:value="inviteForm.quota.maxProfiles" :min="0" :precision="0" placeholder="0" style="width: 100%" />
                  <div class="field-hint">0 = 不限</div>
                </div>
              </div>
              <div class="quota-expiry-row">
                <span class="field-label">配额到期</span>
                <button
                  v-for="d in quotaDayOptions" :key="d" type="button"
                  class="quick" @click="setQuotaExpiry(d)"
                >{{ d }} 天</button>
                <button type="button" class="quick" @click="setQuotaExpiry(0)">永久</button>
                <n-date-picker
                  v-model:formatted-value="inviteForm.quota.expiresAt"
                  type="date" value-format="yyyy-MM-dd" clearable
                  placeholder="永久" style="width: 170px"
                />
              </div>
              <div class="block-line">
                <span class="field-label">允许的客户端</span>
                <span class="hint">不选 = 全部客户端</span>
              </div>
              <n-select
                v-model:value="inviteForm.quota.clients"
                multiple filterable tag
                :options="clientOptions"
                :max-tag-count="3"
                placeholder="不选表示全部客户端"
              />
            </template>
          </div>
        </n-form>
      </div>
      <template #footer>
        <div class="modal-foot">
          <span class="hint">将生成 {{ inviteForm.count }} 个{{ inviteForm.kind === 'redeem' ? '兑换码' : '注册码' }}</span>
          <div class="row">
            <n-button @click="inviteOpen = false">取消</n-button>
            <n-button type="primary" :loading="inviteSaving" @click="createInvite">生成</n-button>
          </div>
        </div>
      </template>
    </n-modal>
  </div>
</template>
<style scoped>
.sys-head { margin-bottom: 16px; }
.pw-alert { margin-bottom: 14px; }
.section-card { margin-top: 14px; }
.updated { margin-right: 2px; font-variant-numeric: tabular-nums; }

/* ── 页头 ── */
.head-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-top: 4px; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text-dim);
  font-size: 11.5px;
  white-space: nowrap;
}
.pill i { width: 6px; height: 6px; border-radius: 50%; background: #10b981; box-shadow: 0 0 0 3px color-mix(in oklab, #10b981 16%, transparent); }
.pill.ok { color: #0f9f6e; border-color: color-mix(in oklab, #10b981 28%, transparent); background: color-mix(in oklab, #10b981 8%, transparent); }
.pill.wait i { background: #f59e0b; box-shadow: 0 0 0 3px color-mix(in oklab, #f59e0b 16%, transparent); }
.pill.bad { color: #dc2626; border-color: color-mix(in oklab, #ef4444 28%, transparent); background: color-mix(in oklab, #ef4444 8%, transparent); }
.pill.bad i { background: #ef4444; box-shadow: 0 0 0 3px color-mix(in oklab, #ef4444 16%, transparent); }
.pill.plain { background: transparent; }

/* ── 区块头 ── */
.sec-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sec-ico {
  width: 28px; height: 28px; border-radius: 9px;
  display: grid; place-items: center; flex: 0 0 auto;
  background: var(--accent-soft); color: var(--accent);
  border: 1px solid color-mix(in oklab, var(--accent) 16%, transparent);
}
.sec-ico svg { width: 15px; height: 15px; }
.sec-ico.blue { background: color-mix(in oklab, #3b82f6 12%, transparent); color: #2563eb; border-color: color-mix(in oklab, #3b82f6 20%, transparent); }
.sec-ico.green { background: color-mix(in oklab, #10b981 12%, transparent); color: #0f9f6e; border-color: color-mix(in oklab, #10b981 20%, transparent); }
.sec-ico.amber { background: color-mix(in oklab, #f59e0b 13%, transparent); color: #b45309; border-color: color-mix(in oklab, #f59e0b 22%, transparent); }
.sec-ico.slate { background: color-mix(in oklab, var(--text) 7%, transparent); color: var(--text-dim); border-color: var(--line); }
.sec-head b { display: block; font-size: 13.5px; font-weight: 600; line-height: 1.3; color: var(--text); }
.sec-sub { display: block; margin-top: 1px; font-size: 11.5px; color: var(--text-dim); line-height: 1.35; }
.card-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.count-pill {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
  border-radius: 999px; background: color-mix(in oklab, var(--text) 7%, transparent);
  color: var(--text-dim); font-size: 10.5px; font-variant-numeric: tabular-nums;
}
.count-inline {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px;
  margin-left: 4px; border-radius: 999px;
  background: color-mix(in oklab, var(--text) 7%, transparent);
  color: var(--text-dim); font-size: 10.5px; font-weight: 500;
  vertical-align: 1px; font-variant-numeric: tabular-nums;
}
.self-tag {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px;
  margin-left: 2px; border-radius: 999px;
  color: var(--accent); background: var(--accent-soft);
  border: 1px solid color-mix(in oklab, var(--accent) 24%, transparent);
  font-size: 10.5px; font-weight: 500; white-space: nowrap;
}

/* ── 引擎 / 服务状态 ── */
.engine-grid { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr); gap: 14px; }
.status-pill {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px;
  border-radius: 999px; border: 1px solid transparent;
  font-size: 11px; white-space: nowrap;
}
.status-pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pill.ok { color: #0f9f6e; background: color-mix(in oklab, #10b981 10%, transparent); border-color: color-mix(in oklab, #10b981 24%, transparent); }
.status-pill.wait { color: #b45309; background: color-mix(in oklab, #f59e0b 10%, transparent); border-color: color-mix(in oklab, #f59e0b 24%, transparent); }
.status-pill.bad { color: #dc2626; background: color-mix(in oklab, #ef4444 10%, transparent); border-color: color-mix(in oklab, #ef4444 24%, transparent); }
.engine-body { display: flex; flex-direction: column; gap: 10px; }
.engine-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.soft-tag {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
  border-radius: 6px; border: 1px solid var(--line);
  background: var(--panel-strong); color: var(--text-dim); font-size: 10.5px;
}
.engine-actions { margin-top: 2px; }
.kv-list {
  display: flex; flex-direction: column;
  border: 1px solid var(--line); border-radius: 10px;
  overflow: hidden; background: var(--panel); margin-top: 2px;
}
.kv {
  display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px;
  padding: 8px 11px; font-size: 12px; border-bottom: 1px solid var(--line-soft);
}
.kv:last-child { border-bottom: 0; }
.kv > span { color: var(--text-dim); white-space: nowrap; }
.kv > b {
  min-width: 0; font-weight: 500; text-align: right;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.kv > b.mono { font-family: var(--mono); font-size: 11.5px; }
.service-kv .kv > b { white-space: normal; line-height: 1.5; overflow-wrap: anywhere; }

/* ── 工具条 ── */
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.toolbar-hint { font-size: 11.5px; color: var(--text-dim); margin-left: auto; }
.w220 { width: 220px; }
.w200 { width: 200px; }
.w160 { width: 160px; }
.w150 { width: 150px; }
.w140 { width: 140px; }
.w130 { width: 130px; }
.ta-r { text-align: right; }

/* ── 账号卡片列表 ── */
.user-list {
  display: flex; flex-direction: column;
  border: 1px solid var(--line); border-radius: 12px;
  overflow: hidden; background: var(--panel);
}
.user-row {
  display: grid;
  grid-template-columns: minmax(215px, 1.05fr) minmax(250px, 1.3fr) minmax(165px, 1fr) 118px 132px;
  gap: 16px; align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line-soft);
  transition: background .14s ease;
}
.user-row:last-child { border-bottom: 0; }
.user-row:hover { background: color-mix(in oklab, var(--panel-strong) 55%, transparent); }
.user-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
.avatar {
  width: 36px; height: 36px; border-radius: 50%; flex: 0 0 auto;
  display: grid; place-items: center;
  font-size: 13.5px; font-weight: 600; letter-spacing: .02em;
  background: var(--accent-soft); color: var(--accent);
  border: 1px solid color-mix(in oklab, var(--accent) 20%, transparent);
}
.avatar.role-operator { background: color-mix(in oklab, #0ea5e9 13%, transparent); color: #0284c7; border-color: color-mix(in oklab, #0ea5e9 22%, transparent); }
.avatar.role-user { background: color-mix(in oklab, var(--text) 7%, transparent); color: var(--text-dim); border-color: var(--line); }
.user-id-main { min-width: 0; }
.user-name { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.user-name b {
  font-size: 13.5px; font-weight: 600; line-height: 1.3;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.user-sub { margin-top: 2px; font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.role-tag { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 5px; font-size: 10.5px; font-weight: 500; white-space: nowrap; }
.role-tag.role-admin { color: var(--accent); background: var(--accent-soft); }
.role-tag.role-operator { color: #0284c7; background: color-mix(in oklab, #0ea5e9 12%, transparent); }
.role-tag.role-user { color: var(--text-dim); background: color-mix(in oklab, var(--text) 7%, transparent); }
.mark {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px;
  border-radius: 999px; border: 1px solid var(--line);
  color: var(--text-dim); font-size: 10px; white-space: nowrap;
}
.mark.self { color: var(--accent); border-color: color-mix(in oklab, var(--accent) 26%, transparent); background: var(--accent-soft); }
.mark.info { color: #0284c7; border-color: color-mix(in oklab, #0ea5e9 26%, transparent); background: color-mix(in oklab, #0ea5e9 8%, transparent); }

.quota-cell { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.qline { min-width: 0; }
.qtop { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 11.5px; color: var(--text-dim); }
.qtop b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.qtop em { font-style: normal; font-weight: 400; color: var(--text-dim); margin-left: 2px; }
.qbar { height: 4px; margin-top: 4px; border-radius: 999px; overflow: hidden; background: color-mix(in oklab, var(--text) 9%, transparent); }
.qbar i { display: block; height: 100%; border-radius: 999px; background: var(--accent); transition: width .28s ease; }
.qbar.warn i { background: #f59e0b; }
.qbar.over i { background: #ef4444; }
.qbar.unlimited i { background: repeating-linear-gradient(90deg, color-mix(in oklab, var(--text) 20%, transparent) 0 3px, transparent 3px 7px); }
.qfoot { font-size: 11px; color: var(--text-dim); }
.qfoot b { color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }

.clients-cell { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.client-chip {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
  border-radius: 6px; border: 1px solid var(--line);
  background: var(--panel-strong); color: var(--text-dim);
  font-size: 10.5px; white-space: nowrap;
}
.client-chip.all { border-style: dashed; background: transparent; }
.client-chip.more { background: transparent; }

.expiry-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 11.5px; }
.expiry-cell b { font-weight: 500; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
.expiry-cell span { font-size: 10.5px; color: var(--text-dim); white-space: nowrap; }
.expiry-cell.warn b, .expiry-cell.warn span { color: #d97706; }
.expiry-cell.danger b, .expiry-cell.danger span { color: #dc2626; }

.row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }

/* ── 注册码分类 tabs ── */
.iv-tabs {
  display: flex; align-items: center; gap: 3px; flex-wrap: wrap;
  width: max-content; max-width: 100%;
  padding: 3px; margin-bottom: 10px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--panel-strong);
}
.iv-tab {
  display: inline-flex; align-items: center; gap: 6px;
  height: 27px; padding: 0 10px;
  border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: var(--text-dim);
  font: inherit; font-size: 12px; cursor: pointer;
  transition: color .12s ease, background .12s ease, box-shadow .12s ease;
}
.iv-tab:hover { color: var(--text); background: color-mix(in oklab, var(--text) 5%, transparent); }
.iv-tab.active {
  color: var(--text); background: var(--panel);
  border-color: var(--line);
  box-shadow: 0 1px 3px rgba(15, 23, 42, .08);
}
.iv-count {
  min-width: 18px; height: 16px; padding: 0 5px; border-radius: 999px;
  background: color-mix(in oklab, var(--text) 8%, transparent);
  color: var(--text-dim); font-size: 10px; line-height: 16px;
  text-align: center; font-variant-numeric: tabular-nums;
}
.iv-tab.active .iv-count { color: var(--text); background: color-mix(in oklab, var(--accent) 16%, transparent); }

/* ── 注册码批量操作条 ── */
.iv-batch-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-bottom: 10px; padding: 7px 10px;
  border: 1px solid color-mix(in oklab, var(--accent) 30%, transparent);
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--text); font-size: 11.5px;
}
.iv-batch-note { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.iv-batch-note b { font-weight: 600; font-variant-numeric: tabular-nums; }
.iv-batch-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; }

/* ── 注册码列表 ── */
.iv-wrap { border: 1px solid var(--line); border-radius: 12px; overflow-x: auto; background: var(--panel); }
.iv-head, .iv-row {
  display: grid;
  grid-template-columns: 22px minmax(190px, 1.15fr) 72px 92px minmax(112px, .7fr) 104px minmax(180px, 1.35fr) 64px;
  gap: 10px; align-items: center; padding: 9px 14px; min-width: 940px;
}
.iv-check { display: flex; align-items: center; justify-content: center; }
.iv-head {
  font-size: 11px; color: var(--text-dim);
  background: var(--panel-strong); border-bottom: 1px solid var(--line);
}
.iv-row { font-size: 12px; border-bottom: 1px solid var(--line-soft); transition: background .14s ease; }
.iv-row:last-child { border-bottom: 0; }
.iv-row:hover { background: color-mix(in oklab, var(--panel-strong) 55%, transparent); }
.iv-row.sel { background: color-mix(in oklab, var(--accent) 9%, transparent); }
.iv-row.sel:hover { background: color-mix(in oklab, var(--accent) 13%, transparent); }
.iv-code { display: flex; align-items: center; gap: 6px; min-width: 0; }
.iv-code .code {
  font-family: var(--mono); font-size: 12px; letter-spacing: .3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text);
}
.copy-btn {
  flex: 0 0 auto; border: 1px solid var(--line); background: var(--panel-strong);
  color: var(--text-dim); border-radius: 6px; font-size: 10px; line-height: 18px;
  padding: 0 6px; cursor: pointer; transition: color .12s ease, border-color .12s ease, background .12s ease;
}
.copy-btn:hover { color: var(--text); border-color: color-mix(in oklab, var(--accent) 38%, var(--line)); }
.copy-btn.done { color: #0f9f6e; border-color: color-mix(in oklab, #10b981 38%, transparent); background: color-mix(in oklab, #10b981 9%, transparent); }
.type-tag {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
  border-radius: 6px; font-size: 10.5px; white-space: nowrap;
  border: 1px solid var(--line); color: var(--text-dim); background: var(--panel-strong);
}
.type-tag.register { color: var(--accent); background: var(--accent-soft); border-color: color-mix(in oklab, var(--accent) 22%, transparent); }
.type-tag.redeem { color: #b45309; background: color-mix(in oklab, #f59e0b 9%, transparent); border-color: color-mix(in oklab, #f59e0b 26%, transparent); }
.status-tag {
  display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px;
  border-radius: 999px; border: 1px solid transparent; font-size: 10.5px; white-space: nowrap;
}
.status-tag::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .8; }
.status-tag.unused { color: #0f9f6e; background: color-mix(in oklab, #10b981 9%, transparent); border-color: color-mix(in oklab, #10b981 24%, transparent); }
.status-tag.partial { color: #0284c7; background: color-mix(in oklab, #0ea5e9 9%, transparent); border-color: color-mix(in oklab, #0ea5e9 24%, transparent); }
.status-tag.used { color: var(--text-dim); background: color-mix(in oklab, var(--text) 7%, transparent); }
.status-tag.expired { color: #dc2626; background: color-mix(in oklab, #ef4444 8%, transparent); border-color: color-mix(in oklab, #ef4444 22%, transparent); }
.status-tag.revoked { color: var(--text-dim); background: transparent; border-color: var(--line); }
.used-cell { min-width: 0; }
.used-top { display: flex; align-items: baseline; gap: 3px; font-size: 11.5px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.used-top b { color: var(--text); font-weight: 600; }
.mini-bar { height: 3px; max-width: 150px; margin-top: 4px; border-radius: 999px; overflow: hidden; background: color-mix(in oklab, var(--text) 9%, transparent); }
.mini-bar i { display: block; height: 100%; border-radius: 999px; background: var(--accent); transition: width .28s ease; }
.iv-expiry { display: flex; flex-direction: column; gap: 1px; font-size: 11.5px; color: var(--text-dim); }
.iv-expiry b { font-weight: 500; color: var(--text); font-variant-numeric: tabular-nums; }
.iv-expiry span { font-size: 10.5px; }
.iv-expiry.warn b, .iv-expiry.warn span { color: #d97706; }
.iv-expiry.danger b, .iv-expiry.danger span { color: #dc2626; }
.iv-note { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.iv-note .txt { font-size: 11.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iv-note .grant { font-size: 10.5px; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 空状态 ── */
.empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 30px 16px; text-align: center;
  border: 1px dashed var(--line); border-radius: 12px;
  background: color-mix(in oklab, var(--panel-strong) 42%, transparent);
  color: var(--text-dim);
}
.empty.compact { padding: 24px 16px; }
.empty-ico {
  width: 38px; height: 38px; border-radius: 12px; margin-bottom: 2px;
  display: grid; place-items: center;
  background: var(--panel); border: 1px solid var(--line); color: var(--text-dim);
}
.empty-ico svg { width: 18px; height: 18px; }
.empty b { font-size: 13px; font-weight: 600; color: var(--text); }
.empty p { margin: 0 0 4px; font-size: 11.5px; line-height: 1.65; max-width: 430px; }
.foot-hint { margin-top: 10px; line-height: 1.6; }

/* ── 日志 ── */
.log-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.scope-chip {
  display: inline-flex; align-items: center; gap: 5px;
  height: 24px; padding: 0 9px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--panel-strong);
  color: var(--text-dim); font-size: 11px; white-space: nowrap;
  cursor: default;
}
.scope-chip::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .7; }
.scope-chip.self {
  color: var(--accent); background: var(--accent-soft);
  border-color: color-mix(in oklab, var(--accent) 30%, transparent);
}
.log-tabs {
  display: flex; align-items: center; gap: 3px; flex-wrap: wrap;
  width: max-content; max-width: 100%;
  padding: 3px; margin-bottom: 10px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--panel-strong);
}
.log-tab {
  display: inline-flex; align-items: center; gap: 6px;
  height: 27px; padding: 0 10px;
  border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: var(--text-dim);
  font: inherit; font-size: 12px; cursor: pointer;
  transition: color .12s ease, background .12s ease, box-shadow .12s ease;
}
.log-tab:hover { color: var(--text); background: color-mix(in oklab, var(--text) 5%, transparent); }
.log-tab.active {
  color: var(--text); background: var(--panel);
  border-color: var(--line);
  box-shadow: 0 1px 3px rgba(15, 23, 42, .08);
}
.cat-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
.log-count {
  min-width: 18px; height: 16px; padding: 0 5px; border-radius: 999px;
  background: color-mix(in oklab, var(--text) 8%, transparent);
  color: var(--text-dim); font-size: 10px; line-height: 16px;
  text-align: center; font-variant-numeric: tabular-nums;
}
.log-tab.active .log-count { color: var(--text); background: color-mix(in oklab, var(--accent) 16%, transparent); }
.log-list {
  display: flex; flex-direction: column;
  max-height: 400px; overflow: auto;
  border: 1px solid var(--line); border-radius: 12px;
  background: var(--panel);
}
.log-row {
  display: grid;
  grid-template-columns: 66px 92px 12px minmax(0, 1fr) 92px 118px;
  gap: 10px; align-items: center;
  padding: 7px 12px; font-size: 12.5px;
  border-bottom: 1px solid var(--line-soft);
}
.log-list.self .log-row { grid-template-columns: 66px 92px 12px minmax(0, 1fr) 118px; }
.log-row:last-child { border-bottom: 0; }
.log-row:hover { background: color-mix(in oklab, var(--panel-strong) 60%, transparent); }
.log-time { color: var(--text-dim); font-family: var(--mono); font-size: 11px; font-variant-numeric: tabular-nums; }
.log-cat { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-dim); white-space: nowrap; }
.log-cat i { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
.lv-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.lv-dot.info { background: #9ca3af; }
.lv-dot.warn { background: #f59e0b; }
.lv-dot.error { background: #ef4444; }
.log-msg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.log-who, .log-ip {
  min-width: 0; color: var(--text-dim); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.log-ip { text-align: right; }

/* ── 模态框 ── */
.modal-scroll { max-height: min(70vh, 720px); overflow: auto; padding-right: 4px; margin-right: -4px; }
.form-cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; }
.form-cols .n-form-item { margin-bottom: 12px; }
.form-block {
  border: 1px solid var(--line); border-radius: 12px;
  padding: 12px; margin-bottom: 12px;
  background: color-mix(in oklab, var(--panel-strong) 38%, transparent);
}
.block-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.block-head b { font-size: 12.5px; font-weight: 600; color: var(--text); }
.block-head span { font-size: 11px; color: var(--text-dim); }
.block-check { margin-left: auto; }
.quota-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; width: 100%; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field-label { font-size: 11.5px; color: var(--text-dim); }
.field-hint { font-size: 10.5px; color: var(--text-dim); }
.picker-note { margin-top: 6px; }
.kind-pick { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
.kind-opt {
  display: flex; flex-direction: column; gap: 3px; text-align: left;
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--panel); cursor: pointer;
  transition: border-color .12s ease, background .12s ease, box-shadow .12s ease;
}
.kind-opt b { font-size: 12.5px; font-weight: 600; color: var(--text); }
.kind-opt span { font-size: 11px; color: var(--text-dim); line-height: 1.45; }
.kind-opt:hover { border-color: color-mix(in oklab, var(--accent) 30%, var(--line)); }
.kind-opt.active {
  border-color: color-mix(in oklab, var(--accent) 52%, transparent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 18%, transparent);
}
.expiry-extra { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.quick-row { display: flex; flex-wrap: wrap; gap: 4px; }
.quick {
  border: 1px solid var(--line); background: var(--panel);
  color: var(--text-dim); border-radius: 6px;
  font-size: 11px; line-height: 20px; padding: 0 7px; cursor: pointer;
  transition: color .12s ease, border-color .12s ease, background .12s ease;
}
.quick:hover { color: var(--text); border-color: color-mix(in oklab, var(--accent) 30%, var(--line)); }
.quick.on { color: var(--accent); border-color: color-mix(in oklab, var(--accent) 40%, transparent); background: var(--accent-soft); }
.quota-expiry-row, .block-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.quota-expiry-row { margin-top: 10px; }
.quota-expiry-row .field-label { margin-right: 2px; }
.block-line { margin-top: 12px; margin-bottom: 6px; }
.modal-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }

/* ── 概览统计卡 ── */
.stat-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(212px, 1fr));
  gap: 12px; margin: 2px 0 14px;
}
.stat-card { border-color: var(--line); background: var(--panel); }
.stat-body { display: flex; align-items: center; gap: 12px; min-width: 0; }
.stat-ico {
  width: 36px; height: 36px; border-radius: 11px; flex: 0 0 auto;
  display: grid; place-items: center;
  background: var(--accent-soft); color: var(--accent);
  border: 1px solid color-mix(in oklab, var(--accent) 18%, transparent);
}
.stat-ico svg { width: 18px; height: 18px; }
.stat-ico.indigo { background: color-mix(in oklab, var(--accent) 10%, transparent); color: var(--accent); }
.stat-ico.amber { background: color-mix(in oklab, #f59e0b 13%, transparent); color: #b45309; border-color: color-mix(in oklab, #f59e0b 24%, transparent); }
.stat-ico.green { background: color-mix(in oklab, #10b981 12%, transparent); color: #0f9f6e; border-color: color-mix(in oklab, #10b981 22%, transparent); }
.stat-main { display: flex; flex-direction: column; min-width: 0; }
.stat-main b {
  font-size: 22px; line-height: 1.1; font-weight: 650;
  color: var(--text); font-variant-numeric: tabular-nums;
}
.stat-main span {
  margin-top: 3px; font-size: 11px; color: var(--text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── 注册码使用记录 ── */
.log-btn { font-variant-numeric: tabular-nums; }
.ulog { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow: auto; }
.ulog-empty { padding: 2px; font-size: 11.5px; color: var(--text-dim); }
.ulog-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding-bottom: 5px; border-bottom: 1px dashed var(--line-soft);
  font-size: 11.5px;
}
.ulog-row:last-child { padding-bottom: 0; border-bottom: 0; }
.ulog-row b {
  min-width: 0; font-weight: 600; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ulog-row .mono { font-size: 10.5px; color: var(--text-dim); white-space: nowrap; }

/* ── 亮色主题：新增块对比度兜底 ── */
html[data-theme='light'] .stat-card { background: var(--panel); border-color: var(--line); }
html[data-theme='light'] .stat-main b { color: var(--text); }
html[data-theme='light'] .stat-ico.amber { color: #92400e; }
html[data-theme='light'] .ulog-row .mono { color: var(--text-dim); }
html[data-theme='light'] .count-pill,
html[data-theme='light'] .count-inline { background: rgba(15, 23, 42, .06); color: #475569; }

/* 注册码：表头 / 分隔线 / 分类 tabs */
html[data-theme='light'] .iv-tabs { background: #f1f3f5; border-color: rgba(17, 24, 39, .14); }
html[data-theme='light'] .iv-tab { color: #475569; }
html[data-theme='light'] .iv-tab:hover { color: #0f172a; background: rgba(15, 23, 42, .05); }
html[data-theme='light'] .iv-tab.active { color: #0f172a; background: #fff; border-color: rgba(17, 24, 39, .16); }
html[data-theme='light'] .iv-count { background: rgba(15, 23, 42, .07); color: #475569; }
html[data-theme='light'] .iv-tab.active .iv-count { color: #4338ca; background: rgba(79, 70, 229, .12); }
html[data-theme='light'] .iv-wrap { border-color: rgba(17, 24, 39, .14); }
html[data-theme='light'] .iv-head {
  background: #f1f3f5; color: #374151;
  border-bottom-color: rgba(17, 24, 39, .16);
}
html[data-theme='light'] .iv-row { border-bottom-color: rgba(17, 24, 39, .08); }
html[data-theme='light'] .iv-row:hover { background: rgba(15, 23, 42, .035); }
html[data-theme='light'] .iv-row.sel { background: rgba(79, 70, 229, .07); }
html[data-theme='light'] .copy-btn { background: #fff; border-color: rgba(17, 24, 39, .16); color: #475569; }
html[data-theme='light'] .type-tag { border-color: rgba(17, 24, 39, .14); background: #f1f3f5; color: #475569; }
html[data-theme='light'] .type-tag.register { border-color: rgba(79, 70, 229, .30); background: rgba(79, 70, 229, .10); color: #4338ca; }
html[data-theme='light'] .type-tag.redeem { border-color: rgba(180, 83, 9, .28); background: rgba(180, 83, 9, .09); color: #b45309; }

/* 状态胶囊 */
html[data-theme='light'] .status-tag { border-color: rgba(17, 24, 39, .14); }
html[data-theme='light'] .status-tag.unused { color: #047857; background: rgba(4, 120, 87, .09); border-color: rgba(4, 120, 87, .28); }
html[data-theme='light'] .status-tag.partial { color: #0369a1; background: rgba(2, 132, 199, .09); border-color: rgba(2, 132, 199, .28); }
html[data-theme='light'] .status-tag.used { color: #475569; background: rgba(15, 23, 42, .06); border-color: rgba(15, 23, 42, .14); }
html[data-theme='light'] .status-tag.expired { color: #b91c1c; background: rgba(220, 38, 38, .08); border-color: rgba(220, 38, 38, .28); }
html[data-theme='light'] .status-tag.revoked { border-color: rgba(15, 23, 42, .16); }

/* 批量操作条 */
html[data-theme='light'] .iv-batch-bar {
  background: #eef2ff; border-color: rgba(79, 70, 229, .30); color: #1e1b4b;
}

/* 日志：scope 标签 / tabs / 列表分隔线 */
html[data-theme='light'] .scope-chip { background: #f1f3f5; border-color: rgba(17, 24, 39, .14); color: #475569; }
html[data-theme='light'] .scope-chip.self { background: rgba(79, 70, 229, .10); border-color: rgba(79, 70, 229, .30); color: #4338ca; }
html[data-theme='light'] .self-tag { background: rgba(79, 70, 229, .10); border-color: rgba(79, 70, 229, .28); color: #4338ca; }
html[data-theme='light'] .log-tabs { background: #f1f3f5; border-color: rgba(17, 24, 39, .14); }
html[data-theme='light'] .log-tab { color: #475569; }
html[data-theme='light'] .log-tab:hover { color: #0f172a; background: rgba(15, 23, 42, .05); }
html[data-theme='light'] .log-tab.active { color: #0f172a; background: #fff; border-color: rgba(17, 24, 39, .16); }
html[data-theme='light'] .log-count { background: rgba(15, 23, 42, .06); color: #475569; }
html[data-theme='light'] .log-list { border-color: rgba(17, 24, 39, .14); }
html[data-theme='light'] .log-row { border-bottom-color: rgba(17, 24, 39, .08); }
html[data-theme='light'] .log-row:hover { background: rgba(15, 23, 42, .035); }

/* ── 响应式 ── */
@media (max-width: 1200px) {
  .user-row {
    grid-template-columns: minmax(200px, 1fr) minmax(230px, 1.2fr) minmax(150px, 1fr) 110px;
    row-gap: 10px;
  }
  /* 仅账号列表把操作区折到下一行；注册码表列多，折行会撑高每一行 */
  .user-row .row-actions { grid-column: 1 / -1; }
}
@media (max-width: 980px) {
  .engine-grid { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .form-cols, .quota-grid, .kind-pick { grid-template-columns: 1fr; }
  .user-row { grid-template-columns: 1fr; }
  .user-row .row-actions { grid-column: auto; justify-content: flex-start; }
  .log-row { grid-template-columns: 58px 84px 10px minmax(0, 1fr) 90px; }
  .log-list.self .log-row { grid-template-columns: 58px 84px 10px minmax(0, 1fr); }
  .log-ip { display: none; }
  .modal-foot { flex-direction: column; align-items: stretch; gap: 8px; }
  .toolbar-hint { margin-left: 0; }
}
</style>

