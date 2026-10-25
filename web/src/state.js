import { reactive } from 'vue';
import { api } from './api.js';

const savedTheme = localStorage.getItem('subhub.theme');

export const state = reactive({
  view: 'convert',
  theme: savedTheme === 'light' ? 'light' : 'dark',
  loading: true,
  status: {},
  auth: { user: null, admin: false, defaultPassword: false },
  targets: [],
  templates: [],
  library: { rulesets: [], bases: [], dns: [], repos: [], categories: [] },
  catalog: { count: 0, groups: [] },
  profiles: [],
  logs: [],
  icons: [],
  iconsSummary: {},
  settings: { engine: { mode: 'internal', base: '', hasToken: false, tokenMask: '' } },
  permissions: [],
  convert: {
    template: '',
    target: 'mihomo',
    sources: '',
    nodeText: '',
    configText: '',
    nodes: [],
    rules: [],
    baseId: '',
    dnsId: '',
    include: '',
    exclude: '',
    opts: { emoji: true, udp: true, tfo: false, scv: true, sort: false },
    live: true,
    draft: null,
  },
  preview: { body: '', nodes: 0, bytes: 0, ms: 0, warnings: [], loading: false, error: '', at: 0 },
  link: '',
  busy: false,
});

export function setTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  localStorage.setItem('subhub.theme', state.theme);
  document.documentElement.dataset.theme = state.theme;
}

export async function loadState() {
  const status = await api('/api/state');
  state.status = status;
  state.targets = status.targets || [];
  state.templates = status.templates || [];
  state.library = status.library || { rulesets: [], bases: [], dns: [], repos: [], categories: [] };
  state.catalog = status.catalog || { count: 0, groups: [] };
  state.icons = status.icons || [];
  state.iconsSummary = status.iconsSummary || {};
  state.settings = status.settings || state.settings;
  state.permissions = (status.auth && status.auth.permissions) || [];
  state.auth = {
    user: status.user || null,
    admin: !!(status.authenticated && status.user && status.user.role === 'admin'),
    defaultPassword: !!(status.auth && status.auth.defaultPassword),
  };
  if (!state.convert.template) {
    state.convert.template = (status.defaults && status.defaults.template) || (state.templates[0] && state.templates[0].name) || 'full';
  }
  if (!state.targets.some((t) => t.id === state.convert.target)) {
    state.convert.target = (state.targets[0] && state.targets[0].id) || 'mihomo';
  }
  state.loading = false;
  return status;
}

export async function loadProfiles() {
  const data = await api('/api/profiles');
  state.profiles = data.items || [];
}

export async function loadLogs() {
  const data = await api('/api/logs');
  state.logs = data.items || [];
}

export function targetById(id) {
  return state.targets.find((t) => t.id === id) || state.targets[0] || null;
}

export function buildPayload() {
  const c = state.convert;
  const payload = {
    target: c.target,
    template: c.template,
    include: c.include || '',
    exclude: c.exclude || '',
    opts: { ...c.opts },
  };
  const sources = String(c.sources || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (sources.length) payload.sources = sources;
  if (c.nodes.length) payload.nodes = c.nodes;
  if (c.baseId) payload.baseId = c.baseId;
  if (c.dnsId) payload.dnsId = c.dnsId;
  if (c.rules.length) {
    payload.rulesetIds = c.rules.map((r) => (r.inline && r.inline.length
      ? { id: r.id, group: r.group, noResolve: !!r.noResolve, inline: r.inline, name: r.name }
      : { id: r.id, group: r.group, noResolve: !!r.noResolve }));
  }
  const draft = c.draft;
  if (draft && (draft.dirty || c.useDraftOnce)) {
    payload.templateContent = draft.ini;
    payload.template = '';
  }
  return payload;
}

export function canConvert() {
  const c = state.convert;
  return !!String(c.sources || '').trim() || c.nodes.length > 0;
}

export function makeLocalId(prefix = 'inline') {
  return `${prefix}-${Date.now().toString(36)}`;
}

/** 当前登录用户是否有某项权限；未登录时返回 false */
export function can(perm) {
  if (!state.auth || !state.auth.user) return false;
  if (state.auth.admin) return true;
  return (state.permissions || []).includes(perm);
}

/** 图标 id → 可渲染的 emoji 或图片 dataUrl */
export function iconOf(id) {
  const key = String(id || '').trim();
  if (!key) return '';
  if (key.startsWith('data:image/')) return key;
  const hit = state.icons.find((it) => it.id === key);
  return hit ? hit.value : key;
}
