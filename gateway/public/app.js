'use strict';

/* ============================================================
   SubHub 前端（零构建 · 原生 JS）
   ============================================================ */

/* ── 常量 ─────────────────────────────────────────────────── */
const GROUP_TYPES = [
  ['select', '手动选择'],
  ['url-test', '自动测速'],
  ['fallback', '故障转移'],
  ['load-balance', '负载均衡'],
];

const RULE_TYPES = [
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
  'GEOIP', 'IP-ASN', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR',
  'SRC-PORT', 'DST-PORT', 'PROCESS-NAME', 'PROCESS-PATH',
  'URL-REGEX', 'USER-AGENT', 'RULE-SET', 'AND', 'OR', 'NOT', 'MATCH', 'FINAL',
];

const BUILTIN_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];

const DOWNLOAD_EXT = {
  mihomo: 'yaml', daed: 'yaml', stash: 'yaml',
  singbox: 'json', v2ray: 'txt',
  surge: 'conf', loon: 'conf', quanx: 'conf', surfboard: 'conf',
};

/* ── 状态 ─────────────────────────────────────────────────── */
const state = {
  status: null,
  view: 'convert',
  theme: 'dark',
  auth: { user: null, admin: false, defaultPassword: false },
  collapsed: { import: false, nodes: false, strategy: true, rules: false, options: true, output: false },
  convert: {
    sources: '',
    nodeText: '',
    blocks: [], // {type:'url'|'links'|'text', value:'', name:''}
    nodes: [],
    target: 'mihomo',
    template: 'full',
    baseId: '',
    dnsId: '',
    rules: [],
    ruleQ: '',
    ruleItems: [],
    ruleTotal: 0,
    ruleLoading: false,
    ruleGroup: '',
    nodeQ: '',
    include: '',
    exclude: '',
    live: true,
    opts: { emoji: true, udp: true, tfo: false, scv: true, sort: false },
    draft: null, // {name, model, dirty}
    useDraftOnce: false,
  },
  batch: { on: false, sel: [] },
  preview: { body: '', nodes: 0, bytes: 0, ms: 0, error: '', loading: false, tab: 'config', at: 0, warnings: [] },
  library: { rulesets: [], bases: [], dns: [] },
  libSearch: { q: '', items: [], total: 0 },
  libView: { ruleset: 'card', tab: 'all', page: 'ruleset' },
  result: null,
  link: null,
  templates: [],
  profiles: [],
  profileError: null,
  logs: [],
  editor: null,
  busy: false,
};

/* ── 主题 ─────────────────────────────────────────────────── */
const THEMES = ['dark', 'light'];
function applyTheme(name, persist = true) {
  const theme = THEMES.includes(name) ? name : 'dark';
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  if (persist) try { localStorage.setItem('subhub.theme', theme); } catch { /* ignore */ }
  const sel = $('#theme-select');
  if (sel) {
    try { sel.value = theme; } catch { /* linkedom 的 select 没有 value setter */ }
    for (const opt of Array.from(sel.options || [])) {
      if (opt.value === theme) opt.selected = true;
    }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6fb' : '#070a11');
}
/* ── 基础工具 ─────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分`;
  return `${s} 秒`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function parseSources(text) {
  return String(text || '')
    .split(/[\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toast(message, type = 'ok', ms = 3200) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${type === 'err' ? 'err' : 'ok'}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all .2s ease';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ── API ──────────────────────────────────────────────────── */
class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload || null;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch (e) {
    throw new ApiError('网络请求失败，请检查网关是否在线', 0, null);
  }
  const ct = res.headers.get('content-type') || '';
  let payload = null;
  if (ct.includes('application/json')) {
    payload = await res.json().catch(() => null);
  } else {
    payload = await res.text().catch(() => '');
  }
  if (!res.ok) {
    const msg = (payload && payload.error) || (typeof payload === 'string' && payload) || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(String(msg).slice(0, 400), res.status, payload);
  }
  return payload;
}

/* 统一展示后端口令/校验类错误：先 toast，模板校验失败再弹明细 */
function reportError(e, fallback = '操作失败') {
  toast((e && e.message) || fallback, 'err');
  const list = (e && e.payload && ((e.payload.details && e.payload.details.errors) || e.payload.errors)) || [];
  if (Array.isArray(list) && list.length) {
    openModal(`<h3>模板校验未通过</h3><div class="notice">${list.map(esc).join('<br>')}</div><div class="modal-foot"><button class="btn" data-act="modal-close">关闭</button></div>`);
    return true;
  }
  return false;
}

/* ── 二维码 / 复制 / 下载 / 弹窗 ───────────────────────────── */
function qrSvg(text, cellSize = 5) {
  try {
    if (typeof qrcode !== 'function') return '<div class="muted small">二维码库未加载</div>';
    const qr = qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    return qr.createSvgTag({ cellSize, margin: 3, scalable: true });
  } catch (e) {
    return '<div class="muted small">二维码生成失败</div>';
  }
}

async function copyText(text) {
  const value = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      toast('已复制到剪贴板');
      return;
    }
  } catch { /* 降级 */ }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast('已复制到剪贴板');
  } catch {
    toast('复制失败，请手动选择文本', 'err');
  } finally {
    ta.remove();
  }
}

function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function openModal(html, { narrow = false } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-mask"><div class="modal ${narrow ? 'narrow' : ''}">${html}</div></div>`;
  const mask = root.firstElementChild;
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeModal();
  });
  return root;
}

function closeModal() {
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
}

function confirmDialog(title, desc, okLabel, onOk) {
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="modal-desc">${esc(desc)}</p>
    <div class="modal-foot">
      <button class="btn ghost" data-act="modal-close">取消</button>
      <button class="btn danger" id="confirm-ok">${esc(okLabel)}</button>
    </div>
  `, { narrow: true });
  $('#confirm-ok').addEventListener('click', async () => {
    const btn = $('#confirm-ok');
    btn.disabled = true;
    try {
      await onOk();
      closeModal();
    } catch (e) {
      btn.disabled = false;
      toast(e.message || '操作失败', 'err');
    }
  });
}

function openQr(title, url) {
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="modal-desc">用客户端扫描，或复制下方链接手动导入。</p>
    <div class="qr-box">${qrSvg(url, 6)}</div>
    <div class="link-row" style="margin-top:14px">
      <div class="link-url" style="white-space:normal;word-break:break-all">${esc(url)}</div>
      <button class="btn small" data-act="copy" data-copy="${esc(url)}">复制</button>
    </div>
    <div class="modal-foot"><button class="btn" data-act="modal-close">关闭</button></div>
  `);
}

/* ── 客户端信息 ───────────────────────────────────────────── */
let searchRulesTimer = null;
let libSearchTimer = null;

function decodeQrImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const res = window.jsQR
          ? window.jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' })
          : null;
        URL.revokeObjectURL(url);
        resolve(res && res.data ? res.data : '');
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

async function importQrPayload(text) {
  const value = String(text || '').trim();
  if (!value) return;
  if (/^https?:\/\//i.test(value)) {
    state.convert.sources = value;
    render();
    await previewNodes({ mode: 'url', sources: [value] });
    toast('已识别订阅链接并解析节点');
    return;
  }
  if (value.includes('://')) {
    state.convert.nodeText = value;
    render();
    await previewNodes({ mode: 'text', text: value, filename: 'qr.txt' });
    toast('已识别节点链接并解析');
    return;
  }
  toast(`识别到内容，但不是订阅或节点链接：${value.slice(0, 40)}`, 'err');
}

function openQrModal() {
  openModal(`
    <h3>图片识别订阅</h3>
    <p class="modal-desc">上传订阅二维码截图，自动解出链接并导入节点；图片只在本机解析，不会上传。</p>
    <div class="file-drop"><input type="file" id="qr-file" accept="image/*"></div>
    <div class="hint" id="qr-hint">支持 PNG / JPG / WebP。识别失败时换一张更清晰、二维码更完整的图片。</div>
    <div class="modal-foot"><button class="btn" data-act="modal-close">关闭</button></div>
  `, { narrow: true });
  const input = $('#qr-file');
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const hint = $('#qr-hint');
    hint.textContent = '正在识别…';
    try {
      const text = await decodeQrImage(file);
      if (!text) {
        hint.textContent = '没有识别到二维码，换一张图片试试。';
        return;
      }
      closeModal();
      await importQrPayload(text);
    } catch (e) {
      hint.textContent = `识别失败：${e.message || e}`;
    }
  });
}

function targetById(id) {
  return (state.status && state.status.targets || []).find((t) => t.id === id) || { id, label: id };
}

function targetOptions(selected) {
  return (state.status && state.status.targets || [])
    .map((t) => `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.label)}${t.subtitle ? ` · ${esc(t.subtitle)}` : ''}</option>`)
    .join('');
}

function templateOptions(selected) {
  return state.templates.map((t) => `<option value="${esc(t.name)}" ${t.name === selected ? 'selected' : ''}>${esc(t.title)}（${esc(t.name)}）</option>`).join('');
}

/* ── 模板 ini 生成（与服务端 buildIni 对齐，用于原始视图） ── */
function clientBuildGroup(group) {
  const name = String(group.name || '').trim();
  if (!name) return '';
  const type = group.type || 'select';
  if (type === 'select') {
    const refs = (group.refs || []).map((r) => `[]${r}`);
    const patterns = (group.patterns || []).filter(Boolean);
    return `custom_proxy_group=${[name, 'select', ...refs, ...patterns].join('`')}`;
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

function clientBuildRule(rule) {
  const target = String(rule.target || '').trim();
  if (!target) return '';
  if (rule.kind === 'url') {
    const url = String(rule.value || '').trim();
    return /^https?:\/\//i.test(url) ? `ruleset=${target},${url}` : '';
  }
  const type = String(rule.type || '').toUpperCase();
  if (!type) return '';
  const value = String(rule.value == null ? '' : rule.value).trim();
  const options = (rule.options || []).filter(Boolean);
  let inline = `[]${type}`;
  if (value) inline += `,${value}`;
  if (options.length) inline += `,${options.join(',')}`;
  return `ruleset=${target},${inline}`;
}

function clientBuildIni(model) {
  const meta = model.meta || {};
  const lines = ['; SubHub 订阅模板 · 可在 Web 可视化编辑器中修改'];
  lines.push(`; @title ${meta.title || '未命名模板'}`);
  lines.push(`; @description ${String(meta.description || '').replace(/[\r\n]+/g, ' ')}`);
  lines.push(`; @targets ${(meta.targets || []).join(',')}`);
  if (meta.author) lines.push(`; @author ${meta.author}`);
  if (meta.version) lines.push(`; @version ${meta.version}`);
  lines.push('', '[custom]', '');
  const off = new Set((model.groups || []).filter((g) => g.enabled === false).map((g) => g.name));
  for (const g of model.groups || []) {
    if (off.has(g.name)) continue;
    const line = clientBuildGroup(g);
    if (line) lines.push(line);
  }
  lines.push('');
  for (const r of model.rules || []) {
    if (off.has(r.target)) continue;
    const line = clientBuildRule(r);
    if (line) lines.push(line);
  }
  lines.push('');
  for (const extra of model.extras || []) {
    const line = String(extra || '').trim();
    if (line) lines.push(line);
  }
  lines.push('');
  return lines.join('\n');
}

/** 保存模板时剔除停用组以及指向它们的规则 */
function saveableModel(model) {
  const src = model || {};
  const groups = (src.groups || [])
    .filter((g) => g.enabled !== false)
    .map((g) => {
      const { enabled, ...rest } = g;
      return rest;
    });
  const names = new Set(groups.map((g) => g.name));
  const rules = (src.rules || []).filter((r) => names.has(r.target));
  return { ...src, groups, rules };
}

/* ── 外壳 / 路由 ──────────────────────────────────────────── */
const PAGE_META = {
  convert: ['订阅转换', '粘贴上游订阅或节点，选择客户端，实时预览生成结果。'],
  profiles: ['订阅', '生成带 token 的稳定链接，隐藏上游地址，可随时更换源。'],
  templates: ['转换模板', '可视化配置策略组与分流规则，或直接编辑 subconverter ini。'],
  library: ['资源库', '官方规则集、基础配置与 DNS 模板，可自建复用。'],
  system: ['系统状态', '引擎、缓存、限流与运行日志。'],
};

async function loadState() {
  state.status = await api('/api/state');
  state.auth = {
    user: state.status.user || null,
    admin: !!(state.status.authenticated && state.status.user && state.status.user.role === 'admin'),
    defaultPassword: !!state.status.auth && state.status.auth.defaultPassword === true,
  };
  state.library = state.status.library || { rulesets: [], bases: [], dns: [] };
  const list = (state.status && state.status.templates) || [];
  state.templates = list;
  if (!state.convert.template || !list.some((t) => t.name === state.convert.template)) {
    state.convert.template = (state.status.defaults && state.status.defaults.template) || (list[0] && list[0].name) || 'full';
  }
  updateShell();
  if (state.convert.ruleQ) searchRules(state.convert.ruleQ);
}

function updateShell() {
  const status = state.status || {};
  const engine = status.engine || {};
  const dot = $('#engine-dot');
  const text = $('#engine-text');
  if (dot && text) {
    if (engine.ok === true) {
      dot.className = 'dot ok';
      text.textContent = `引擎在线${engine.version ? ` v${engine.version}` : ''}`;
    } else if (engine.ok === false) {
      dot.className = 'dot bad';
      text.textContent = '引擎不可用';
    } else {
      dot.className = 'dot idle';
      text.textContent = '引擎检测中…';
    }
  }
  const version = $('#foot-version');
  if (version) version.textContent = `SubHub v${status.version || '1.0.0'}`;

  renderAccount(status);
}

function go(view) {
  const hash = `#/${view}`;
  if (location.hash === hash) {
    router();
  } else {
    location.hash = hash;
  }
}

let routeSeq = 0;
async function router() {
  const seq = ++routeSeq;
  const raw = location.hash.replace(/^#\/?/, '');
  const [view, ...rest] = raw.split('/');
  const known = ['convert', 'profiles', 'templates', 'library', 'system'];
  state.view = known.includes(view) ? view : 'convert';

  try {
    if (state.view === 'profiles') await ensureProfiles();
    if (state.view === 'templates' && rest[0]) {
      const name = decodeURIComponent(rest[0]);
      if (!state.editor || state.editor.name !== name) await loadTemplate(name);
    }
    if (state.view === 'system') await loadLogs();
  } catch (e) {
    if (state.view === 'profiles') state.profileError = e;
    else toast(e.message || '加载失败', 'err');
  }
  if (seq !== routeSeq) return;
  render();
}

function render() {
  const meta = PAGE_META[state.view] || PAGE_META.convert;
  const title = $('#page-title');
  const sub = $('#page-sub');
  if (title) title.textContent = meta[0];
  if (sub) sub.textContent = meta[1];

  $$('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === state.view);
  });

  const view = $('#view');
  if (!view) return;
  if (!state.status) {
    view.innerHTML = '<div class="empty"><div class="e-icon">◌</div><div class="e-title">正在连接网关…</div></div>';
    return;
  }
  if (state.view === 'convert') view.innerHTML = renderConvert();
  else if (state.view === 'profiles') view.innerHTML = renderProfiles();
  else if (state.view === 'templates') view.innerHTML = renderTemplates();
  else if (state.view === 'library') view.innerHTML = renderLibrary();
  else view.innerHTML = renderSystem();

  if (state.view === 'convert' && state.auth && state.auth.admin) {
    ensureStrategy().catch(() => {});
  }

  const focusEl = view.querySelector('[data-autofocus]');
  if (focusEl) focusEl.focus();
}

/* ── 视图：订阅转换 ───────────────────────────────────────── */
/* ── 视图：订阅转换（左表单 / 右实时预览 / 底部输出格式） ───── */
function libraryOf(kind) {
  if (kind === 'ruleset') return state.library.rulesets || [];
  if (kind === 'base') return state.library.bases || [];
  return state.library.dns || [];
}

function libraryById(kind, id) {
  return libraryOf(kind).find((x) => x.id === id) || null;
}

function layerOptions(kind, selected) {
  return libraryOf(kind)
    .map((x) => `<option value="${esc(x.id)}"${x.id === selected ? ' selected' : ''}>${esc(x.name)} · ${esc(x.format)}${x.builtin ? ' · 官方' : ''}</option>`)
    .join('');
}

function allSources(c = state.convert) {
  const parts = [c.sources, ...(c.blocks || []).filter((b) => b.type === 'url').map((b) => b.value)];
  return parseSources(parts.join('\n'));
}

function linkTextOf(c = state.convert) {
  const parts = [c.nodeText, ...(c.blocks || []).filter((b) => b.type === 'links').map((b) => b.value)];
  return parts.map((x) => String(x || '').trim()).filter(Boolean).join('\n');
}

/** 可折叠卡片外壳 */
function cardBlock(id, { title, desc = '', badge = '', actions = '', body = '' }) {
  const closed = !!state.collapsed[id];
  return `
    <section class="card block ${closed ? 'is-closed' : ''}" data-card="${id}">
      <div class="card-head block-head">
        <button class="block-toggle" type="button" data-act="toggle-card" data-card="${id}" title="${closed ? '展开' : '折叠'}">
          <span class="chev">${closed ? '▸' : '▾'}</span>
        </button>
        <div class="block-title-wrap">
          <span class="block-title">${esc(title)}</span>
          ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
        </div>
        ${actions ? `<div class="row block-actions">${actions}</div>` : ''}
      </div>
      ${closed ? '' : `<div class="block-body">${desc ? `<p class="card-desc">${esc(desc)}</p>` : ''}${body}</div>`}
    </section>`;
}

function renderBlock(b, i) {
  const icon = b.type === 'url' ? '☁' : b.type === 'text' ? '📄' : '🔗';
  const label = b.type === 'url' ? '订阅链接' : b.type === 'text' ? 'YAML / JS 配置' : '节点链接';
  const head = `
    <div class="importer-head">
      <span class="importer-ico">${icon}</span><b>${label}</b><span class="badge gray">#${i + 2}</span>
      <div class="row" style="margin-left:auto">
        <button class="btn small ghost" data-act="block-parse" data-i="${i}">${b.type === 'text' ? '读取配置' : '解析节点'}</button>
        <button class="btn small ghost danger" data-act="block-del" data-i="${i}">✕</button>
      </div>
    </div>`;
  if (b.type === 'text') {
    return `<div class="importer">${head}
      <textarea class="textarea" data-block="${i}" rows="4" placeholder="粘贴 Clash / mihomo YAML、sing-box JSON 或 Base64 订阅文本">${esc(b.value || '')}</textarea>
      <div class="row" style="margin-top:8px">
        <label class="btn small ghost file-btn">选择文件<input type="file" data-block-file="${i}" accept=".yaml,.yml,.json,.txt,.js,.conf,.list"></label>
        <span class="hint">文件只在本机读取，不会上传。</span>
      </div>
    </div>`;
  }
  const ph = b.type === 'url'
    ? 'https://example.com/api/v1/client/subscribe?token=xxxx'
    : 'vless://uuid@example.com:443?security=tls#香港 01';
  return `<div class="importer">${head}
    <textarea class="textarea" data-block="${i}" rows="3" placeholder="${ph}">${esc(b.value || '')}</textarea>
  </div>`;
}

function renderImportCard(c) {
  const limit = (state.status.limits && state.status.limits.sources) || 10;
  return `
    <div class="importer-list">
      <div class="importer">
        <div class="importer-head">
          <span class="importer-ico">☁</span><b>订阅链接</b><span class="badge gray">#1</span>
          <div class="row" style="margin-left:auto">
            <button class="btn small ghost" data-act="fetch-nodes">解析节点</button>
            <button class="btn small ghost" data-act="clear-sources">清空</button>
          </div>
        </div>
        <textarea class="textarea" id="src-input" data-bind="sources" rows="3" placeholder="https://example.com/api/v1/client/subscribe?token=xxxx&#10;https://another.example.com/sub">${esc(c.sources)}</textarea>
        <div class="hint">每行一个，最多 ${limit} 个；明文链接、Base64、Clash YAML、sing-box JSON 均可。</div>
      </div>
      ${(c.blocks || []).map(renderBlock).join('')}
      <div class="importer-add">
        <button class="btn small ghost" data-act="block-add" data-type="url">＋ 订阅链接</button>
        <button class="btn small ghost" data-act="block-add" data-type="text">＋ YAML / JS 配置</button>
        <button class="btn small ghost" data-act="block-add" data-type="links">＋ 节点链接</button>
        <button class="btn small ghost" data-act="qr-open">🖼 图片识别</button>
        <span class="hint">默认只打开订阅链接，其他方式按需添加。</span>
      </div>
    </div>`;
}

function protoClass(type) {
  const t = String(type || '').toLowerCase();
  if (/vmess/.test(t)) return 'p-vmess';
  if (/vless/.test(t)) return 'p-vless';
  if (/trojan/.test(t)) return 'p-trojan';
  if (/hysteria2?|hy2/.test(t)) return 'p-hy2';
  if (/tuic/.test(t)) return 'p-tuic';
  if (/ss|shadowsocks/.test(t)) return 'p-ss';
  if (/anytls/.test(t)) return 'p-anytls';
  return 'p-other';
}

function renderNodePanel(c) {
  const batch = state.batch;
  const counts = {};
  for (const n of c.nodes) {
    const t = String(n.type || 'other').toLowerCase();
    counts[t] = (counts[t] || 0) + 1;
  }
  const summary = Object.entries(counts)
    .map(([t, n]) => `<span class="badge proto ${protoClass(t)}">${esc(t.toUpperCase())} ${n}</span>`)
    .join(' ');
  const rows = c.nodes.map((n, i) => `
      <div class="node-row ${batch.sel.includes(i) ? 'selected' : ''}" data-node-row="${i}">
        ${batch.on ? `<input type="checkbox" data-node-sel="${i}" ${batch.sel.includes(i) ? 'checked' : ''}>` : ''}
        <span class="node-name">${esc(n.name || n.server || '')}</span>
        <span class="badge proto ${protoClass(n.type)}">${esc(String(n.type || '').toUpperCase())}</span>
        <span class="node-addr mono">${esc(n.server || '')}:${esc(n.port || '')}</span>
        <button class="btn small ghost" data-act="node-edit" data-i="${i}">编辑</button>
        <button class="btn small ghost danger" data-act="node-del" data-i="${i}">✕</button>
      </div>`).join('');
  const batchBar = batch.on ? `
    <div class="batch-bar">
      <button class="btn small ghost" data-act="batch-all">${batch.sel.length === c.nodes.length && c.nodes.length ? '取消全选' : '全选'}</button>
      <span class="hint">已选 <b>${batch.sel.length}</b> / ${c.nodes.length}</span>
      <button class="btn small ghost" data-act="batch-edit" ${batch.sel.length ? '' : 'disabled'}>批量编辑</button>
      <button class="btn small ghost danger" data-act="batch-del" ${batch.sel.length ? '' : 'disabled'}>删除所选</button>
      <button class="btn small ghost" data-act="batch-exit">退出</button>
    </div>` : '';
  return `
    <div class="importer node-panel">
      <div class="importer-head">
        <span class="importer-ico">▦</span><b>节点管理</b>
        ${summary ? `<div class="row">${summary}</div>` : `<span class="badge">0 个节点</span>`}
        <div class="row" style="margin-left:auto">
          <button class="btn small ghost" data-act="batch-toggle" ${c.nodes.length ? '' : 'disabled'}>批量管理</button>
          <button class="btn small ghost" data-act="nodes-adopt" ${c.nodes.length ? '' : 'disabled'}>转为自定义节点</button>
          <button class="btn small ghost" data-act="node-add">＋ 添加</button>
          <button class="btn small ghost danger" data-act="nodes-clear" ${c.nodes.length ? '' : 'disabled'}>清空</button>
        </div>
      </div>
      ${c.nodes.length ? `
        ${batchBar}
        <div class="node-tools">
          <input class="input" id="node-search" placeholder="搜索节点…" value="${esc(c.nodeQ || '')}">
          <span class="hint">${c.nodes.length ? '解析所得节点可直接编辑；批量管理可重命名/替换/删除。' : ''}</span>
        </div>
        <div class="node-list" id="node-list">${rows}</div>` : '<div class="empty small">请先在上方导入节点。</div>'}
      <div class="divider"></div>
      ${renderOptionsBody(c)}
    </div>`;
}

function currentGroupNames() {
  const s = structureOfPreview();
  const names = s.groups.map((g) => g.name).filter(Boolean);
  if (names.length) return names;
  return ['🚀 节点选择', '♻️ 自动选择', '🎯 全球直连', '🛑 广告拦截', '🐟 漏网之鱼'];
}

function groupSelect(selected) {
  const names = currentGroupNames();
  if (selected && !names.includes(selected)) names.unshift(selected);
  return names.map((n) => `<option value="${esc(n)}"${n === selected ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

/* ── 分流策略：直接编辑模板策略组（需管理口令） ───────────── */
async function ensureStrategy(force = false) {
  const c = state.convert;
  if (!force && c.draft && c.draft.name === c.template) return c.draft;
  if (!state.status || !state.templates.some((t) => t.name === c.template)) return null;
  const data = await api(`/api/templates/${encodeURIComponent(c.template)}`, { admin: true });
  c.draft = { name: c.template, model: JSON.parse(JSON.stringify(data.model)), dirty: false };
  render();
  schedulePreview(300);
  return c.draft;
}

function strategyDraft() {
  const c = state.convert;
  return c.draft && c.draft.name === c.template ? c.draft : null;
}

function groupTypeLabel(type) {
  const found = GROUP_TYPES.find(([value]) => value === type);
  return found ? found[1] : type;
}

function canEditStrategy() {
  return !!(state.auth && state.auth.admin);
}

function strategyMembers(g) {
  return g.type === 'select' ? (g.refs || []) : (g.patterns || []);
}

function ruleText(r) {
  if (!r) return '';
  if (r.kind === 'url') return `RULE-SET ${r.value}`;
  return `${r.type || ''}${r.value ? `,${r.value}` : ''}${(r.options || []).length ? `,${r.options.join(',')}` : ''}`;
}

function openMemberPicker(groupIndex) {
  const d = strategyDraft();
  if (!d) return;
  const g = d.model.groups[groupIndex];
  if (!g) return;
  const groupNames = d.model.groups.map((x) => x.name).filter((n) => n !== g.name);
  const nodeNames = Array.from(new Set(state.convert.nodes.map((n) => n.name).filter(Boolean))).slice(0, 60);
  const current = new Set(strategyMembers(g));
  const row = (name, kind) => `<label class="check member-pick"><input type="checkbox" data-pick="${esc(name)}" ${current.has(name) ? 'checked' : ''}><span class="badge gray">${kind}</span>${esc(name)}</label>`;
  openModal(`
    <h3>选择成员 · ${esc(g.name)}</h3>
    <p class="modal-desc">可以选节点分组（如 ♻️ 自动选择、🇭🇰 香港）、单个节点，或 DIRECT / REJECT。勾选后点「应用」。</p>
    <div class="field"><label>节点分组</label><div class="pick-list">${groupNames.map((n) => row(n, '分组')).join('') || '<span class="hint">没有其他分组</span>'}</div></div>
    <div class="field"><label>当前订阅里的节点（${nodeNames.length}）</label><div class="pick-list">${nodeNames.map((n) => row(n, '节点')).join('') || '<span class="hint">还没有解析节点</span>'}</div></div>
    <div class="field"><label>内置出站</label><div class="pick-list">${['DIRECT', 'REJECT'].map((n) => row(n, '内置')).join('')}</div></div>
    <div class="modal-foot">
      <button class="btn ghost" data-act="modal-close">取消</button>
      <button class="btn primary" id="pick-apply">应用</button>
    </div>
  `);
  $('#pick-apply').addEventListener('click', () => {
    const picked = Array.from(document.querySelectorAll('[data-pick]'))
      .filter((x) => x.checked)
      .map((x) => x.dataset.pick);
    if (g.type === 'select') g.refs = picked;
    else g.patterns = picked.length ? [picked.join('|')] : [];
    d.dirty = true;
    closeModal();
    render();
    schedulePreview(300);
  });
}

function renderStrategyBody() {
  const d = strategyDraft();
  if (!d) return '<div class="empty small"><span class="spinner"></span> 正在读取模板策略组…</div>';
  const model = d.model;
  const groups = model.groups || [];
  const rules = model.rules || [];
  const editable = canEditStrategy();
  const rows = groups.map((g, i) => {
    const key = `g:${i}`;
    const closed = state.collapsed[key] !== false; // 默认收起
    const members = strategyMembers(g);
    const ruleCount = rules.filter((r) => r.target === g.name).length;
    const on = g.enabled !== false;
    return `
      <div class="strat-group ${closed ? 'is-closed' : ''} ${on ? '' : 'is-off'}">
        <div class="strat-head">
          <button class="strat-toggle" data-act="strat-toggle" data-i="${i}">${closed ? '▸' : '▾'}</button>
          <b class="strat-name">${esc(g.name)}</b>
          <span class="badge gray">${esc(groupTypeLabel(g.type))}</span>
          <span class="hint">${ruleCount} 条规则 · ${members.length} 个成员</span>
          <div class="row strat-actions">
            <label class="switch" title="${on ? '已启用' : '已停用'}"><input type="checkbox" data-strat-on="${i}" ${on ? 'checked' : ''} ${editable ? '' : 'disabled'}></label>
            <button class="btn small ghost" data-act="strat-up" data-i="${i}" ${!editable || i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn small ghost" data-act="strat-down" data-i="${i}" ${!editable || i === groups.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn small ghost danger" data-act="strat-del" data-i="${i}" ${editable ? '' : 'disabled'}>✕</button>
          </div>
        </div>
        ${closed ? '' : `
          <div class="strat-body">
            <div class="grid-2">
              <div class="field"><label>类型</label>
                <select class="select" data-strat-type="${i}" ${editable ? '' : 'disabled'}>${GROUP_TYPES.map(([value, label]) => `<option value="${value}"${value === g.type ? ' selected' : ''}>${label}</option>`).join('')}</select>
              </div>
              ${g.type === 'select' ? '' : `
                <div class="field"><label>测速地址</label><input class="input" data-strat-url="${i}" value="${esc(g.url || 'http://www.gstatic.com/generate_204')}" ${editable ? '' : 'disabled'}></div>`}
            </div>
            <div class="field">
              <label>${g.type === 'select' ? '成员（节点 / 分组 / DIRECT）' : '节点匹配正则'}</label>
              <div class="chip-row">${members.length ? members.map((m, j) => `<span class="chip-sm">${esc(m)}${editable ? `<button data-act="strat-member-del" data-i="${i}" data-j="${j}">×</button>` : ''}</span>`).join('') : '<span class="hint">暂无成员</span>'}</div>
              ${editable ? `<div class="row" style="margin-top:8px">
                <button class="btn small ghost" data-act="strat-pick" data-i="${i}">从节点/分组中选择…</button>
                <input class="input small-input" id="strat-new-${i}" placeholder="也可以直接输入，例如 DIRECT、♻️ 自动选择">
                <button class="btn small ghost" data-act="strat-member-add" data-i="${i}">添加</button>
              </div>` : ''}
            </div>
            <details class="used-rules" ${ruleCount ? '' : 'hidden'}>
              <summary>使用该分组的规则（${ruleCount}）</summary>
              <div class="struct-rules">${rules.filter((r) => r.target === g.name).slice(0, 30).map((r) => `<div class="struct-rule"><span class="mono">${esc(ruleText(r))}</span></div>`).join('')}${ruleCount > 30 ? '<div class="hint">仅显示前 30 条</div>' : ''}</div>
            </details>
            ${g.type === 'select' ? '' : `
              <div class="grid-2">
                <div class="field"><label>包含正则</label><input class="input" data-strat-pattern="${i}" value="${esc((g.patterns || []).join(','))}" ${editable ? '' : 'disabled'}></div>
                <div class="field"><label>排除正则</label><input class="input" data-strat-exclude="${i}" value="${esc(g.exclude || '')}" ${editable ? '' : 'disabled'}></div>
              </div>`}
          </div>`}
      </div>`;
  }).join('');
  return `
    ${editable ? '' : '<div class="notice">策略组属于模板内容，登录管理员账号后才能在这里调整。右侧仍可调整规则顺序与分组。</div>'}
    <div class="strat-list">${rows || '<div class="empty small">这个模板没有策略组。</div>'}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn small ghost" data-act="strat-add" ${editable ? '' : 'disabled'}>＋ 新增策略组</button>
      <button class="btn small ghost" data-act="strat-reset" ${editable ? '' : 'disabled'}>恢复模板默认</button>
      ${d.dirty ? '<span class="badge amber">已修改，转换时会询问如何保存</span>' : '<span class="hint">改动仅存在浏览器内存中，转换前会询问保存方式。</span>'}
    </div>`;
}

function renderRuleResults() {
  const c = state.convert;
  if (c.ruleLoading) return '<div class="empty small"><span class="spinner"></span> 正在搜索…</div>';
  if (!c.ruleItems.length) {
    return `<div class="empty small">${c.ruleQ ? '没有匹配的规则集。' : '输入关键词搜索 2183 条官方规则集，支持中文名（如「广告」「谷歌」「流媒体」）。'}</div>`;
  }
  return c.ruleItems.map((item) => `
    <div class="rule-result">
      <div class="rule-main">
        <span class="rule-name">${esc(item.name || item.id)}</span>
        <span class="badge gray">${item.kind === 'geoip' ? 'IP' : '域名'}</span>
        <span class="badge">${esc(item.group || '')}</span>
      </div>
      <span class="hint mono">${esc(item.id)}</span>
      <button class="btn small" data-act="catalog-add" data-id="${esc(item.id)}">＋ 添加</button>
    </div>`).join('');
}

function renderRulesBody(c) {
  const selected = c.rules || [];
  const rows = selected.map((r, i) => `
    <div class="rule-row" draggable="true" data-drag="${i}">
      <span class="drag-handle" title="拖动排序">⋮⋮</span>
      <span class="idx">${i + 1}</span>
      <div class="rule-row-main">
        <div class="row">
          <span class="rule-name">${esc(r.name || r.id)}</span>
          ${(r.inline && r.inline.length) ? '<span class="badge amber">自定义</span>' : `<span class="badge gray mono">${esc(r.id)}</span>`}
          ${(r.inline && r.inline.length) ? `<span class="hint mono">${esc(r.inline[0])}${r.inline.length > 1 ? ` 等 ${r.inline.length} 条` : ''}</span>` : ''}
        </div>
        <div class="row" style="margin-top:6px">
          <span class="hint">分组</span>
          <select class="select small" data-rule-group="${i}">${groupSelect(r.group)}</select>
          <label class="check"><input type="checkbox" data-rule-noresolve="${i}" ${r.noResolve ? 'checked' : ''}> no-resolve</label>
        </div>
      </div>
      <div class="row" style="margin-left:auto">
        <button class="btn small ghost" data-act="layer-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small ghost" data-act="layer-down" data-i="${i}" ${i === selected.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn small ghost danger" data-act="layer-del" data-i="${i}">✕</button>
      </div>
    </div>`).join('');
  return `
    <div class="grid-2">
      <div class="field">
        <label>模板</label>
        <select class="select" data-bind="template">${templateOptions(c.template)}</select>
      </div>
      <div class="field">
        <label>基础配置 / DNS</label>
        <div class="row">
          <select class="select" data-layer="base" style="flex:1"><option value="">基础：模板自带</option>${layerOptions('base', c.baseId)}</select>
          <select class="select" data-layer="dns" style="flex:1"><option value="">DNS：模板自带</option>${layerOptions('dns', c.dnsId)}</select>
        </div>
      </div>
    </div>
    <div class="field">
      <label>搜索规则集 <span class="badge amber">推荐</span> <span class="hint">共 ${(state.status.catalog && state.status.catalog.count) || 2183} 条官方规则集</span></label>
      <div class="row">
        <input class="input" id="rule-search" data-bind="ruleQ" placeholder="Netflix、Google、Steam、Telegram…" value="${esc(c.ruleQ || '')}" style="flex:1">
        <button class="btn small ghost" data-act="go-library">资源库</button>
      </div>
      <div class="rule-results" id="rule-results">${renderRuleResults()}</div>
      ${c.ruleTotal > c.ruleItems.length ? `<div class="hint">共 ${c.ruleTotal} 条匹配，显示前 ${c.ruleItems.length} 条</div>` : ''}
    </div>
    <div class="field">
      <label>已选规则集 <span class="badge gray">${selected.length}</span></label>
      ${selected.length ? `<div class="rule-list">${rows}</div>` : '<div class="empty small">还没有规则集。搜索后点「＋ 添加」，或在下方手动添加规则。</div>'}
    </div>
    <div class="field">
      <label>手动添加规则 <span class="hint">按顺序插到规则集之后</span></label>
      <div class="row">
        <select class="select small" id="custom-rule-type">${RULE_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
        <input class="input" id="custom-rule-value" placeholder="google.com" style="flex:1">
        <select class="select small" id="custom-rule-group">${groupSelect(c.ruleGroup || currentGroupNames()[0])}</select>
        <label class="check"><input type="checkbox" id="custom-rule-noresolve"> no-resolve</label>
        <button class="btn small" data-act="custom-rule-add">添加规则</button>
      </div>
    </div>`;
}

function refreshRuleResults() {
  const box = $('#rule-results');
  if (box) box.innerHTML = renderRuleResults();
}

async function searchRules(q) {
  const c = state.convert;
  if (!String(q || '').trim()) {
    c.ruleItems = [];
    c.ruleTotal = 0;
    c.ruleQ = '';
    refreshRuleResults();
    return;
  }
  c.ruleLoading = true;
  refreshRuleResults();
  try {
    const params = new URLSearchParams({ limit: '12' });
    if (q) params.set('q', q);
    const data = await api(`/api/rules?${params.toString()}`);
    c.ruleItems = data.items || [];
    c.ruleTotal = data.total || 0;
  } catch (e) {
    c.ruleItems = [];
    c.ruleTotal = 0;
    toast(e.message || '搜索规则集失败', 'err');
  } finally {
    c.ruleLoading = false;
    refreshRuleResults();
  }
}

function renderOutputBody(c) {
  const targets = state.status.targets || [];
  return `
    <div class="target-grid">
      ${targets.map((t) => `
        <button class="target-chip ${c.target === t.id ? 'active' : ''}" data-act="pick-target" data-id="${esc(t.id)}">
          <span class="t-dot" style="background:${esc(t.accent || '#6d7dff')}"></span>
          <span class="t-label">${esc(t.label)}</span>
          <span class="t-sub">${esc(t.subtitle || '')}</span>
        </button>`).join('')}
    </div>
    <div class="row" style="margin-top:14px">
      <button class="btn primary" data-act="convert">${state.busy ? '<span class="spinner"></span>' : '⇄'} 转换预览</button>
      <button class="btn cyan" data-act="make-link">🔗 临时链接</button>
      <button class="btn ghost" data-act="save-as-profile">＋ 保存为订阅</button>
      <label class="check"><input type="checkbox" data-preview-live ${c.live ? 'checked' : ''}> 自动预览</label>
    </div>`;
}

function structureOfPreview() {
  const body = state.preview.body || '';
  const target = targetById(state.convert.target);
  const out = { groups: [], rules: [], outbounds: [] };
  if (!body) return out;
  if (target && target.engine === 'singbox') {
    try {
      const conf = JSON.parse(body);
      out.outbounds = (conf.outbounds || []).map((o) => ({ name: o.tag || '', type: o.type || '' }));
      out.rules = ((conf.route && conf.route.rules) || []).map((r, i) => `${i + 1}. ${JSON.stringify(r)}`);
      return out;
    } catch { /* 落到文本解析 */ }
  }
  const lines = body.split(/\r?\n/);
  let section = '';
  let cur = null;
  for (const line of lines) {
    const top = line.match(/^([A-Za-z][A-Za-z0-9_-]*):/);
    if (top) section = top[1];
    if (section === 'proxy-groups' && /^\s{2}- name:/.test(line)) {
      cur = { name: line.replace(/^\s{2}- name:\s*/, '').replace(/^['"]|['"]$/g, ''), type: '', proxies: [] };
      out.groups.push(cur);
      continue;
    }
    if (cur && /^\s{4}type:/.test(line)) {
      cur.type = line.replace(/^\s{4}type:\s*/, '').trim();
      continue;
    }
    if (cur && /^\s{6}- /.test(line)) {
      cur.proxies.push(line.replace(/^\s{6}- /, '').replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (section === 'rules' && /^\s{2}- /.test(line)) {
      out.rules.push(line.replace(/^\s{2}- /, ''));
    }
  }
  return out;
}

function groupTone(name) {
  const n = String(name || '');
  if (/广告|拦截|净化/.test(n)) return 'tone-red';
  if (/节点选择|手动/.test(n)) return 'tone-accent';
  if (/自动|故障|负载|延迟/.test(n)) return 'tone-green';
  if (/直连|国内|局域网/.test(n)) return 'tone-blue';
  if (/奈飞|Netflix|流媒体|视频|YouTube/i.test(n)) return 'tone-pink';
  if (/电报|Telegram|社交/i.test(n)) return 'tone-sky';
  if (/AI|人工智能|OpenAI|Claude/i.test(n)) return 'tone-violet';
  if (/苹果|微软|谷歌|服务/i.test(n)) return 'tone-slate';
  if (/游戏|下载/.test(n)) return 'tone-amber';
  return 'tone-dim';
}

function renderPreviewStructure() {
  const s = structureOfPreview();
  const c = state.convert;
  const draft = strategyDraft();
  const groups = (draft && draft.groups && draft.groups.length)
    ? draft.groups.map((g) => ({
      name: g.name,
      type: g.type,
      proxies: (g.type === 'select' ? g.refs : g.patterns) || [],
      enabled: g.enabled !== false,
    }))
    : s.groups;
  const groupCards = groups.length
    ? groups.map((g, i) => `
      <div class="struct-group ${groupTone(g.name)} ${g.enabled === false ? 'is-off' : ''}">
        <div class="row">
          <span class="tone-dot"></span>
          <b>${esc(g.name)}</b><span class="badge gray">${esc(g.type || '')}</span>
          <span class="hint">${g.proxies.length} 个成员</span>
          ${draft ? `<label class="switch" title="启用/停用"><input type="checkbox" data-strat-on="${i}" ${g.enabled === false ? '' : 'checked'}><span></span></label>` : ''}
        </div>
        <div class="struct-members">${g.proxies.slice(0, 12).map((p) => `<span class="chip-sm">${esc(p)}</span>`).join('')}${g.proxies.length > 12 ? `<span class="chip-sm">+${g.proxies.length - 12}</span>` : ''}</div>
      </div>`).join('')
    : '';
  const outbounds = s.outbounds.length
    ? `<div class="struct-group"><b>出站（${s.outbounds.length}）</b><div class="struct-members">${s.outbounds.slice(0, 40).map((o) => `<span class="chip-sm">${esc(o.name)} <em>${esc(o.type)}</em></span>`).join('')}</div></div>`
    : '';
  const quickRules = (c.rules && c.rules.length)
    ? `<div class="struct-group">
        <div class="row"><b>分流规则（可调）</b><span class="hint">这里调整分组/顺序，左侧同步</span></div>
        <div class="struct-rules">
          ${c.rules.map((r, i) => `
            <div class="struct-rule quick-rule">
              <span class="idx">${i + 1}</span>
              <span class="mono name">${esc(r.name || r.id)}</span>
              <select class="select tiny" data-prev-rule-group="${i}">${groupSelect(r.group)}</select>
              <button class="btn small ghost" data-act="preview-rule-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn small ghost" data-act="preview-rule-down" data-i="${i}" ${i === c.rules.length - 1 ? 'disabled' : ''}>↓</button>
            </div>`).join('')}
        </div>
      </div>`
    : '';
  const rules = s.rules.length
    ? `<div class="struct-group"><div class="row"><b>最终规则（${s.rules.length}）</b><button class="btn small ghost" data-act="edit-rules" style="margin-left:auto">调整模板规则</button></div>
       <div class="struct-rules">${s.rules.slice(0, 120).map((r, i) => `<div class="struct-rule"><span class="idx">${i + 1}</span><span class="mono">${esc(r)}</span></div>`).join('')}${s.rules.length > 120 ? '<div class="hint">仅显示前 120 条</div>' : ''}</div></div>`
    : '';
  return `<div class="struct-wrap">${groupCards}${outbounds}${quickRules}${rules}</div>`;
}

/* 轻量语法高亮（YAML / JSON / Surge），不依赖第三方库 */
function syntaxHighlight(text) {
  const src = String(text || '');
  const re = /#[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\b[A-Za-z_][\w.-]*(?=\s*:)|\b\d+(?:\.\d+)?\b|\b(?:true|false|null)\b|^[ \t]*-(?=\s)/gm;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    out += esc(src.slice(last, m.index));
    const tok = m[0];
    let cls;
    if (tok.startsWith('#')) cls = 'syn-com';
    else if (tok[0] === '"' || tok[0] === "'") cls = 'syn-str';
    else if (tok.trim() === '-') cls = 'syn-dash';
    else if (/^(true|false|null)$/.test(tok)) cls = 'syn-bool';
    else if (/^\d/.test(tok)) cls = 'syn-num';
    else cls = 'syn-key';
    out += `<span class="${cls}">${esc(tok)}</span>`;
    last = m.index + tok.length;
  }
  out += esc(src.slice(last));
  return out;
}

const PREVIEW_MAX_LINES = 1500;

function renderPreviewCode(body) {
  const lines = String(body || '').split('\n');
  const shown = lines.slice(0, PREVIEW_MAX_LINES);
  const html = shown.map((line, i) => `<div class="cl"><span class="ln">${i + 1}</span><span class="lc">${syntaxHighlight(line) || ' '}</span></div>`).join('');
  const more = lines.length > PREVIEW_MAX_LINES
    ? `<div class="cl more"><span class="ln">…</span><span class="lc">还有 ${lines.length - PREVIEW_MAX_LINES} 行未展开，可复制或下载查看完整配置</span></div>`
    : '';
  return `<div class="preview-code">${html}${more}</div>`;
}

function renderPreview() {
  const p = state.preview;
  const target = targetById(state.convert.target) || { label: '—' };
  let content;
  if (p.error) content = `<div class="preview-error">${esc(p.error)}</div>`;
  else if (p.loading && !p.body) content = '<div class="empty small"><span class="spinner"></span> 正在生成预览…</div>';
  else if (!p.body) content = '<div class="empty small">填写来源后点「转换预览」；开启自动预览时修改模板、DNS、规则集也会自动刷新。</div>';
  else if (p.tab === 'structure') content = renderPreviewStructure();
  else content = renderPreviewCode(p.body);
  return `
    <div class="preview-panel" id="preview-panel">
      <div class="preview-head">
        <div class="row"><span class="preview-title">实时预览</span><span class="badge">${esc(target.label || '')}</span></div>
        <button class="btn small ghost" data-act="preview-refresh">刷新</button>
      </div>
      <div class="tabs" style="margin:10px 0">
        <button class="tab ${p.tab === 'config' ? 'active' : ''}" data-act="preview-tab" data-tab="config">配置文件</button>
        <button class="tab ${p.tab === 'structure' ? 'active' : ''}" data-act="preview-tab" data-tab="structure">可视化预览</button>
      </div>
      <div class="preview-body">${content}</div>
      <div class="preview-foot">
        <span>节点 <b>${p.nodes || 0}</b></span>
        <span>${fmtBytes(p.bytes || 0)}</span>
        <span>${p.ms || 0} ms</span>
        ${trafficLabel(p.userinfo) ? `<span class="badge green" title="订阅流量">${esc(trafficLabel(p.userinfo))}</span>` : ''}
        ${p.warnings && p.warnings.length ? `<span class="badge amber" title="${esc(p.warnings.join('；'))}">提示 ${p.warnings.length}</span>` : ''}
        <div class="row" style="margin-left:auto">
          <button class="btn small ghost" data-act="preview-copy" ${p.body ? '' : 'disabled'}>复制</button>
          <button class="btn small ghost" data-act="preview-download" ${p.body ? '' : 'disabled'}>下载</button>
        </div>
      </div>
    </div>`;
}

function refreshPreviewDom() {
  const old = $('#preview-panel');
  if (!old) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = renderPreview();
  old.replaceWith(wrap.firstElementChild);
}

function renderOptionsBody(c) {
  return `
    <div class="grid-2">
      <div class="field"><label>仅保留节点</label><input class="input" data-bind="include" placeholder="香港,日本" value="${esc(c.include)}"></div>
      <div class="field"><label>排除节点</label><input class="input" data-bind="exclude" placeholder="过期,剩余" value="${esc(c.exclude)}"></div>
    </div>
    <div class="row" style="margin-top:14px">
      <label class="check"><input type="checkbox" data-opt="emoji" ${c.opts.emoji ? 'checked' : ''}> 节点名 Emoji</label>
      <label class="check"><input type="checkbox" data-opt="udp" ${c.opts.udp ? 'checked' : ''}> 开启 UDP</label>
      <label class="check"><input type="checkbox" data-opt="tfo" ${c.opts.tfo ? 'checked' : ''}> TCP Fast Open</label>
      <label class="check"><input type="checkbox" data-opt="scv" ${c.opts.scv ? 'checked' : ''}> 跳过证书校验</label>
      <label class="check"><input type="checkbox" data-opt="sort" ${c.opts.sort ? 'checked' : ''}> 按名称排序</label>
    </div>`;
}

function renderConvert() {
  const c = state.convert;
  const draft = strategyDraft();
  const blockCount = (String(c.sources || '').trim() ? 1 : 0) + (c.blocks || []).length;
  return `
    <div class="convert-layout">
      <div class="convert-main">
        ${cardBlock('import', {
    title: '节点导入',
    desc: '订阅链接、YAML/JS 配置或节点链接，按需添加。',
    badge: blockCount ? `${blockCount} 个来源` : '',
    body: renderImportCard(c),
  })}
        ${cardBlock('nodes', {
    title: '节点管理',
    desc: '已解析的节点，支持搜索、批量改名/替换/删除与手动编辑。',
    badge: String(c.nodes.length),
    actions: '',
    body: renderNodePanel(c),
  })}
        ${cardBlock('strategy', {
    title: '分流策略组',
    desc: draft ? '修改模板自带的分组、成员与启用状态，转换时会询问如何保存。' : '登录管理员账号后可在这里调整分组。',
    badge: draft && draft.dirty ? '已修改' : '',
    body: renderStrategyBody(),
  })}
        ${cardBlock('rules', {
    title: '分流规则',
    desc: '从官方规则集里搜索添加（按顺序插到 FINAL 前），也可以手动写规则。',
    badge: `${c.rules.length} 条`,
    body: renderRulesBody(c),
  })}
      </div>
      <div class="convert-side">
        ${renderPreview()}
        ${cardBlock('output', {
    title: '输出格式',
    desc: '选择客户端，生成配置或订阅链接。',
    body: renderOutputBody(c),
  })}
      </div>
    </div>
    ${state.link ? renderLinkResult() : ''}
  `;
}

function renderLinkResult() {
  const url = state.link;
  return `
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">临时链接</div>
          <p class="card-desc">参数全部编码在链接中，不会保存到服务器；修改参数后旧链接依然有效。</p>
        </div>
      </div>
      <div class="link-row">
        <div class="link-url" style="white-space:normal;word-break:break-all">${esc(url)}</div>
        <button class="btn small" data-act="copy" data-copy="${esc(url)}">复制</button>
        <button class="btn small" data-act="qr-link">二维码</button>
      </div>
    </div>
  `;
}

/* ── 视图：固定订阅 ───────────────────────────────────────── */
async function ensureProfiles() {
  state.profileError = null;
  if (!state.auth.admin) return;
  try {
    const data = await api('/api/profiles', { admin: true });
    state.profiles = data.profiles || [];
  } catch (e) {
    state.profiles = [];
    state.profileError = e;
  }
}

function renderProfiles() {
  const s = state.status;
  if (!state.auth.user) {
    return `
      <div class="card">
        <div class="card-title">登录后管理订阅</div>
        <p class="card-desc">保存订阅需要账号登录，登录后上游地址不会出现在分享链接里。</p>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-act="auth-open">登录 / 注册</button>
        </div>
      </div>
    `;
  }
  if (state.profileError) {
    const e = state.profileError;
    return `
      <div class="card">
        <div class="card-title">无法读取订阅</div>
        <p class="card-desc">${esc(e.message || '接口不可用')}</p>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-act="auth-open">检查登录状态</button>
          <button class="btn ghost" data-act="profiles-refresh">重试</button>
        </div>
      </div>
    `;
  }
  if (!state.auth.admin) {
    return `
      <div class="card">
        <div class="card-title">订阅需要管理员权限</div>
        <p class="card-desc">当前账号是普通用户，订阅管理仅对管理员开放。可以用管理员账号登录，或在「系统 → 账号管理」中把该账号提升为管理员。</p>
        <div class="row" style="margin-top:12px"><button class="btn primary" data-act="auth-open">切换账号</button></div>
      </div>
    `;
  }

  const list = state.profiles;
  return `
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">订阅</div>
          <p class="card-desc">每条订阅拥有独立 token；更换机场或模板不会改变客户端里的链接。</p>
        </div>
        <div class="row">
          <button class="btn ghost small" data-act="profiles-refresh">刷新</button>
          <button class="btn primary" data-act="profile-new">＋ 新建订阅</button>
        </div>
      </div>
      ${list.length ? list.map(renderProfileCard).join('') : `
        <div class="empty">
          <div class="e-icon">◈</div>
          <div class="e-title">还没有订阅</div>
          <div class="e-desc">新建一条，把上游订阅藏进 token 链接里。</div>
        </div>
      `}
    </div>
  `;
}

function renderProfileCard(p) {
  const targets = state.status.targets || [];
  const links = p.links || {};
  const rows = targets.map((t) => {
    const url = links[t.id] || '';
    return `
      <div class="link-row">
        <div class="link-label">${esc(t.label)}</div>
        <div class="link-url" title="${esc(url)}">${esc(url)}</div>
        <button class="btn small ghost" data-act="copy" data-copy="${esc(url)}" title="复制">复制</button>
        <button class="btn small ghost" data-act="qr" data-qr="${esc(url)}" data-title="${esc(p.name + ' · ' + t.label)}" title="二维码">▦</button>
      </div>
    `;
  }).join('');

  return `
    <div class="profile-card">
      <div class="profile-head">
        <div>
          <div class="row">
            <span class="profile-name">${esc(p.name)}</span>
            <span class="badge">${esc(p.template)}</span>
            <span class="badge gray">rev ${p.revision}</span>
            ${p.enabled === false ? '<span class="badge red">已停用</span>' : ''}
            ${p.allowedTargets && p.allowedTargets.length ? `<span class="badge amber">限定 ${p.allowedTargets.length} 种格式</span>` : ''}
          </div>
          <div class="small faint" style="margin-top:4px">
            token <span class="mono">${esc(p.token.slice(0, 4))}…${esc(p.token.slice(-3))}</span>
            · ${p.sources.length} 个源 · ${p.updateInterval} 小时更新 · 缓存 ${p.cacheTtl == null ? '默认' : p.cacheTtl + 's'}
            ${p.note ? ` · ${esc(p.note)}` : ''}
          </div>
        </div>
        <div class="row">
          <button class="btn small ghost" data-act="profile-test" data-token="${esc(p.token)}">自检</button>
          <button class="btn small ghost" data-act="profile-edit" data-token="${esc(p.token)}">编辑</button>
          <button class="btn small ghost" data-act="copy" data-copy="${esc(links.auto || '')}">自动链接</button>
          <button class="btn small danger" data-act="profile-del" data-token="${esc(p.token)}">删除</button>
        </div>
      </div>
      <details style="margin-top:10px">
        <summary class="small muted" style="cursor:pointer">全部格式链接（${targets.length}）</summary>
        <div class="link-list">${rows}</div>
      </details>
    </div>
  `;
}

/* ── 订阅编辑弹窗 ─────────────────────────────────────────── */
function openProfileModal(token, preset) {
  const existing = token ? state.profiles.find((p) => p.token === token) : null;
  const src = existing || {
    name: '',
    note: '',
    sources: [],
    template: state.convert.template,
    allowedTargets: [],
    allowTargetOverride: false,
    include: '',
    exclude: '',
    opts: { emoji: true, udp: true, tfo: false, scv: true, sort: false },
    updateInterval: 6,
    cacheTtl: null,
    enabled: true,
    ...(preset || {}),
  };

  const targetPills = (state.status.targets || []).map((t) => `
    <label class="pill-check">
      <input type="checkbox" name="allowedTargets" value="${esc(t.id)}" ${(src.allowedTargets || []).includes(t.id) ? 'checked' : ''}>
      ${esc(t.label)}
    </label>
  `).join('');

  const srcRules = (src.rulesets || []).map((x) => (typeof x === 'string' ? { id: x } : x));
  const srcRuleIds = srcRules.map((r) => r.id);
  const libRules = libraryOf('ruleset');
  const libIds = new Set(libRules.map((r) => r.id));
  const extraRules = srcRules.filter((r) => r.id && !libIds.has(r.id));

  openModal(`
    <h3>${existing ? '编辑订阅' : '新建订阅'}</h3>
    <p class="modal-desc">订阅链接只暴露 token；上游地址、模板与过滤规则都保存在服务端。</p>
    <form id="profile-form" autocomplete="off">
      <div class="grid-2">
        <div class="field">
          <label>名称</label>
          <input class="input" name="name" value="${esc(src.name)}" placeholder="例如：主力机场" required>
        </div>
        <div class="field">
          <label>备注（可选）</label>
          <input class="input" name="note" value="${esc(src.note || '')}" placeholder="给自己看的说明">
        </div>
      </div>
      <div class="field" style="margin-top:12px">
        <label>上游订阅（每行一个，可留空改用自定义节点）</label>
        <textarea class="textarea" name="sources" rows="3" placeholder="https://example.com/api/v1/client/subscribe?token=...">${esc((src.sources || []).join('\n'))}</textarea>
      </div>
      <div class="field" style="margin-top:12px">
        <label>自定义节点（JSON 数组，可选）</label>
        <textarea class="textarea mono" name="nodes" rows="4" placeholder='[{"name":"HK 01","type":"vless","server":"example.com","port":443,"uuid":"..."}]'>${esc(src.nodes && src.nodes.length ? JSON.stringify(src.nodes, null, 2) : '')}</textarea>
        <div class="hint">与上游订阅二选一或并存；节点会直接写进配置。</div>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <div class="field">
          <label>转换模板</label>
          <select class="select" name="template">${templateOptions(src.template)}</select>
        </div>
        <div class="field">
          <label>更新间隔（小时）</label>
          <input class="input" name="updateInterval" type="number" min="1" max="168" value="${src.updateInterval}">
        </div>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <div class="field">
          <label>基础配置（叠加）</label>
          <select class="select" name="baseId"><option value="">不使用</option>${layerOptions('base', src.baseId || '')}</select>
        </div>
        <div class="field">
          <label>DNS 配置（叠加）</label>
          <select class="select" name="dnsId"><option value="">不使用</option>${layerOptions('dns', src.dnsId || '')}</select>
        </div>
      </div>
      <div class="field" style="margin-top:12px">
        <label>规则集（可多选）</label>
        <div class="target-pills">
          ${libRules.map((r) => `
            <label class="pill-check">
              <input type="checkbox" name="rulesets" value="${esc(r.id)}" ${srcRuleIds.includes(r.id) ? 'checked' : ''}>
              ${esc(r.name)}
            </label>`).join('')}
          ${extraRules.map((r) => `
            <label class="pill-check">
              <input type="checkbox" name="rulesets" value="${esc(r.id)}" checked>
              ${esc(r.id)}${r.group ? ` · ${esc(r.group)}` : ''}
            </label>`).join('')}
          ${!libRules.length && !extraRules.length ? '<span class="hint">资源库里还没有规则集。</span>' : ''}
        </div>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <div class="field">
          <label>仅保留节点（逗号分隔）</label>
          <input class="input" name="include" value="${esc(src.include || '')}" placeholder="香港,日本">
        </div>
        <div class="field">
          <label>排除节点（逗号分隔）</label>
          <input class="input" name="exclude" value="${esc(src.exclude || '')}" placeholder="过期,剩余流量">
        </div>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <div class="field">
          <label>缓存时间（秒，留空用全局默认）</label>
          <input class="input" name="cacheTtl" type="number" min="0" max="86400" value="${src.cacheTtl == null ? '' : src.cacheTtl}" placeholder="例如 300">
        </div>
        <div class="field">
          <label>客户端格式限制</label>
          <div class="hint">不勾选 = 全部开放</div>
        </div>
      </div>
      <div class="target-pills" style="margin-top:8px">${targetPills}</div>
      <div class="row" style="margin-top:12px">
        <label class="check"><input type="checkbox" name="allowTargetOverride" ${src.allowTargetOverride ? 'checked' : ''}> 允许用 ?target= 覆盖格式</label>
        <label class="check"><input type="checkbox" name="enabled" ${src.enabled === false ? '' : 'checked'}> 启用</label>
      </div>
      <div class="row" style="margin-top:12px">
        <label class="check"><input type="checkbox" name="opt-emoji" ${src.opts.emoji !== false ? 'checked' : ''}> Emoji</label>
        <label class="check"><input type="checkbox" name="opt-udp" ${src.opts.udp !== false ? 'checked' : ''}> UDP</label>
        <label class="check"><input type="checkbox" name="opt-tfo" ${src.opts.tfo ? 'checked' : ''}> TFO</label>
        <label class="check"><input type="checkbox" name="opt-scv" ${src.opts.scv !== false ? 'checked' : ''}> 跳过证书校验</label>
        <label class="check"><input type="checkbox" name="opt-sort" ${src.opts.sort ? 'checked' : ''}> 排序</label>
      </div>
    </form>
    <div class="modal-foot">
      <button class="btn ghost" data-act="modal-close">取消</button>
      <button class="btn primary" id="profile-save">${existing ? '保存修改' : '创建订阅'}</button>
    </div>
  `, { narrow: false });

  $('#profile-save').addEventListener('click', async () => {
    const form = $('#profile-form');
    const el = (n) => form.elements.namedItem(n);
    const body = {
      name: el('name').value.trim(),
      note: el('note').value.trim(),
      sources: parseSources(el('sources').value),
      nodes: (() => {
        const raw = (el('nodes').value || '').trim();
        if (!raw) return [];
        try {
          const arr = JSON.parse(raw);
          return Array.isArray(arr) ? arr : [];
        } catch {
          throw new Error('自定义节点不是合法 JSON 数组');
        }
      })(),
      baseId: el('baseId').value,
      dnsId: el('dnsId').value,
      rulesets: $$('input[name=rulesets]:checked', form).map((x) => {
        const found = srcRules.find((r) => r.id === x.value);
        if (!found) return x.value;
        const out = { id: found.id };
        if (found.group) out.group = found.group;
        if (found.noResolve) out.noResolve = true;
        if (found.inline && found.inline.length) out.inline = found.inline;
        return out;
      }),
      template: el('template').value,
      allowedTargets: $$('input[name=allowedTargets]:checked', form).map((x) => x.value),
      allowTargetOverride: el('allowTargetOverride').checked,
      enabled: el('enabled').checked,
      include: el('include').value.trim(),
      exclude: el('exclude').value.trim(),
      updateInterval: Number(el('updateInterval').value) || 6,
      cacheTtl: el('cacheTtl').value === '' ? null : Number(el('cacheTtl').value),
      opts: {
        emoji: el('opt-emoji').checked,
        udp: el('opt-udp').checked,
        tfo: el('opt-tfo').checked,
        scv: el('opt-scv').checked,
        sort: el('opt-sort').checked,
      },
    };
    if (!body.sources.length && !body.nodes.length) {
      return toast('请填写上游订阅或自定义节点', 'err');
    }
    const btn = $('#profile-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 保存中';
    try {
      if (existing) await api(`/api/profiles/${encodeURIComponent(existing.token)}`, { method: 'PUT', body, admin: true });
      else await api('/api/profiles', { method: 'POST', body, admin: true });
      closeModal();
      toast(existing ? '订阅已更新' : '订阅已创建');
      await ensureProfiles();
      render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = existing ? '保存修改' : '创建订阅';
      toast(e.message || '保存失败', 'err');
    }
  });
}

/* ── 订阅自检 ─────────────────────────────────────────────── */
function openProfileTest(token) {
  const p = state.profiles.find((x) => x.token === token);
  if (!p) return;
  openModal(`
    <h3>自检 · ${esc(p.name)}</h3>
    <p class="modal-desc">依次向引擎请求 5 种客户端格式，检查模板与源是否可用。</p>
    <div id="test-body"><span class="spinner"></span> 正在测试，首次转换可能需要几秒…</div>
    <div class="modal-foot"><button class="btn" data-act="modal-close">关闭</button></div>
  `);
  api(`/api/profiles/${encodeURIComponent(token)}/test`, { method: 'POST', admin: true })
    .then((data) => {
      const rows = (data.results || []).map((r) => `
        <tr>
          <td>${esc(r.label)}</td>
          <td>${r.ok ? '<span class="badge green">通过</span>' : '<span class="badge red">失败</span>'}</td>
          <td>${r.ok ? `${r.nodes} 节点 · ${fmtBytes(r.bytes)}` : esc(r.error)}</td>
          <td class="faint">${r.ms} ms</td>
        </tr>
      `).join('');
      const box = $('#test-body');
      if (box) box.innerHTML = `<table class="table"><thead><tr><th>客户端</th><th>状态</th><th>结果</th><th>耗时</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .catch((e) => {
      const box = $('#test-body');
      if (box) box.innerHTML = `<div class="notice">${esc(e.message)}</div>`;
    });
}

/* ── 视图：模板 ───────────────────────────────────────────── */
function renderTemplates() {
  const list = state.templates || [];
  const editor = state.editor;
  return `
    <div class="editor-layout">
      <div class="editor-side card">
        <div class="card-head">
          <div class="card-title">模板库</div>
          <button class="btn small primary" data-act="template-new">＋ 新建</button>
        </div>
        ${list.map((t) => `
          <div class="tpl-item ${editor && editor.name === t.name ? 'active' : ''}" data-act="template-open" data-name="${esc(t.name)}">
            <div class="row between">
              <span class="t-name">${esc(t.title)}</span>
              <span class="badge gray">${esc(t.name)}</span>
            </div>
            <div class="t-desc">${esc(t.description || '暂无描述')}</div>
            <div class="small faint" style="margin-top:4px">${t.groups} 组 · ${t.rules} 条规则 · ${fmtBytes(t.bytes)}</div>
          </div>
        `).join('') || '<div class="empty small">还没有模板</div>'}
      </div>
      <div>${editor ? renderTemplateEditor(editor) : `
        <div class="card">
          <div class="empty">
            <div class="e-icon">☰</div>
            <div class="e-title">选择一个模板开始编辑</div>
            <div class="e-desc">左侧是内置模板；也可以新建一个自己的。</div>
          </div>
        </div>
      `}</div>
    </div>
  `;
}

function renderTemplateEditor(editor) {
  const model = editor.model;
  const admin = state.auth.admin;
  const tabs = `
    <div class="tabs">
      <button class="tab ${editor.mode === 'visual' ? 'active' : ''}" data-act="template-mode" data-mode="visual">可视化</button>
      <button class="tab ${editor.mode === 'raw' ? 'active' : ''}" data-act="template-mode" data-mode="raw">原始 ini</button>
      <button class="tab ${editor.mode === 'preview' ? 'active' : ''}" data-act="template-mode" data-mode="preview">预览</button>
    </div>
  `;

  let body = '';
  if (editor.mode === 'raw') {
    body = `
      <div class="field" style="margin-top:14px">
        <label>subconverter ini 文本</label>
        <textarea class="textarea code" id="raw-ini" data-raw rows="22" spellcheck="false">${esc(editor.content)}</textarea>
        <div class="hint">直接编辑会出现语法错误风险；保存前建议先用「可视化」核对。</div>
      </div>
    `;
  } else if (editor.mode === 'preview') {
    const pv = editor.preview;
    body = `
      <div style="margin-top:14px">
        ${pv ? `
          <div class="result-meta">
            <span>客户端 <b>${esc(targetById(pv.target).label)}</b></span>
            <span>节点 <b>${pv.nodes}</b></span>
            <span>大小 <b>${fmtBytes(pv.bytes)}</b></span>
            <span>耗时 <b>${pv.ms} ms</b></span>
          </div>
          <div class="code-block" style="max-height:520px"><pre>${esc(pv.body || '')}</pre></div>
        ` : `
          <div class="empty">
            <div class="e-icon">▷</div>
            <div class="e-title">还没有预览</div>
            <div class="e-desc">用「订阅转换」页填写的源跑一次转换，检查模板输出。</div>
          </div>
        `}
      </div>
    `;
  } else {
    body = renderVisualEditor(model);
  }

  return `
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">${esc(model.meta.title || editor.name)}</div>
          <div class="small faint">${esc(editor.name)}.ini · ${model.groups.length} 个策略组 · ${model.rules.length} 条规则${editor.dirty ? ' · <span style="color:#fcd34d">未保存</span>' : ''}</div>
        </div>
        <div class="row">${tabs}</div>
      </div>
      ${!admin ? '<div class="notice" style="margin-bottom:12px">当前未授权，只能查看；保存与预览需要登录管理员账号。</div>' : ''}
      ${body}
      <div class="row" style="margin-top:18px">
        <button class="btn primary" data-act="template-save" ${!admin ? 'disabled' : ''}>保存模板</button>
        <button class="btn" data-act="template-preview" ${!admin ? 'disabled' : ''}>用当前源预览</button>
        <button class="btn ghost" data-act="template-save-as" ${!admin ? 'disabled' : ''}>另存为</button>
        <button class="btn danger" data-act="template-del" ${!admin ? 'disabled' : ''}>删除</button>
        <span class="small faint" style="margin-left:auto">模板变更会自动使订阅缓存失效</span>
      </div>
    </div>
  `;
}

function renderVisualEditor(model) {
  const groupNames = model.groups.map((g) => g.name).filter(Boolean);
  return `
    <div class="card" style="margin-top:14px;background:rgba(255,255,255,.02)">
      <div class="card-head"><div class="card-title">基础信息</div></div>
      <div class="grid-2">
        <div class="field">
          <label>模板名称（标题）</label>
          <input class="input" data-meta="title" value="${esc(model.meta.title || '')}">
        </div>
        <div class="field">
          <label>作者 / 版本（可选）</label>
          <div class="row">
            <input class="input" data-meta="author" placeholder="作者" value="${esc(model.meta.author || '')}" style="flex:1">
            <input class="input" data-meta="version" placeholder="版本" value="${esc(model.meta.version || '')}" style="width:90px">
          </div>
        </div>
      </div>
      <div class="field" style="margin-top:12px">
        <label>描述</label>
        <input class="input" data-meta="description" value="${esc(model.meta.description || '')}">
      </div>
      <div class="field" style="margin-top:12px">
        <label>适用客户端（仅作展示与校验提示）</label>
        <div class="target-pills">
          ${(state.status.targets || []).map((t) => `
            <label class="pill-check">
              <input type="checkbox" data-mt="${esc(t.id)}" ${(model.meta.targets || []).includes(t.id) ? 'checked' : ''}>
              ${esc(t.label)}
            </label>
          `).join('')}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px;background:rgba(255,255,255,.02)">
      <div class="card-head">
        <div>
          <div class="card-title">策略组</div>
          <div class="small faint">手动选择组可以引用其它组（逗号分隔），测速组用正则匹配节点名。</div>
        </div>
        <button class="btn small" data-act="group-add">＋ 添加组</button>
      </div>
      ${model.groups.map((g, i) => renderGroupRow(g, i, groupNames)).join('') || '<div class="empty small">还没有策略组</div>'}
      <datalist id="group-names">${groupNames.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
    </div>

    <div class="card" style="margin-top:14px;background:rgba(255,255,255,.02)">
      <div class="card-head">
        <div>
          <div class="card-title">分流规则</div>
          <div class="small faint">顺序即优先级；FINAL 通常放最后。</div>
        </div>
        <button class="btn small" data-act="rule-add">＋ 添加规则</button>
      </div>
      ${model.rules.map((r, i) => renderRuleRow(r, i, groupNames)).join('') || '<div class="empty small">还没有规则</div>'}
    </div>

    <div class="card" style="margin-top:14px;background:rgba(255,255,255,.02)">
      <div class="card-head"><div class="card-title">其它指令</div></div>
      <div class="field">
        <textarea class="textarea code" data-extras rows="4" spellcheck="false">${esc((model.extras || []).join('\n'))}</textarea>
        <div class="hint">例如 enable_rule_generator=true、overwrite_original_rules=true。</div>
      </div>
    </div>
    ${(model.warnings && model.warnings.length) ? `<div class="notice" style="margin-top:12px">${model.warnings.map(esc).join('<br>')}</div>` : ''}
  `;
}

function renderGroupRow(g, i, groupNames) {
  const type = g.type || 'select';
  return `
    <div class="group-row">
      <div class="g-head">
        <input class="input" data-g="${i}" data-f="name" value="${esc(g.name)}" placeholder="策略组名称">
        <select class="select" data-g="${i}" data-f="type" style="width:130px">
          ${GROUP_TYPES.map(([v, label]) => `<option value="${v}" ${type === v ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <button class="icon-btn" data-act="group-up" data-i="${i}" title="上移">↑</button>
        <button class="icon-btn" data-act="group-down" data-i="${i}" title="下移">↓</button>
        <button class="icon-btn danger" data-act="group-del" data-i="${i}" title="删除">✕</button>
      </div>
      ${type === 'select' ? `
        <div class="group-grid">
          <div class="span-2">
            <span class="mini-label">引用组（逗号分隔，可引用 DIRECT / REJECT）</span>
            <input class="input" data-g="${i}" data-f="refs" value="${esc((g.refs || []).join(','))}" placeholder="${esc(groupNames.slice(0, 2).join(','))}" list="group-names">
          </div>
          <div class="span-2">
            <span class="mini-label">节点匹配正则（可选）</span>
            <input class="input" data-g="${i}" data-f="patterns" value="${esc((g.patterns || []).join(','))}" placeholder="例如 香港|HK">
          </div>
        </div>
      ` : `
        <div class="group-grid">
          <div>
            <span class="mini-label">节点匹配正则</span>
            <input class="input" data-g="${i}" data-f="pattern" value="${esc((g.patterns && g.patterns[0]) || '')}" placeholder=".*">
          </div>
          <div class="span-2">
            <span class="mini-label">测速地址</span>
            <input class="input" data-g="${i}" data-f="url" value="${esc(g.url || '')}" placeholder="http://www.gstatic.com/generate_204">
          </div>
          <div>
            <span class="mini-label">间隔 / 容差</span>
            <div class="row" style="flex-wrap:nowrap">
              <input class="input" data-g="${i}" data-f="interval" value="${esc(g.interval || '300')}" style="width:64px">
              <input class="input" data-g="${i}" data-f="tolerance" value="${esc(g.tolerance || '50')}" style="width:64px">
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

function renderRuleRow(r, i, groupNames) {
  const kind = r.kind === 'url' ? 'url' : 'inline';
  const targets = [...groupNames, 'DIRECT', 'REJECT'];
  return `
    <div class="rule-row">
      <div class="r-head">
        <span class="badge gray" style="width:34px;justify-content:center">${i + 1}</span>
        <select class="select" data-r="${i}" data-f="target" style="max-width:220px">
          ${targets.map((n) => `<option value="${esc(n)}" ${n === r.target ? 'selected' : ''}>${esc(n)}</option>`).join('')}
          ${r.target && !targets.includes(r.target) ? `<option value="${esc(r.target)}" selected>${esc(r.target)}</option>` : ''}
        </select>
        <select class="select" data-r="${i}" data-f="kind" style="width:110px">
          <option value="inline" ${kind === 'inline' ? 'selected' : ''}>内联规则</option>
          <option value="url" ${kind === 'url' ? 'selected' : ''}>远程规则集</option>
        </select>
        <button class="icon-btn" data-act="rule-up" data-i="${i}" title="上移">↑</button>
        <button class="icon-btn" data-act="rule-down" data-i="${i}" title="下移">↓</button>
        <button class="icon-btn danger" data-act="rule-del" data-i="${i}" title="删除">✕</button>
      </div>
      ${kind === 'url' ? `
        <input class="input" data-r="${i}" data-f="value" value="${esc(r.value || '')}" placeholder="https://raw.githubusercontent.com/.../rules.list">
      ` : `
        <div class="group-grid" style="grid-template-columns:170px minmax(0,1fr) 120px">
          <select class="select" data-r="${i}" data-f="type">
            ${RULE_TYPES.map((t) => `<option value="${t}" ${String(r.type || '').toUpperCase() === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <input class="input" data-r="${i}" data-f="value" value="${esc(r.value || '')}" placeholder="${String(r.type || '').toUpperCase() === 'FINAL' ? 'FINAL 无需值' : '规则值，例如 openai.com'}">
          <label class="check"><input type="checkbox" data-r="${i}" data-f="noResolve" ${(r.options || []).includes('no-resolve') ? 'checked' : ''}> no-resolve</label>
        </div>
      `}
    </div>
  `;
}

/* ── 模板加载 / 保存 / 预览 ───────────────────────────────── */
async function loadTemplate(name) {
  try {
    const info = await api(`/api/templates/${encodeURIComponent(name)}`);
    state.editor = {
      name: info.name,
      content: info.content,
      model: info.model,
      mode: 'visual',
      inputMode: 'visual',
      preview: null,
      dirty: false,
    };
  } catch (e) {
    toast(e.message || '模板加载失败', 'err');
    state.editor = null;
  }
}

function editorContent() {
  const ed = state.editor;
  if (!ed) return '';
  return ed.inputMode === 'raw' ? ed.content : clientBuildIni(ed.model);
}

async function saveTemplate({ saveAs = false } = {}) {
  const ed = state.editor;
  if (!ed) return;
  const content = editorContent();
  try {
    if (saveAs) {
      openSaveAsModal(content);
      return;
    }
    await api(`/api/templates/${encodeURIComponent(ed.name)}`, {
      method: 'PUT',
      admin: true,
      body: ed.inputMode === 'raw' ? { content } : { model: ed.model },
    });
    const info = await api(`/api/templates/${encodeURIComponent(ed.name)}`);
    ed.content = info.content;
    ed.model = info.model;
    ed.dirty = false;
    toast('模板已保存');
    const data = await api('/api/state', { admin: true });
    state.status = data;
    state.templates = data.templates || [];
    render();
  } catch (e) {
    reportError(e, '保存失败');
  }
}

function openSaveAsModal(content) {
  openModal(`
    <h3>另存为</h3>
    <p class="modal-desc">输入新模板名称，仅支持字母、数字、点、下划线、短横线。</p>
    <div class="field"><label>名称</label><input class="input" id="saveas-name" placeholder="my-template" data-autofocus></div>
    <div class="modal-foot">
      <button class="btn ghost" data-act="modal-close">取消</button>
      <button class="btn primary" id="saveas-ok">保存</button>
    </div>
  `, { narrow: true });
  $('#saveas-ok').addEventListener('click', async () => {
    const name = ($('#saveas-name').value || '').trim();
    if (!name) return toast('请输入模板名称', 'err');
    try {
      await api('/api/templates', { method: 'POST', admin: true, body: { name, content } });
      closeModal();
      toast('已另存为新模板');
      const data = await api('/api/state', { admin: true });
      state.status = data;
      state.templates = data.templates || [];
      location.hash = `#/templates/${encodeURIComponent(name)}`;
    } catch (e) {
      reportError(e, '保存失败');
    }
  });
}

async function previewTemplate() {
  const ed = state.editor;
  if (!ed) return;
  const sources = allSources();
  if (!sources.length) {
    toast('请先在「订阅转换」页填写订阅源', 'err');
    return;
  }
  const content = editorContent();
  ed.mode = 'preview';
  ed.preview = null;
  render();
  try {
    const data = await api('/api/templates/preview', {
      method: 'POST',
      admin: true,
      body: {
        content,
        sources,
        target: state.convert.target,
        opts: state.convert.opts,
      },
    });
    ed.preview = data;
    toast(`预览成功：${data.nodes} 个节点`);
  } catch (e) {
    reportError(e, '预览失败');
  }
  render();
}

/* ── 视图：系统 ───────────────────────────────────────────── */
async function loadLogs() {
  if (!state.auth || !state.auth.admin) return;
  try {
    const data = await api('/api/logs?limit=200', { admin: true });
    state.logs = data.logs || [];
  } catch (e) {
    state.logs = [];
  }
}

function renderSystem() {
  const s = state.status;
  const eng = s.engine || {};
  const cache = (s.stats && s.stats.cache) || {};
  const hitRate = cache.hits + cache.misses > 0 ? Math.round((cache.hits / (cache.hits + cache.misses)) * 100) : 0;
  return `
    <div class="stat-grid">
      <div class="stat"><div class="s-value">${fmtDuration(s.stats.uptime)}</div><div class="s-label">运行时间</div></div>
      <div class="stat"><div class="s-value">${s.stats.profiles}</div><div class="s-label">订阅</div></div>
      <div class="stat"><div class="s-value">${s.stats.templates}</div><div class="s-label">模板</div></div>
      <div class="stat"><div class="s-value">${cache.entries || 0}</div><div class="s-label">缓存条目 · ${fmtBytes(cache.bytes)}</div></div>
      <div class="stat"><div class="s-value">${hitRate}%</div><div class="s-label">缓存命中率（${cache.hits || 0}/${(cache.hits || 0) + (cache.misses || 0)}）</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div>
          <div class="card-title">转换引擎</div>
          <p class="card-desc">subconverter 负责实际转换；网关只做鉴权、模板与缓存。</p>
        </div>
        <button class="btn small" data-act="engine-check">重新检测</button>
      </div>
      <div class="table-wrap">
        <table class="table">
          <tbody>
            <tr><td style="width:160px" class="faint">状态</td><td>${eng.ok ? '<span class="badge green">在线</span>' : eng.ok === false ? '<span class="badge red">离线</span>' : '<span class="badge amber">未知</span>'}</td></tr>
            <tr><td class="faint">版本</td><td class="mono">${esc(eng.version || '—')}</td></tr>
            <tr><td class="faint">最近检测</td><td>${fmtTime(eng.at)}</td></tr>
            ${eng.error ? `<tr><td class="faint">错误</td><td class="small">${esc(eng.error)}</td></tr>` : ''}
            <tr><td class="faint">对外地址</td><td class="mono small">${esc(s.publicBase)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div><div class="card-title">安全与限流</div></div></div>
      <div class="grid-3">
        <div><div class="faint small">匿名转换</div><div>${s.limits.convertPerMinute} 次 / 分钟 / IP</div></div>
        <div><div class="faint small">订阅拉取</div><div>${s.limits.subscribePerMinute} 次 / 分钟 / IP</div></div>
        <div><div class="faint small">私网订阅源</div><div>${s.limits.allowPrivateSources ? '<span class="badge amber">已允许</span>' : '<span class="badge green">已阻止</span>'}</div></div>
      </div>
      <p class="small faint" style="margin:12px 0 0">账号保存在网关的 data/gateway/users.json；推荐通过反向代理启用 HTTPS，并把默认的 admin/admin 改掉。旧的 ADMIN_KEY 仍可作为脚本用的管理凭据。</p>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div><div class="card-title">运行日志</div><div class="small faint">最近 200 条，内存环形缓冲</div></div>
        <div class="row">
          <button class="btn small ghost" data-act="logs-refresh">刷新</button>
          <button class="btn small danger" data-act="cache-clear">清空缓存</button>
        </div>
      </div>
      ${state.logs.length ? `<div class="log-box">${state.logs.map((l) => `
        <div><span class="l-time">${esc(String(l.ts).slice(11, 19))}</span> <span class="l-tag">[${esc(l.tag)}]</span> <span class="${l.tag === 'err' ? 'l-err' : ''}">${esc(l.msg)}</span></div>
      `).join('')}</div>` : '<div class="empty small">暂无日志（或未授权）</div>'}
    </div>
  `;
}

/* ── 账号 ─────────────────────────────────────────────────── */
function renderAccount(status) {
  const user = state.auth.user;
  const avatar = $('#account-avatar');
  const label = $('#account-label');
  const btn = $('#account-btn');
  if (avatar) avatar.textContent = user ? String(user.username || 'U').slice(0, 1).toUpperCase() : '访';
  if (label) label.textContent = user ? user.username : '登录';
  if (btn) btn.title = user ? `${user.username} · ${user.role === 'admin' ? '管理员' : '普通账号'}` : '登录 / 注册';
}

function openAuthModal() {
  if (state.auth.user) return openAccountModal();
  openModal(`
    <h3>登录 SubHub</h3>
    <p class="modal-desc">使用账号登录后可编辑模板、规则与订阅；普通账号可转换与保存自己的订阅。</p>
    <div class="seg auth-tabs">
      <button class="seg-btn active" data-act="auth-tab" data-tab="login">登录</button>
      <button class="seg-btn" data-act="auth-tab" data-tab="register">注册码注册</button>
    </div>
    <div id="auth-pane"></div>
  `, { narrow: true });
  renderAuthPane('login');
}

function renderAuthPane(tab) {
  const pane = $('#auth-pane');
  if (!pane) return;
  pane.innerHTML = tab === 'register' ? `
    <div class="field"><label>注册码</label><input class="input" id="reg-code" placeholder="管理员提供的注册码" autocomplete="off"></div>
    <div class="field"><label>用户名</label><input class="input" id="reg-user" placeholder="3–32 位字母数字" autocomplete="username"></div>
    <div class="field"><label>密码</label><input class="input" type="password" id="reg-pass" placeholder="至少 4 位" autocomplete="new-password"></div>
    <div class="modal-foot"><button class="btn primary" id="auth-submit">注册并登录</button></div>
  ` : `
    <div class="field"><label>用户名</label><input class="input" id="login-user" placeholder="admin" autocomplete="username"></div>
    <div class="field"><label>密码</label><input class="input" type="password" id="login-pass" placeholder="默认 admin / admin" autocomplete="current-password"></div>
    <div class="modal-foot"><button class="btn primary" id="auth-submit">登录</button></div>
  `;
  const submit = $('#auth-submit');
  if (submit) submit.addEventListener('click', () => (tab === 'register' ? doRegister() : doLogin()));
  const pass = pane.querySelector('input[type="password"]');
  if (pass) pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') (tab === 'register' ? doRegister() : doLogin()); });
}

async function doLogin() {
  const username = ($('#login-user').value || '').trim();
  const password = $('#login-pass').value || '';
  if (!username || !password) return toast('请输入用户名和密码', 'err');
  const btn = $('#auth-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 登录中';
  try {
    await api('/api/auth/login', { method: 'POST', body: { username, password } });
    closeModal();
    toast('登录成功');
    await loadState();
    await router();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '登录';
    toast(e.message || '登录失败', 'err');
  }
}

async function doRegister() {
  const code = ($('#reg-code').value || '').trim();
  const username = ($('#reg-user').value || '').trim();
  const password = $('#reg-pass').value || '';
  if (!code || !username || !password) return toast('请填写注册码、用户名和密码', 'err');
  const btn = $('#auth-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 注册中';
  try {
    await api('/api/auth/register', { method: 'POST', body: { code, username, password } });
    closeModal();
    toast('注册成功，已自动登录');
    await loadState();
    await router();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '注册并登录';
    toast(e.message || '注册失败', 'err');
  }
}

function openAccountModal() {
  const user = state.auth.user || {};
  const admin = state.auth.admin;
  openModal(`
    <h3>账号 · ${esc(user.username || '')}</h3>
    <p class="modal-desc">角色：${user.role === 'admin' ? '管理员' : '普通账号'}${admin ? '，可管理模板、规则库与账号。' : '，可转换订阅与保存自己的订阅。'}</p>
    ${state.auth.defaultPassword ? '<div class="notice amber">当前仍在使用默认密码 admin/admin，建议立即修改。</div>' : ''}
    <div class="modal-list">
      <button class="btn ghost" data-act="password-open">修改密码</button>
      ${admin ? '<button class="btn ghost" data-act="users-open">账号管理</button>' : ''}
      ${admin ? '<button class="btn ghost" data-act="invites-open">注册码</button>' : ''}
      <button class="btn danger" data-act="do-logout">退出登录</button>
    </div>
  `, { narrow: true });
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  closeModal();
  toast('已退出登录');
  await loadState();
  await router();
}

function openPasswordModal() {
  openModal(`
    <h3>修改密码</h3>
    <div class="field"><label>当前密码</label><input class="input" type="password" id="pw-current" autocomplete="current-password"></div>
    <div class="field"><label>新密码</label><input class="input" type="password" id="pw-next" placeholder="至少 4 位" autocomplete="new-password"></div>
    <div class="modal-foot"><button class="btn primary" id="pw-save">保存</button></div>
  `, { narrow: true });
  $('#pw-save').addEventListener('click', async () => {
    const current = $('#pw-current').value || '';
    const next = $('#pw-next').value || '';
    if (!next) return toast('请输入新密码', 'err');
    try {
      await api('/api/auth/password', { method: 'POST', body: { current, next } });
      closeModal();
      toast('密码已修改，请重新登录');
      await loadState();
      await router();
    } catch (e) {
      toast(e.message || '修改失败', 'err');
    }
  });
}

async function openUsersModal() {
  let data = { users: [] };
  try { data = await api('/api/users'); } catch (e) { return reportError(e, '读取账号失败'); }
  const rows = (data.users || []).map((u) => `
    <div class="user-row" data-uid="${esc(u.id)}">
      <div class="user-main"><strong>${esc(u.username)}</strong><span class="small faint">${esc(u.role)} · ${esc(fmtTime(u.createdAt))}</span></div>
      <select class="select tiny" data-user-role="${esc(u.id)}">
        <option value="admin"${u.role === 'admin' ? ' selected' : ''}>管理员</option>
        <option value="user"${u.role === 'user' ? ' selected' : ''}>普通</option>
      </select>
      <button class="btn small ghost" data-act="user-reset" data-id="${esc(u.id)}" data-name="${esc(u.username)}">重置密码</button>
      <button class="btn small danger" data-act="user-del" data-id="${esc(u.id)}" data-name="${esc(u.username)}">删除</button>
    </div>
  `).join('');
  openModal(`
    <h3>账号管理</h3>
    <p class="modal-desc">创建账号、调整角色或重置密码。普通账号不能修改模板与资源库。</p>
    <div class="modal-list">${rows || '<div class="empty small">还没有账号</div>'}</div>
    <div class="divider"></div>
    <h4>新建账号</h4>
    <div class="grid-2">
      <div class="field"><label>用户名</label><input class="input" id="new-user" placeholder="如 alice"></div>
      <div class="field"><label>密码</label><input class="input" id="new-pass" placeholder="至少 4 位"></div>
      <div class="field"><label>角色</label><select class="select" id="new-role"><option value="user">普通</option><option value="admin">管理员</option></select></div>
    </div>
    <div class="modal-foot"><button class="btn primary" data-act="user-add">创建账号</button></div>
  `);
}

async function openInvitesModal() {
  let data = { invites: [] };
  try { data = await api('/api/invites'); } catch (e) { return reportError(e, '读取注册码失败'); }
  const rows = (data.invites || []).map((i) => `
    <div class="invite-row">
      <code>${esc(i.code)}</code>
      <span class="badge${i.usedBy ? '' : i.expired ? ' amber' : ' blue'}">${i.usedBy ? '已使用' : i.expired ? '已过期' : '可用'}</span>
      <span class="small faint">${esc(i.role)} · 到期 ${esc(fmtTime(i.expiresAt))}</span>
      <button class="btn small ghost" data-act="invite-del" data-code="${esc(i.code)}">删除</button>
    </div>
  `).join('');
  openModal(`
    <h3>注册码</h3>
    <p class="modal-desc">把注册码发给朋友，对方在「登录 → 注册码注册」里自助注册，一次有效。</p>
    <div class="modal-list">${rows || '<div class="empty small">还没有注册码</div>'}</div>
    <div class="divider"></div>
    <div class="row">
      <select class="select tiny" id="invite-role"><option value="user">普通账号</option><option value="admin">管理员</option></select>
      <select class="select tiny" id="invite-ttl"><option value="24">24 小时</option><option value="72" selected>3 天</option><option value="168">7 天</option></select>
      <button class="btn primary" data-act="invite-add">生成注册码</button>
    </div>
  `);
}

/* ── 事件分发 ─────────────────────────────────────────────── */
async function handleAction(act, el) {
  switch (act) {
    case 'modal-close':
      closeModal();
      return;
    case 'auth-open':
      openAuthModal();
      return;
    case 'auth-tab': {
      const tab = el.dataset.tab || 'login';
      for (const b of $$('.auth-tabs .seg-btn')) b.classList.toggle('active', b.dataset.tab === tab);
      renderAuthPane(tab);
      return;
    }
    case 'account-open':
      openAccountModal();
      return;
    case 'do-logout':
      await doLogout();
      return;
    case 'password-open':
      openPasswordModal();
      return;
    case 'users-open':
      await openUsersModal();
      return;
    case 'invites-open':
      await openInvitesModal();
      return;
    case 'user-add': {
      const username = ($('#new-user').value || '').trim();
      const password = $('#new-pass').value || '';
      const role = $('#new-role').value;
      if (!username || !password) return toast('请填写用户名和密码', 'err');
      try {
        await api('/api/users', { method: 'POST', body: { username, password, role } });
        toast(`已创建账号 ${username}`);
        await openUsersModal();
      } catch (e) {
        toast(e.message || '创建失败', 'err');
      }
      return;
    }
    case 'user-reset': {
      const name = el.dataset.name || '';
      const password = window.prompt(`把 ${name} 的密码重置为：`, '');
      if (!password) return;
      try {
        await api(`/api/users/${encodeURIComponent(el.dataset.id)}`, { method: 'PUT', body: { password } });
        toast(`已重置 ${name} 的密码`);
      } catch (e) {
        toast(e.message || '重置失败', 'err');
      }
      return;
    }
    case 'user-del': {
      const name = el.dataset.name || '';
      if (!window.confirm(`确定删除账号 ${name}？`)) return;
      try {
        await api(`/api/users/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' });
        toast(`已删除 ${name}`);
        await openUsersModal();
      } catch (e) {
        toast(e.message || '删除失败', 'err');
      }
      return;
    }
    case 'invite-add': {
      try {
        const out = await api('/api/invites', { method: 'POST', body: { role: $('#invite-role').value, ttlHours: Number($('#invite-ttl').value) } });
        toast(`注册码：${out.invite.code}`);
        await openInvitesModal();
      } catch (e) {
        toast(e.message || '生成失败', 'err');
      }
      return;
    }
    case 'invite-del': {
      try {
        await api(`/api/invites/${encodeURIComponent(el.dataset.code)}`, { method: 'DELETE' });
        await openInvitesModal();
      } catch (e) {
        toast(e.message || '删除失败', 'err');
      }
      return;
    }
    case 'toggle-card': {
      const id = el.dataset.card;
      state.collapsed[id] = !state.collapsed[id];
      render();
      return;
    }
    case 'block-add': {
      state.convert.blocks.push({ type: el.dataset.type || 'url', value: '' });
      state.collapsed.import = false;
      render();
      return;
    }
    case 'block-del': {
      state.convert.blocks.splice(Number(el.dataset.i), 1);
      render();
      return;
    }
    case 'block-parse': {
      const i = Number(el.dataset.i);
      await parseBlock(i);
      return;
    }
    case 'batch-toggle': {
      state.batch.on = !state.batch.on;
      state.batch.sel = [];
      render();
      return;
    }
    case 'batch-all': {
      state.batch.sel = state.convert.nodes.map((_, i) => i);
      render();
      return;
    }
    case 'batch-exit': {
      state.batch = { on: false, sel: [] };
      render();
      return;
    }
    case 'batch-edit': {
      openBatchModal();
      return;
    }
    case 'batch-rename': {
      openBatchModal();
      return;
    }
    case 'batch-replace': {
      openBatchModal();
      return;
    }
    case 'batch-del': {
      batchDelete();
      return;
    }
    case 'strat-toggle': {
      const i = Number(el.dataset.i);
      const key = `g:${i}`;
      state.collapsed[key] = state.collapsed[key] === false;
      render();
      return;
    }
    case 'strat-up':
    case 'strat-down': {
      moveStrategyGroup(Number(el.dataset.i), act === 'strat-up' ? -1 : 1);
      return;
    }
    case 'strat-del': {
      const d = strategyDraft();
      if (!d) return;
      d.model.groups.splice(Number(el.dataset.i), 1);
      d.dirty = true;
      render();
      schedulePreview(300);
      return;
    }
    case 'strat-add': {
      const d = strategyDraft();
      if (!d) return;
      const names = d.model.groups.map((g) => g.name);
      let idx = d.model.groups.length + 1;
      let name = `新分组 ${idx}`;
      while (names.includes(name)) name = `新分组 ${++idx}`;
      d.model.groups.push({ name, type: 'select', refs: ['DIRECT'] });
      d.dirty = true;
      render();
      schedulePreview(300);
      return;
    }
    case 'strat-reset': {
      state.convert.draft = null;
      state.convert.useDraftOnce = false;
      await ensureStrategy(true);
      return;
    }
    case 'strat-pick': {
      openMemberPicker(Number(el.dataset.i));
      return;
    }
    case 'strat-member-add': {
      const d = strategyDraft();
      const i = Number(el.dataset.i);
      const g = d && d.model.groups[i];
      const input = $(`#strat-new-${i}`);
      const value = input ? input.value.trim() : '';
      if (!g || !value) return;
      const list = strategyMembers(g);
      if (!list.includes(value)) list.push(value);
      if (g.type === 'select') g.refs = list; else g.patterns = list;
      d.dirty = true;
      render();
      schedulePreview(300);
      return;
    }
    case 'strat-member-del': {
      const d = strategyDraft();
      const g = d && d.model.groups[Number(el.dataset.i)];
      if (!g) return;
      const list = strategyMembers(g);
      list.splice(Number(el.dataset.j), 1);
      if (g.type === 'select') g.refs = list; else g.patterns = list;
      d.dirty = true;
      render();
      schedulePreview(300);
      return;
    }
    case 'custom-rule-add': {
      const type = ($('#custom-rule-type') || {}).value || 'DOMAIN-SUFFIX';
      const value = (($('#custom-rule-value') || {}).value || '').trim().replace(/^,|,$/g, '');
      if (!value) return toast('请填写规则值，例如 google.com', 'err');
      const groupEl = $('#custom-rule-group');
      const group = (groupEl && groupEl.value) || currentGroupNames()[0];
      const noResolve = !!($('#custom-rule-noresolve') || {}).checked;
      const rule = `${type},${value}`;
      state.convert.rules.push({
        id: `inline-${Date.now().toString(36)}`,
        name: rule,
        group,
        noResolve,
        inline: [rule],
      });
      toast('已添加规则');
      render();
      schedulePreview(300);
      return;
    }
    case 'preview-rule-up':
    case 'preview-rule-down': {
      const i = Number(el.dataset.i);
      const j = act === 'preview-rule-up' ? i - 1 : i + 1;
      const list = state.convert.rules;
      if (j < 0 || j >= list.length) return;
      const [item] = list.splice(i, 1);
      list.splice(j, 0, item);
      render();
      schedulePreview(300);
      return;
    }
    case 'pick-target':
      state.convert.target = el.dataset.id;
      state.result = null;
      render();
      if (state.convert.live) schedulePreview(350);
      return;
    case 'convert':
      await doConvert();
      return;
    case 'make-link':
      await doMakeLink();
      return;
    case 'clear-result':
      state.result = null;
      state.link = null;
      render();
      return;
    case 'copy':
      await copyText(el.dataset.copy || '');
      return;
    case 'copy-result':
      if (state.result) await copyText(state.result.body);
      return;
    case 'reload':
      location.reload();
      return;
    case 'qr':
      openQr(el.dataset.title || '订阅二维码', el.dataset.qr || '');
      return;
    case 'download': {
      if (!state.result) return;
      const ext = DOWNLOAD_EXT[state.result.target] || 'txt';
      downloadText(`subhub-${state.result.target}.${ext}`, state.result.body);
      return;
    }
    case 'qr-link':
      if (state.link) openQr('临时链接', state.link);
      return;
    case 'save-as-profile':
      if (!(await applyDraftChoice())) return;
      openProfileModal(null, {
        name: '',
        sources: allSources(),
        nodes: state.convert.nodes,
        baseId: state.convert.baseId,
        dnsId: state.convert.dnsId,
        rulesets: state.convert.rules.map((r) => ({ id: r.id, group: r.group, noResolve: !!r.noResolve, inline: r.inline })),
        template: state.convert.template,
        include: state.convert.include,
        exclude: state.convert.exclude,
        opts: { ...state.convert.opts },
      });
      return;
    case 'profiles-refresh':
      await ensureProfiles();
      render();
      return;
    case 'profile-new':
      openProfileModal(null);
      return;
    case 'profile-edit':
      openProfileModal(el.dataset.token);
      return;
    case 'profile-test':
      openProfileTest(el.dataset.token);
      return;
    case 'profile-del': {
      const token = el.dataset.token;
      const p = state.profiles.find((x) => x.token === token);
      confirmDialog('删除订阅', `确定删除「${p ? p.name : token}」？删除后该链接立即失效。`, '删除', async () => {
        await api(`/api/profiles/${encodeURIComponent(token)}`, { method: 'DELETE', admin: true });
        toast('已删除');
        await ensureProfiles();
        render();
      });
      return;
    }
    case 'template-open':
      location.hash = `#/templates/${encodeURIComponent(el.dataset.name)}`;
      return;
    case 'template-new':
      openNewTemplateModal();
      return;
    case 'template-mode': {
      const mode = el.dataset.mode;
      const ed = state.editor;
      if (!ed || ed.mode === mode) return;
      if (mode === 'raw' && ed.inputMode !== 'raw') {
        ed.content = clientBuildIni(ed.model);
        ed.inputMode = 'raw';
      }
      if (mode === 'visual' && ed.inputMode === 'raw') {
        try {
          const data = await api('/api/templates/parse', { method: 'POST', admin: true, body: { content: ed.content } });
          ed.model = data.model;
          ed.inputMode = 'visual';
          ed.dirty = true;
        } catch (e) {
          toast(e.message || '解析失败，请检查 ini 语法', 'err');
          return;
        }
      }
      ed.mode = mode;
      render();
      return;
    }
    case 'template-save':
      await saveTemplate();
      return;
    case 'template-save-as':
      await saveTemplate({ saveAs: true });
      return;
    case 'template-preview':
      await previewTemplate();
      return;
    case 'template-del': {
      const ed = state.editor;
      if (!ed) return;
      confirmDialog('删除模板', `确定删除模板「${ed.name}」？使用它的订阅会转换失败。`, '删除', async () => {
        await api(`/api/templates/${encodeURIComponent(ed.name)}`, { method: 'DELETE', admin: true });
        toast('模板已删除');
        state.editor = null;
        const data = await api('/api/state', { admin: true });
        state.status = data;
        state.templates = data.templates || [];
        location.hash = '#/templates';
      });
      return;
    }
    case 'group-add': {
      const ed = state.editor;
      if (!ed) return;
      ed.model.groups.push({ name: `新策略组 ${ed.model.groups.length + 1}`, type: 'select', refs: ['DIRECT'], patterns: [], url: '', interval: '', tolerance: '' });
      ed.dirty = true;
      render();
      return;
    }
    case 'group-del': {
      const ed = state.editor;
      if (!ed) return;
      ed.model.groups.splice(Number(el.dataset.i), 1);
      ed.dirty = true;
      render();
      return;
    }
    case 'group-up':
    case 'group-down': {
      const ed = state.editor;
      if (!ed) return;
      const i = Number(el.dataset.i);
      const j = act === 'group-up' ? i - 1 : i + 1;
      if (j < 0 || j >= ed.model.groups.length) return;
      const arr = ed.model.groups;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      ed.dirty = true;
      render();
      return;
    }
    case 'rule-add': {
      const ed = state.editor;
      if (!ed) return;
      const first = ed.model.groups[0] ? ed.model.groups[0].name : 'DIRECT';
      ed.model.rules.push({ target: first, kind: 'inline', type: 'DOMAIN-SUFFIX', value: '', options: [] });
      ed.dirty = true;
      render();
      return;
    }
    case 'rule-del': {
      const ed = state.editor;
      if (!ed) return;
      ed.model.rules.splice(Number(el.dataset.i), 1);
      ed.dirty = true;
      render();
      return;
    }
    case 'rule-up':
    case 'rule-down': {
      const ed = state.editor;
      if (!ed) return;
      const i = Number(el.dataset.i);
      const j = act === 'rule-up' ? i - 1 : i + 1;
      if (j < 0 || j >= ed.model.rules.length) return;
      const arr = ed.model.rules;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      ed.dirty = true;
      render();
      return;
    }
    /* ── 来源与节点 ───────────────────────────────────────── */
    case 'fetch-nodes':
      await previewNodes({ mode: 'url', sources: allSources() });
      return;
    case 'parse-nodes':
      await previewNodes({ mode: 'text', text: state.convert.nodeText, filename: 'pasted.txt' });
      return;
    case 'clear-sources':
      state.convert.sources = '';
      state.convert.blocks = [];
      render();
      return;
    case 'clear-links':
      state.convert.nodeText = '';
      render();
      return;
    case 'qr-open':
      openQrModal();
      return;
    case 'node-add':
      openNodeModal(-1);
      return;
    case 'node-edit':
      openNodeModal(Number(el.dataset.i));
      return;
    case 'node-del':
      state.convert.nodes.splice(Number(el.dataset.i), 1);
      render();
      schedulePreview(300);
      return;
    case 'nodes-clear':
      state.convert.nodes = [];
      render();
      return;
    case 'nodes-adopt':
      state.convert.nodes = state.convert.nodes.map((n) => ({ ...n }));
      toast('已转为自定义节点，可逐条编辑');
      render();
      return;

    /* ── 规则集 ───────────────────────────────────────────── */
    case 'catalog-add': {
      const id = el.dataset.id;
      if (!id) return;
      if (state.convert.rules.some((r) => r.id === id)) return toast('这条规则集已经在列表里', 'err');
      const item = state.convert.ruleItems.find((x) => x.id === id) || {};
      state.convert.rules.push({ id, name: item.name || id, group: item.group || '🚀 节点选择', noResolve: false });
      toast(`已添加「${item.name || id}」`);
      render();
      schedulePreview(300);
      return;
    }
    case 'layer-del':
      state.convert.rules.splice(Number(el.dataset.i), 1);
      render();
      schedulePreview(300);
      return;
    case 'layer-up':
    case 'layer-down': {
      const i = Number(el.dataset.i);
      const j = act === 'layer-up' ? i - 1 : i + 1;
      const arr = state.convert.rules;
      if (j < 0 || j >= arr.length) return;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      render();
      schedulePreview(300);
      return;
    }
    case 'go-library':
      location.hash = '#/library';
      return;

    /* ── 预览 ─────────────────────────────────────────────── */
    case 'preview-refresh':
      await refreshPreview({ quiet: false });
      return;
    case 'preview-tab':
      state.preview.tab = el.dataset.tab === 'structure' ? 'structure' : 'config';
      refreshPreviewDom();
      return;
    case 'preview-copy':
      if (state.preview.body) await copyText(state.preview.body);
      return;
    case 'preview-download': {
      const t = targetById(state.convert.target);
      const ext = DOWNLOAD_EXT[state.convert.target] || (t && t.engine === 'singbox' ? 'json' : 'yaml');
      if (state.preview.body) downloadText(`subhub-${state.convert.target}.${ext}`, state.preview.body);
      return;
    }
    case 'edit-rules':
      location.hash = `#/templates/${encodeURIComponent(state.convert.template)}`;
      return;

    /* ── 资源库 ───────────────────────────────────────────── */
    case 'lib-tab':
      state.libView.tab = el.dataset.tab || 'all';
      render();
      return;
    case 'lib-view':
      state.libView.ruleset = el.dataset.view === 'card' ? 'card' : 'list';
      render();
      return;
    case 'lib-page':
      state.libView.page = el.dataset.page || 'ruleset';
      render();
      return;
    case 'tpl-edit':
      location.hash = `#/templates/${encodeURIComponent(el.dataset.name || '')}`;
      return;
    case 'tpl-use': {
      state.convert.template = el.dataset.name || state.convert.template;
      state.convert.draft = null;
      toast(`已选择模板「${el.dataset.name}」`);
      go('convert');
      return;
    }
    case 'tpl-help':
      openModal(`
        <h3>模板语法</h3>
        <p class="modal-desc">模板是 subconverter 的 <code>[custom]</code> ini：先定义策略组，再按顺序写规则集。</p>
        <pre class="preview-code" style="max-height:320px;overflow:auto">${esc('; @title 我的模板\n; @targets mihomo,singbox,surge\n[custom]\ncustom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]DIRECT\ncustom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`300,,50\nruleset=🚀 节点选择,[]GEOIP,CN\nruleset=🐟 漏网之鱼,[]FINAL\nenable_rule_generator=true\noverwrite_original_rules=true')}</pre>
        <div class="modal-foot"><button class="btn" data-act="modal-close">关闭</button></div>
      `);
      return;
    case 'catalog-refresh': {
      if (!state.auth.admin) { toast('请先用管理员账号登录', 'err'); return; }
      el.disabled = true;
      toast('正在从 MetaCubeX 更新规则集目录…');
      try {
        const data = await api('/api/catalog/refresh', { method: 'POST' });
        await loadState();
        render();
        toast(`目录已更新：${data.count} 条规则集`, 'ok');
      } catch (e) {
        toast(e.message || '更新失败', 'err');
      } finally {
        el.disabled = false;
      }
      return;
    }
    case 'repo-add':
      openLibraryModal('ruleset', '');
      return;
    case 'lib-add':
      openLibraryModal(el.dataset.kind || 'ruleset', '');
      return;
    case 'lib-edit':
      openLibraryModal(el.dataset.kind || 'ruleset', el.dataset.id || '');
      return;
    case 'lib-del': {
      const kind = el.dataset.kind || 'ruleset';
      const id = el.dataset.id || '';
      const item = libraryById(kind, id);
      confirmDialog('删除资源', `确定删除「${item ? item.name : id}」？引用它的订阅会失去这一层。`, '删除', async () => {
        await api(`/api/library/${libraryPath(kind)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('已删除');
        await loadLibrary();
        render();
      });
      return;
    }

    case 'lib-collect': {
      const rawId = el.dataset.id || '';
      try {
        const it = await api(`/api/rules/${encodeURIComponent(rawId)}`);
        const localId = String(rawId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `rule-${Date.now()}`;
        await api('/api/library/rulesets', {
          method: 'POST',
          body: {
            id: localId,
            name: it.label || it.name || rawId,
            group: it.group,
            behavior: it.behavior,
            repo: 'MetaCubeX',
            desc: it.desc || `${it.id} · MetaCubeX`,
            urls: it.urls,
          },
        });
        toast(`已固定「${it.label || it.name || rawId}」到规则集`);
        await loadLibrary();
        render();
      } catch (e) {
        toast(e.message || '固定失败', 'err');
      }
      return;
    }

    case 'logs-refresh':
      await loadLogs();
      render();
      return;
    case 'cache-clear':
      try {
        await api('/api/cache/clear', { method: 'POST', admin: true });
        toast('缓存已清空');
        await loadState();
        render();
      } catch (e) {
        toast(e.message || '操作失败', 'err');
      }
      return;
    case 'engine-check':
      try {
        const data = await api('/api/engine/check', { method: 'POST', admin: true });
        state.status.engine = data.engine;
        updateShell();
        render();
        toast(data.engine.ok ? '引擎在线' : '引擎不可用', data.engine.ok ? 'ok' : 'err');
      } catch (e) {
        toast(e.message || '检测失败', 'err');
      }
      return;
    default:
      return;
  }
}

/* ── 转换动作 ─────────────────────────────────────────────── */
async function parseBlock(i) {
  const block = state.convert.blocks[i];
  if (!block) return;
  const text = String(block.value || '').trim();
  if (!text) return toast('这个导入源还是空的', 'err');
  if (block.type === 'url') {
    await previewNodes({ mode: 'url', sources: parseSources(text) });
  } else if (block.type === 'links') {
    await previewNodes({ mode: 'nodes', nodes: parseSources(text) });
  } else {
    await previewNodes({ mode: 'text', text });
  }
}

function moveStrategyGroup(i, delta) {
  const d = strategyDraft();
  if (!d) return;
  const j = i + delta;
  const groups = d.model.groups;
  if (j < 0 || j >= groups.length) return;
  const [item] = groups.splice(i, 1);
  groups.splice(j, 0, item);
  d.dirty = true;
  render();
  schedulePreview(300);
}

function safeRegex(pattern, flags = 'i') {
  const p = String(pattern || '');
  if (!p) return null;
  try {
    return new RegExp(p, flags);
  } catch {
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

function batchPlan() {
  const val = (id) => {
    const el = $(id);
    return el ? String(el.value || '') : '';
  };
  const include = safeRegex(val('#bx-include'));
  const exclude = safeRegex(val('#bx-exclude'));
  const findRaw = val('#bx-find');
  const find = findRaw ? safeRegex(findRaw, 'g') : null;
  const to = val('#bx-to');
  const trim = !!($('#bx-trim') && $('#bx-trim').checked);
  const space = !!($('#bx-space') && $('#bx-space').checked);
  const plan = [];
  for (const idx of state.batch.sel || []) {
    const n = state.convert.nodes[idx];
    if (!n) continue;
    const oldName = String(n.name || n.server || '');
    if (include && !include.test(oldName)) continue;
    if (exclude && exclude.test(oldName)) continue;
    let next = find ? oldName.replace(find, to) : oldName;
    if (space) next = next.replace(/\s+/g, ' ').trim();
    else if (trim) next = next.trim();
    plan.push({ idx, oldName, next, changed: next !== oldName });
  }
  return plan;
}

function refreshBatchPreview() {
  const box = $('#bx-preview');
  if (!box) return;
  const plan = batchPlan();
  const changed = plan.filter((p) => p.changed);
  const label = $('#bx-count');
  if (label) label.textContent = `匹配 ${plan.length} · 将修改 ${changed.length}`;
  box.innerHTML = plan.length
    ? plan.slice(0, 30).map((p) => `
      <div class="user-row">
        <div class="user-main">
          <span class="mono">${esc(p.oldName)}</span>
          ${p.changed ? `<span class="hint">→ ${esc(p.next)}</span>` : '<span class="hint">未变化</span>'}
        </div>
        <span class="badge proto ${protoClass((state.convert.nodes[p.idx] || {}).type)}">${esc(String(((state.convert.nodes[p.idx] || {}).type) || '').toUpperCase())}</span>
      </div>`).join('')
    : '<div class="empty small">没有匹配的节点。</div>';
}

function openBatchModal() {
  if (!(state.batch.sel || []).length) return toast('请先勾选节点', 'err');
  openModal(`
    <h3>批量编辑</h3>
    <p class="modal-desc">仅修改节点名（name）部分，不改动服务器地址与协议参数。筛选用正则，留空表示匹配全部已选节点。</p>
    <div class="grid-2">
      <div class="field"><label>筛选：包含正则（可选）</label><input class="input" id="bx-include" placeholder="例如：香港|HK"></div>
      <div class="field"><label>筛选：排除正则（可选）</label><input class="input" id="bx-exclude" placeholder="例如：过期|剩余|官网"></div>
    </div>
    <div class="divider"></div>
    <div class="row" style="margin-bottom:8px"><b>批量重命名</b><span class="hint" id="bx-count">匹配 0 · 将修改 0</span></div>
    <div class="grid-2">
      <div class="field"><label>查找（正则，可选）</label><input class="input" id="bx-find" placeholder="例如：\\s*\\|\\s*"></div>
      <div class="field"><label>替换为</label><input class="input" id="bx-to" placeholder="例如：-"></div>
    </div>
    <div class="row" style="margin-top:10px">
      <label class="check"><input type="checkbox" id="bx-trim" checked> 去除首尾空格</label>
      <label class="check"><input type="checkbox" id="bx-space"> 空白归一</label>
    </div>
    <div class="divider"></div>
    <div class="field"><label>预览</label><div id="bx-preview" class="modal-list"></div></div>
    <div class="modal-foot">
      <button class="btn ghost" data-act="modal-close">取消</button>
      <button class="btn primary" id="bx-apply">完成</button>
    </div>
  `);
  refreshBatchPreview();
  for (const id of ['#bx-include', '#bx-exclude', '#bx-find', '#bx-to', '#bx-trim', '#bx-space']) {
    const el = $(id);
    if (el) el.addEventListener('input', refreshBatchPreview);
    if (el) el.addEventListener('change', refreshBatchPreview);
  }
  $('#bx-apply').addEventListener('click', () => {
    const plan = batchPlan();
    let count = 0;
    for (const p of plan) {
      if (!p.changed) continue;
      state.convert.nodes[p.idx].name = p.next;
      count += 1;
    }
    closeModal();
    toast(count ? `已修改 ${count} 个节点名` : '没有需要修改的节点');
    render();
    schedulePreview(400);
  });
}

function batchRename() {
  openBatchModal();
}

function batchReplace() {
  openBatchModal();
}

function batchDelete() {
  const sel = [...(state.batch.sel || [])].sort((a, b) => b - a);
  if (!sel.length) return toast('请先勾选节点', 'err');
  for (const i of sel) state.convert.nodes.splice(i, 1);
  state.batch.sel = [];
  toast(`已删除 ${sel.length} 个节点`);
  render();
  schedulePreview(400);
}

/* 模板被就地修改后，转换前询问保存方式 */
function chooseDraftSaveMode() {
  return new Promise((resolve) => {
    openModal(`
      <h3>模板已修改</h3>
      <p class="modal-desc">你在本页调整了「${esc(strategyDraft() ? strategyDraft().name : '')}」的策略组。要用哪种方式处理？</p>
      <div class="modal-list">
        <button class="choice" id="draft-save"><b>保存到模板</b><span>覆盖原模板，之后的转换默认使用新配置。</span></button>
        <button class="choice" id="draft-copy"><b>另存为副本</b><span>保留原模板，新建一个副本并改为使用它。</span></button>
        <button class="choice" id="draft-once"><b>仅用于这一次</b><span>不改模板，只把当前修改带进这次转换。</span></button>
      </div>
      <div class="modal-foot"><button class="btn ghost" data-act="modal-close">取消</button></div>
    `, { narrow: true });
    const finish = (v) => { closeModal(); resolve(v); };
    const save = $('#draft-save');
    const copy = $('#draft-copy');
    const once = $('#draft-once');
    if (save) save.onclick = () => finish('save');
    if (copy) copy.onclick = () => finish('copy');
    if (once) once.onclick = () => finish('once');
  });
}

async function applyDraftChoice() {
  const d = strategyDraft();
  if (!d || !d.dirty) return true;
  const mode = await chooseDraftSaveMode();
  if (!mode) return false;
  if (mode === 'once') {
    state.convert.useDraftOnce = true;
    return true;
  }
  try {
    if (mode === 'save') {
      await api(`/api/templates/${encodeURIComponent(d.name)}`, { method: 'PUT', admin: true, body: { model: saveableModel(d.model) } });
      d.dirty = false;
      state.convert.useDraftOnce = false;
      toast('模板已保存');
      const data = await api('/api/state', { admin: true });
      state.status = data;
      state.templates = data.templates || [];
    } else {
      const name = window.prompt('副本名称（字母、数字、点、下划线、短横线）', `${d.name}-copy`);
      if (!name) return false;
      await api('/api/templates', { method: 'POST', admin: true, body: { name, model: saveableModel(d.model) } });
      state.convert.template = name;
      d.dirty = false;
      state.convert.useDraftOnce = false;
      toast(`已保存为副本 ${name}`);
      const data = await api('/api/state', { admin: true });
      state.status = data;
      state.templates = data.templates || [];
      state.convert.draft = null;
      await ensureStrategy(true);
    }
    return true;
  } catch (e) {
    reportError(e, '保存模板失败');
    return false;
  }
}

function convertPayload() {
  const c = state.convert;
  const payload = {
    target: c.target,
    template: c.template,
    include: c.include.trim(),
    exclude: c.exclude.trim(),
    opts: c.opts,
  };
  const sources = allSources(c);
  payload.sources = sources;
  if (c.nodes.length) payload.nodes = c.nodes;
  if (c.baseId) payload.baseId = c.baseId;
  if (c.dnsId) payload.dnsId = c.dnsId;
  if (c.rules.length) payload.rulesetIds = c.rules.map((r) => ({ id: r.id, group: r.group, noResolve: !!r.noResolve, inline: r.inline }));
  const d = strategyDraft();
  if (d && (d.dirty || c.useDraftOnce)) payload.templateContent = clientBuildIni(d.model);
  if (d && !payload.templateContent) payload.template = d.name;
  return payload;
}

function hasSource() {
  const c = state.convert;
  if (allSources(c).length) return true;
  return c.nodes.length > 0;
}

function setPreviewFrom(data) {
  state.preview = {
    body: data.body || '',
    nodes: data.nodes || 0,
    bytes: data.bytes || (data.body || '').length,
    ms: data.ms || 0,
    error: '',
    loading: false,
    tab: state.preview.tab || 'config',
    at: Date.now(),
    warnings: data.warnings || [],
    userinfo: data.userinfo || '',
  };
}

function parseUserinfo(raw) {
  const out = {};
  String(raw || '').split(';').forEach((part) => {
    const [k, v] = part.split('=').map((s) => String(s || '').trim());
    if (k && v && Number.isFinite(Number(v))) out[k] = Number(v);
  });
  return out;
}

function trafficLabel(raw) {
  const u = parseUserinfo(raw);
  if (!u.total) return '';
  const used = (u.upload || 0) + (u.download || 0);
  const left = Math.max(0, u.total - used);
  const expire = u.expire ? new Date(u.expire * 1000) : null;
  const parts = [`剩余 ${fmtBytes(left)} / ${fmtBytes(u.total)}`];
  if (expire && !Number.isNaN(expire.getTime())) {
    parts.push(`${expire.toISOString().slice(0, 10)} 到期`);
  }
  return parts.join(' · ');
}

async function doConvert() {
  const payload = convertPayload();
  if (!hasSource()) return toast('请先填写订阅链接或节点', 'err');
  if (!(await applyDraftChoice())) return;
  const finalPayload = convertPayload();
  state.busy = true;
  render();
  try {
    const data = await api('/api/convert', { method: 'POST', body: finalPayload });
    state.result = data;
    setPreviewFrom(data);
    toast(`转换成功：${data.nodes} 个节点`);
  } catch (e) {
    state.preview.error = e.message || '转换失败';
    toast(e.message || '转换失败', 'err');
  } finally {
    state.busy = false;
    render();
  }
}

/* 实时预览：模板/分层/目标/节点变化后防抖刷新 */
let previewTimer = null;
function schedulePreview(delay = 900) {
  if (!state.convert.live) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { refreshPreview().catch(() => {}); }, delay);
}

async function refreshPreview({ quiet = true } = {}) {
  if (!hasSource()) {
    state.preview = { ...state.preview, body: '', error: '', nodes: 0, bytes: 0, ms: 0 };
    refreshPreviewDom();
    return;
  }
  state.preview.loading = true;
  refreshPreviewDom();
  try {
    const data = await api('/api/convert', { method: 'POST', body: convertPayload() });
    setPreviewFrom(data);
    state.result = data;
  } catch (e) {
    state.preview.loading = false;
    state.preview.error = e.message || '预览失败';
    if (!quiet) toast(state.preview.error, 'err');
  }
  refreshPreviewDom();
}

async function doMakeLink() {
  if (!hasSource()) return toast('请先填写订阅链接或节点', 'err');
  if (!(await applyDraftChoice())) return;
  const payload = convertPayload();
  try {
    const data = await api('/api/link', { method: 'POST', body: payload });
    state.link = data.url;
    render();
    openQr('临时链接', data.url);
    toast('临时链接已生成');
  } catch (e) {
    toast(e.message || '生成失败', 'err');
  }
}

/* ── 资源库 ───────────────────────────────────────────────── */
const KIND_META = {
  ruleset: { plural: 'rulesets', title: '规则集', desc: '官方 mihomo .mrs / sing-box .srs 与 Clash .list，可叠加到模板。' },
  base: { plural: 'bases', title: '基础配置', desc: 'mihomo / sing-box 的基础骨架，转换时可选叠加。' },
  dns: { plural: 'dns', title: 'DNS 配置', desc: '独立的 dns 段，可覆盖模板自带 DNS。' },
};

function libraryPath(kind) {
  return (KIND_META[kind] || KIND_META.ruleset).plural;
}

async function loadLibrary() {
  const data = await api('/api/library', { admin: true });
  state.library = data;
}

function renderLibResults() {
  const s = state.libSearch;
  if (!s.q) return '<div class="empty small">输入关键词搜索 2183 条官方规则集，支持中文名，例如 <code>netflix</code>、<code>谷歌</code>、<code>广告</code>、<code>cn</code>。</div>';
  if (!s.items.length) return '<div class="empty small">没有匹配的规则集。</div>';
  return `<div class="rule-list">${s.items.map((it) => `
    <div class="rule-row">
      <div class="rule-row-main">
        <div class="row">
          <b>${esc(it.zh || it.label || it.name)}</b>
          <span class="badge gray">${esc(it.group || '')}</span>
          <span class="badge gray">${esc(it.kind === 'geoip' ? 'IP' : '域名')}</span>
          ${it.cnt ? `<span class="hint">${Number(it.cnt).toLocaleString('zh-CN')} 条</span>` : ''}
        </div>
        <div class="hint mono">${esc(it.id)}${it.cat ? ` · ${esc(it.cat)}` : ''}</div>
        ${it.desc ? `<div class="hint">${esc(it.desc)}</div>` : ''}
      </div>
      <button class="btn small ghost" data-act="lib-collect" data-id="${esc(it.id)}">固定</button>
    </div>`).join('')}</div>`;
}

async function searchLibRules(q) {
  state.libSearch.q = q;
  if (!q.trim()) {
    state.libSearch.items = [];
    const box = $('#lib-results');
    if (box) box.innerHTML = renderLibResults();
    return;
  }
  const loading = $('#lib-results');
  if (loading) loading.innerHTML = '<div class="empty small"><span class="spinner"></span> 正在搜索…</div>';
  try {
    const data = await api(`/api/rules?limit=15&q=${encodeURIComponent(q)}`);
    state.libSearch.items = data.items || [];
    state.libSearch.total = data.total || 0;
  } catch (e) {
    state.libSearch.items = [];
  }
  const box = $('#lib-results');
  if (box) box.innerHTML = renderLibResults();
}

const LIB_CORE = ['ad-block', 'ad-app', 'geoip-cn', 'geosite-cn', 'private-lan', 'local-area', 'proxy-gfw'];
const LIB_COMMON = ['telegram', 'youtube', 'netflix', 'openai', 'spotify', 'steam', 'apple', 'microsoft', 'google', 'github', 'download'];

function libSourceOf(it) {
  if (!it) return { label: '未知', cls: 'gray' };
  if (it.repo) {
    const official = /metacube|acl4ssr|官方/i.test(it.repo) || it.builtin;
    return { label: it.repo, cls: official ? 'gray' : 'blue' };
  }
  if (!it.builtin) return { label: '自建', cls: 'yellow' };
  if (LIB_CORE.includes(it.id)) return { label: '核心', cls: 'green' };
  if (LIB_COMMON.includes(it.id)) return { label: '常用', cls: 'blue' };
  return { label: '官方', cls: 'gray' };
}

function renderLibItems() {
  const lv = state.libView;
  const all = libraryOf('ruleset');
  const tab = lv.tab || 'all';
  let items = all;
  if (tab === 'core') items = all.filter((it) => LIB_CORE.includes(it.id));
  if (tab === 'common') items = all.filter((it) => LIB_COMMON.includes(it.id));
  if (!items.length) return `<div class="empty small">${tab === 'all' ? '还没有规则集，搜索官方目录后点「收藏」。' : '这个分类下还没有规则集，可以到「全部」里收藏。'}</div>`;
  if (lv.ruleset === 'card') {
    return `<div class="lib-cards">${items.map((it) => {
      const src = libSourceOf(it);
      return `
        <div class="lib-card">
          <div class="row"><b>${esc(it.name)}</b><span class="badge ${src.cls}">${src.label}</span></div>
          <div class="hint mono">${esc(it.id)}</div>
          <div class="row" style="margin-top:8px"><span class="badge gray">${esc(it.group || '')}</span><span class="badge gray">${esc(it.behavior || 'domain')}</span></div>
          <div class="row" style="margin-top:10px">
            <button class="btn small ghost" data-act="lib-edit" data-kind="ruleset" data-id="${esc(it.id)}">编辑</button>
            ${it.builtin ? '<span class="hint">内置只读</span>' : `<button class="btn small ghost danger" data-act="lib-del" data-kind="ruleset" data-id="${esc(it.id)}">删除</button>`}
          </div>
        </div>`;
    }).join('')}</div>`;
  }
  return `<div class="lib-list">${items.map((it) => {
    const src = libSourceOf(it);
    return `
      <div class="lib-row">
        <div class="lib-main">
          <div class="row">
            <b>${esc(it.name)}</b>
            <span class="badge ${src.cls}">${src.label}</span>
            <span class="badge gray">${esc(it.group || '')}</span>
            <span class="badge gray">${esc(it.behavior || 'domain')}</span>
          </div>
          <div class="hint mono">${esc(it.id)}${it.desc ? ` · ${esc(it.desc)}` : ''}</div>
        </div>
        <div class="row">
          <button class="btn small ghost" data-act="lib-edit" data-kind="ruleset" data-id="${esc(it.id)}">编辑</button>
          ${it.builtin ? '<span class="hint">内置只读</span>' : `<button class="btn small ghost danger" data-act="lib-del" data-kind="ruleset" data-id="${esc(it.id)}">删除</button>`}
        </div>
      </div>`;
  }).join('')}</div>`;
}

function renderLibrary() {
  const formats = (state.status && state.status.library && state.status.library.formats) || ['mihomo', 'singbox', 'any'];
  const kinds = ['base', 'dns'];
  const kindCard = (kind) => {
    const meta = KIND_META[kind];
    const items = libraryOf(kind);
    return `
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">${meta.title}</div><p class="card-desc">${meta.desc}</p></div>
          <button class="btn small primary" data-act="lib-add" data-kind="${kind}">＋ 新建</button>
        </div>
        ${items.length ? `<div class="lib-list">${items.map((it) => `
          <div class="lib-row">
            <div class="lib-main">
              <div class="row">
                <b>${esc(it.name)}</b>
                ${it.builtin ? '<span class="badge gray">内置</span>' : '<span class="badge yellow">自建</span>'}
                <span class="badge gray">${esc(it.format || 'any')}</span>
              </div>
              <div class="hint mono">${esc(it.id)}${it.desc ? ` · ${esc(it.desc)}` : ''}</div>
            </div>
            <div class="row">
              <button class="btn small ghost" data-act="lib-edit" data-kind="${kind}" data-id="${esc(it.id)}">编辑</button>
              ${it.builtin ? '<span class="hint">内置只读</span>' : `<button class="btn small ghost danger" data-act="lib-del" data-kind="${kind}" data-id="${esc(it.id)}">删除</button>`}
            </div>
          </div>`).join('')}</div>` : `<div class="empty small">还没有${meta.title}。</div>`}
      </div>`;
  };
  const lv = state.libView;
  const page = lv.page || 'ruleset';
  const templateCard = `
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">转换模板</div>
          <p class="card-desc">模板决定策略组与最终规则顺序；可视化编辑后可直接用于订阅转换。</p>
        </div>
        <button class="btn small ghost" data-act="tpl-help">模板语法</button>
      </div>
      ${(state.templates || []).length ? `<div class="lib-list">${state.templates.map((t) => `
        <div class="lib-row">
          <div class="lib-main">
            <div class="row"><b>${esc(t.title || t.name)}</b>${t.builtin === false ? '' : ''}<span class="badge gray">${esc(t.name)}</span></div>
            <div class="hint">${esc(t.description || '')}</div>
            <div class="hint mono">${t.groups || 0} 个策略组 · ${t.rules || 0} 条规则 · ${fmtBytes(t.bytes || 0)}</div>
          </div>
          <div class="row">
            <button class="btn small ghost" data-act="tpl-edit" data-name="${esc(t.name)}">可视化编辑</button>
            <button class="btn small ghost" data-act="tpl-use" data-name="${esc(t.name)}">用于转换</button>
          </div>
        </div>`).join('')}</div>` : '<div class="empty small">还没有模板。</div>'}
    </div>`;

  return `
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">资源库</div>
            <p class="card-desc">规则集、转换模板、基础配置与 DNS 集中在这里管理。</p>
          </div>
          <div class="seg">
            <button class="seg-btn ${page === 'ruleset' ? 'active' : ''}" data-act="lib-page" data-page="ruleset">规则集</button>
            <button class="seg-btn ${page === 'template' ? 'active' : ''}" data-act="lib-page" data-page="template">转换模板</button>
            <button class="seg-btn ${page === 'layer' ? 'active' : ''}" data-act="lib-page" data-page="layer">基础与 DNS</button>
          </div>
        </div>
      </div>

      ${page === 'template' ? templateCard : ''}

      ${page === 'layer' ? kinds.map(kindCard).join('') : ''}

      ${page === 'ruleset' ? `
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">官方规则集目录</div>
            <p class="card-desc">MetaCubeX meta-rules-dat 全量 ${(state.status && state.status.catalog && state.status.catalog.count) || 2183} 条 geosite / geoip，含中文名与用途说明。搜索后「固定」，它会出现在规则集里。</p>
          </div>
          <div class="row">
            <span class="badge">${(state.status && state.status.catalog && state.status.catalog.count) || 2183} 条</span>
            <button class="btn small ghost" data-act="catalog-refresh" ${state.auth && state.auth.admin ? '' : 'disabled'}>↻ 更新目录</button>
            <button class="btn small ghost" data-act="repo-add">＋ 添加仓库</button>
          </div>
        </div>
        <input class="input" id="lib-search" placeholder="搜索：Netflix、Telegram、广告、cn、google…（支持中文名）" value="${esc(state.libSearch.q)}">
        <div id="lib-results" style="margin-top:12px">${renderLibResults()}</div>
        <p class="hint" style="margin-top:10px">来源标签：<span class="badge green">核心</span> <span class="badge blue">常用</span> <span class="badge gray">官方</span> <span class="badge yellow">自建</span>。自定义仓库可填入任意 Clash / mihomo / sing-box 规则集地址。</p>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">规则集</div>
            <p class="card-desc">核心是建议默认启用的基础规则，常用是常见的服务分流规则。</p>
          </div>
          <div class="row">
            <div class="seg">
              <button class="seg-btn ${lv.tab === 'all' ? 'active' : ''}" data-act="lib-tab" data-tab="all">全部</button>
              <button class="seg-btn ${lv.tab === 'core' ? 'active' : ''}" data-act="lib-tab" data-tab="core">核心</button>
              <button class="seg-btn ${lv.tab === 'common' ? 'active' : ''}" data-act="lib-tab" data-tab="common">常用</button>
            </div>
            <div class="seg">
              <button class="seg-btn ${lv.ruleset === 'list' ? 'active' : ''}" data-act="lib-view" data-view="list">列表</button>
              <button class="seg-btn ${lv.ruleset === 'card' ? 'active' : ''}" data-act="lib-view" data-view="card">卡片</button>
            </div>
            <button class="btn small primary" data-act="lib-add" data-kind="ruleset">＋ 新建</button>
          </div>
        </div>
        ${renderLibItems()}
      </div>
      ` : ''}

      <div class="card">
        <div class="card-title">用法</div>
        <p class="card-desc">在「订阅转换」的「分流规则」里选择模板、基础配置、DNS，并按顺序添加规则集：mihomo 会写成原生 rule-providers，sing-box 写成 route.rule_set，其他客户端会由服务端把规则内联进模板。可用格式：${formats.map((f) => `<code>${esc(f)}</code>`).join('、')}。</p>
      </div>
    </div>`;
}

async function previewNodes(payload) {
  state.busy = true;
  render();
  try {
    const data = await api('/api/nodes/preview', { method: 'POST', body: payload });
    state.convert.nodes = data.nodes || [];
    toast(`已解析 ${data.count || state.convert.nodes.length} 个节点`);
    schedulePreview(300);
  } catch (e) {
    toast(e.message || '解析失败', 'err');
  } finally {
    state.busy = false;
    render();
  }
}

function openNodeModal(index) {
  const editing = index >= 0;
  const node = editing ? state.convert.nodes[index] : { name: '', type: 'vless', server: '', port: 443 };
  const { name = '', type = '', server = '', port = '', ...rest } = node || {};
  openModal(`
    <h3>${editing ? '编辑节点' : '添加节点'}</h3>
    <p class="modal-desc">节点会完整写入配置，不依赖上游订阅；保存后来源切换为「自定义节点」。</p>
    <div class="grid-2">
      <div class="field"><label>名称</label><input class="input" id="nd-name" value="${esc(name)}" data-autofocus></div>
      <div class="field"><label>类型</label><input class="input" id="nd-type" value="${esc(type)}" placeholder="vless / vmess / ss"></div>
      <div class="field"><label>服务器</label><input class="input" id="nd-server" value="${esc(server)}" placeholder="example.com"></div>
      <div class="field"><label>端口</label><input class="input" id="nd-port" type="number" value="${esc(port)}"></div>
    </div>
    <div class="field" style="margin-top:12px">
      <label>其他参数（JSON）</label>
      <textarea class="textarea mono" id="nd-rest" rows="6">${esc(JSON.stringify(rest, null, 2))}</textarea>
      <div class="hint">如 uuid、password、tls、servername、network、ws-opts 等。</div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-act="modal-close">取消</button>
      <button class="btn primary" id="nd-ok">${editing ? '保存' : '添加'}</button>
    </div>
  `);

  $('#nd-ok').addEventListener('click', () => {
    let extra = {};
    const raw = ($('#nd-rest').value || '').trim();
    if (raw) {
      try { extra = JSON.parse(raw); } catch { return toast('其他参数不是合法 JSON', 'err'); }
    }
    const next = {
      ...extra,
      name: ($('#nd-name').value || '').trim(),
      type: ($('#nd-type').value || '').trim(),
      server: ($('#nd-server').value || '').trim(),
      port: Number($('#nd-port').value),
    };
    if (!next.name) next.name = `${next.server || '节点'}:${next.port || ''}`;
    if (editing) state.convert.nodes[index] = next;
    else state.convert.nodes.push(next);
    state.convert.mode = 'nodes';
    closeModal();
    render();
    schedulePreview(300);
    toast(editing ? '节点已更新' : '节点已添加');
  });
}

async function openLibraryModal(kind, id) {
  const meta = KIND_META[kind] || KIND_META.ruleset;
  let item = null;
  if (id) {
    try {
      item = await api(`/api/library/${libraryPath(kind)}/${encodeURIComponent(id)}?content=1`, { admin: true });
    } catch (e) {
      return toast(e.message || '读取失败', 'err');
    }
  }
  const isRuleset = kind === 'ruleset';
  const urls = (item && item.urls) || {};
  openModal(`
    <h3>${id ? '编辑' : '新建'}${meta.title}</h3>
    <p class="modal-desc">${isRuleset ? '规则集可指向官方远程地址，也可以直接内联规则。' : '内容会覆盖或叠加到模板对应段落。'}</p>
    <div class="grid-2">
      <div class="field"><label>ID（英文小写）</label><input class="input mono" id="lib-id" value="${esc((item && item.id) || '')}" ${id ? 'readonly' : ''} data-autofocus placeholder="my-ruleset"></div>
      <div class="field"><label>名称</label><input class="input" id="lib-name" value="${esc((item && item.name) || '')}" placeholder="我的规则集"></div>
    </div>
    ${isRuleset ? `
      <div class="grid-2">
        <div class="field"><label>归属策略组</label><input class="input" id="lib-group" value="${esc((item && item.group) || '🎯 全球直连')}"></div>
        <div class="field"><label>行为</label><select class="select" id="lib-behavior">
          ${['domain', 'ipcidr', 'classical'].map((b) => `<option value="${b}" ${(item && item.behavior) === b ? 'selected' : ''}>${b}</option>`).join('')}
        </select></div>
      </div>
      <div class="field"><label>说明</label><input class="input" id="lib-desc" value="${esc((item && item.desc) || '')}"></div>
      <div class="field"><label>来源仓库（显示在标签上）</label><input class="input" id="lib-repo" value="${esc((item && item.repo) || '自建')}" placeholder="例如 MetaCubeX / ACL4SSR / 我的仓库"></div>
      <div class="field"><label>远程地址（Clash .list/.yaml）</label><input class="input mono" id="lib-url-clash" value="${esc(urls.clash || '')}"></div>
      <div class="field"><label>远程地址（mihomo .mrs）</label><input class="input mono" id="lib-url-mihomo" value="${esc(urls.mihomo || '')}"></div>
      <div class="field"><label>远程地址（sing-box .srs）</label><input class="input mono" id="lib-url-singbox" value="${esc(urls.singbox || '')}"></div>
      <div class="field"><label>内联规则（每行一条）</label><textarea class="textarea mono" id="lib-inline" rows="5">${esc(((item && item.inline) || []).join('\n'))}</textarea></div>
    ` : `
      <div class="grid-2">
        <div class="field"><label>格式</label><select class="select" id="lib-format">
          ${['mihomo', 'singbox', 'any'].map((f) => `<option value="${f}" ${(item && item.format) === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select></div>
        <div class="field"><label>说明</label><input class="input" id="lib-desc" value="${esc((item && item.desc) || '')}"></div>
      </div>
      <div class="field"><label>内容（YAML / JSON）</label><textarea class="textarea mono" id="lib-content" rows="14">${esc((item && item.content) || '')}</textarea>
        <div class="hint">mihomo 基础配置只取顶层段；DNS 配置只需 dns: 段。</div>
      </div>
    `}
    <div class="modal-foot">
      <button class="btn ghost" data-act="modal-close">取消</button>
      <button class="btn primary" id="lib-ok">${id ? '保存' : '创建'}</button>
    </div>
  `, { narrow: false });

  $('#lib-ok').addEventListener('click', async () => {
    const input = {
      id: ($('#lib-id').value || '').trim(),
      name: ($('#lib-name').value || '').trim(),
      desc: ($('#lib-desc').value || '').trim(),
    };
    if (isRuleset) {
      input.group = ($('#lib-group').value || '').trim();
      input.behavior = $('#lib-behavior').value;
      input.repo = ($('#lib-repo').value || '').trim() || '自建';
      input.urls = {
        clash: ($('#lib-url-clash').value || '').trim(),
        mihomo: ($('#lib-url-mihomo').value || '').trim(),
        singbox: ($('#lib-url-singbox').value || '').trim(),
      };
      input.inline = ($('#lib-inline').value || '').split('\n').map((s) => s.trim()).filter(Boolean);
    } else {
      input.format = $('#lib-format').value;
      input.content = $('#lib-content').value;
    }
    try {
      if (id) await api(`/api/library/${libraryPath(kind)}/${encodeURIComponent(id)}`, { method: 'PUT', admin: true, body: input });
      else await api(`/api/library/${libraryPath(kind)}`, { method: 'POST', admin: true, body: input });
      closeModal();
      toast('已保存');
      await loadLibrary();
      render();
    } catch (e) {
      reportError(e, '保存失败');
    }
  });
}

/* ── 新建模板 ─────────────────────────────────────────────── */
function openNewTemplateModal() {
  openModal(`
    <h3>新建模板</h3>
    <p class="modal-desc">从一份最小可用模板开始，之后可在可视化编辑器里添加策略组与规则。</p>
    <div class="field"><label>模板名称（文件名）</label><input class="input" id="new-tpl-name" placeholder="my-template" data-autofocus><div class="hint">字母、数字、点、下划线、短横线</div></div>
    <div class="field" style="margin-top:12px"><label>标题</label><input class="input" id="new-tpl-title" placeholder="我的分流模板"></div>
    <div class="modal-foot">
      <button class="btn ghost" data-act="modal-close">取消</button>
      <button class="btn primary" id="new-tpl-ok">创建</button>
    </div>
  `, { narrow: true });

  $('#new-tpl-ok').addEventListener('click', async () => {
    const name = ($('#new-tpl-name').value || '').trim();
    const title = ($('#new-tpl-title').value || '').trim() || name;
    if (!name) return toast('请输入模板名称', 'err');
    const model = {
      meta: { title, description: '', targets: ['mihomo', 'singbox', 'surge', 'loon', 'quanx'], author: '', version: '1', extra: {} },
      groups: [
        { name: '🚀 节点选择', type: 'select', refs: ['♻️ 自动选择', 'DIRECT'], patterns: [] },
        { name: '♻️ 自动选择', type: 'url-test', refs: [], patterns: ['.*'], url: 'http://www.gstatic.com/generate_204', interval: '300', tolerance: '50' },
        { name: '🐟 漏网之鱼', type: 'select', refs: ['🚀 节点选择', 'DIRECT'], patterns: [] },
      ],
      rules: [
        { target: '🐟 漏网之鱼', kind: 'inline', type: 'FINAL', value: '', options: [] },
      ],
      extras: ['enable_rule_generator=true', 'overwrite_original_rules=true'],
      warnings: [],
    };
    try {
      await api('/api/templates', { method: 'POST', admin: true, body: { name, model } });
      closeModal();
      toast('模板已创建');
      const data = await api('/api/state', { admin: true });
      state.status = data;
      state.templates = data.templates || [];
      location.hash = `#/templates/${encodeURIComponent(name)}`;
    } catch (e) {
      toast(e.message || '创建失败', 'err');
    }
  });
}

/* ── 全局事件 ─────────────────────────────────────────────── */
document.addEventListener('click', async (e) => {
  const nav = e.target.closest('[data-view]');
  if (nav) {
    go(nav.dataset.view);
    return;
  }
  if (e.target.closest('#account-btn')) {
    openAuthModal();
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'modal-close' && !el.closest('.modal') && !el.classList.contains('btn')) {
    // 点击遮罩关闭
    closeModal();
    return;
  }
  try {
    await handleAction(el.dataset.act, el);
  } catch (err) {
    toast(err.message || '操作失败', 'err');
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.block !== undefined) {
    const i = Number(el.dataset.block);
    if (state.convert.blocks[i]) state.convert.blocks[i].value = el.value;
  }
  if (el.dataset.bind) {
    state.convert[el.dataset.bind] = el.value;
  }
  if (el.id === 'rule-search') {
    state.convert.ruleQ = el.value;
    clearTimeout(searchRulesTimer);
    searchRulesTimer = setTimeout(() => { searchRules(el.value); }, 260);
  }
  if (el.id === 'lib-search') {
    state.libSearch.q = el.value;
    clearTimeout(libSearchTimer);
    libSearchTimer = setTimeout(() => { searchLibRules(el.value); }, 280);
  }
  if (el.id === 'node-search') {
    state.convert.nodeQ = el.value;
    const q = el.value.trim().toLowerCase();
    $$('#node-list .node-row').forEach((row, i) => {
      const node = state.convert.nodes[i] || {};
      const hay = `${node.name || ''} ${node.server || ''} ${node.type || ''}`.toLowerCase();
      row.style.display = !q || hay.includes(q) ? '' : 'none';
    });
  }
  if (el.dataset.opt) {
    state.convert.opts[el.dataset.opt] = el.checked;
  }
  if (el.dataset.raw !== undefined && state.editor) {
    state.editor.content = el.value;
    state.editor.inputMode = 'raw';
    state.editor.dirty = true;
  }
  if (el.dataset.extras !== undefined && state.editor) {
    state.editor.model.extras = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    state.editor.dirty = true;
  }
  if (el.dataset.meta) {
    metaField(el.dataset.meta, el.value);
  }
  if (el.dataset.g !== undefined) updateGroupField(el);
  if (el.dataset.r !== undefined) updateRuleField(el);
});

// 规则列表拖拽排序
let dragRuleIndex = -1;
document.addEventListener('dragstart', (e) => {
  const row = e.target.closest && e.target.closest('[data-drag]');
  if (!row) return;
  dragRuleIndex = Number(row.dataset.drag);
  row.classList.add('dragging');
  try { e.dataTransfer.setData('text/plain', String(dragRuleIndex)); e.dataTransfer.effectAllowed = 'move'; } catch {}
});
document.addEventListener('dragend', (e) => {
  const row = e.target.closest && e.target.closest('[data-drag]');
  if (row) row.classList.remove('dragging');
});
document.addEventListener('dragover', (e) => {
  const row = e.target.closest && e.target.closest('[data-drag]');
  if (!row || dragRuleIndex < 0) return;
  e.preventDefault();
  row.classList.add('drag-over');
});
document.addEventListener('dragleave', (e) => {
  const row = e.target.closest && e.target.closest('[data-drag]');
  if (row) row.classList.remove('drag-over');
});
document.addEventListener('drop', (e) => {
  const row = e.target.closest && e.target.closest('[data-drag]');
  if (!row || dragRuleIndex < 0) return;
  e.preventDefault();
  row.classList.remove('drag-over');
  const to = Number(row.dataset.drag);
  const list = state.convert.rules || [];
  if (Number.isInteger(to) && to !== dragRuleIndex && list[dragRuleIndex]) {
    const [moved] = list.splice(dragRuleIndex, 1);
    list.splice(to, 0, moved);
    state.convert.rules = list;
    render();
    schedulePreview(200);
  }
  dragRuleIndex = -1;
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'theme-select') {
    applyTheme(el.value);
    return;
  }  if (el.dataset.userRole !== undefined) {
    const id = el.dataset.userRole;
    api(`/api/users/${encodeURIComponent(id)}`, { method: 'PUT', body: { role: el.value } })
      .then(() => toast('角色已更新'))
      .catch((err) => toast(err.message || '更新失败', 'err'));
    return;
  }
  if (el.dataset.blockFile !== undefined) {
    const i = Number(el.dataset.blockFile);
    const block = state.convert.blocks[i];
    if (!block || !el.files || !el.files[0]) return;
    const file = el.files[0];
    if (file.size > 4 * 1024 * 1024) return toast('文件过大（上限 4MB）', 'err');
    const reader = new FileReader();
    reader.onload = () => { block.value = String(reader.result || ''); render(); };
    reader.onerror = () => toast('读取文件失败', 'err');
    reader.readAsText(file);
    return;
  }
  if (el.dataset.nodeSel !== undefined) {
    const i = Number(el.dataset.nodeSel);
    const sel = state.batch.sel || [];
    const at = sel.indexOf(i);
    if (el.checked && at < 0) sel.push(i);
    if (!el.checked && at >= 0) sel.splice(at, 1);
    state.batch.sel = sel;
    el.closest('.node-row')?.classList.toggle('selected', el.checked);
    return;
  }
  if (el.dataset.prevRuleGroup !== undefined) {
    const i = Number(el.dataset.prevRuleGroup);
    if (state.convert.rules[i]) {
      state.convert.rules[i].group = el.value;
      schedulePreview(300);
      render();
    }
    return;
  }
  if (el.dataset.stratOn !== undefined) {
    const d = strategyDraft();
    const i = Number(el.dataset.stratOn);
    if (d && d.model.groups[i]) {
      d.model.groups[i].enabled = el.checked;
      d.dirty = true;
      schedulePreview(300);
      render();
    }
    return;
  }
  if (el.dataset.stratType !== undefined) {
    const d = strategyDraft();
    const i = Number(el.dataset.stratType);
    const g = d && d.model.groups[i];
    if (g) {
      g.type = el.value;
      if (g.type !== 'select' && !g.patterns) g.patterns = [];
      if (g.type === 'select' && !g.refs) g.refs = [];
      d.dirty = true;
      render();
      schedulePreview(300);
    }
    return;
  }
  if (el.dataset.stratUrl !== undefined) {
    const d = strategyDraft();
    const i = Number(el.dataset.stratUrl);
    if (d && d.model.groups[i]) {
      d.model.groups[i].url = el.value;
      d.dirty = true;
      schedulePreview(300);
    }
    return;
  }
  if (el.dataset.stratPattern !== undefined) {
    const d = strategyDraft();
    const i = Number(el.dataset.stratPattern);
    if (d && d.model.groups[i]) {
      d.model.groups[i].patterns = el.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      d.dirty = true;
      schedulePreview(300);
    }
    return;
  }
  if (el.dataset.stratExclude !== undefined) {
    const d = strategyDraft();
    const i = Number(el.dataset.stratExclude);
    if (d && d.model.groups[i]) {
      d.model.groups[i].exclude = el.value.trim();
      d.dirty = true;
      schedulePreview(300);
    }
    return;
  }
  if (el.dataset.ruleGroup !== undefined) {
    const i = Number(el.dataset.ruleGroup);
    if (state.convert.rules[i]) {
      state.convert.rules[i].group = el.value;
      schedulePreview(300);
    }
    return;
  }
  if (el.dataset.ruleNoresolve !== undefined) {
    const i = Number(el.dataset.ruleNoresolve);
    if (state.convert.rules[i]) {
      state.convert.rules[i].noResolve = el.checked;
      schedulePreview(300);
    }
    return;
  }
  if (el.dataset.layer) {
    if (el.dataset.layer === 'base') state.convert.baseId = el.value;
    else state.convert.dnsId = el.value;
    schedulePreview(300);
    return;
  }
  if (el.dataset.previewLive !== undefined) {
    state.convert.live = el.checked;
    if (el.checked) schedulePreview(300);
    return;
  }
  if (el.id === 'node-file' && el.files && el.files[0]) {
    const file = el.files[0];
    if (file.size > 4 * 1024 * 1024) return toast('文件过大（上限 4MB）', 'err');
    const reader = new FileReader();
    reader.onload = () => previewNodes({ mode: 'text', text: String(reader.result || ''), filename: file.name });
    reader.onerror = () => toast('读取文件失败', 'err');
    reader.readAsText(file);
    return;
  }
  if (el.dataset.bind && el.tagName === 'SELECT') {
    state.convert[el.dataset.bind] = el.value;
    render();
    schedulePreview(300);
    return;
  }
  if (el.dataset.g !== undefined && el.dataset.f === 'type') {
    updateGroupField(el);
    state.editor.dirty = true;
    render();
    return;
  }
  if (el.dataset.r !== undefined && el.dataset.f === 'kind') {
    updateRuleField(el);
    state.editor.dirty = true;
    render();
    return;
  }
  if (el.dataset.mt) {
    const ed = state.editor;
    if (!ed) return;
    const set = new Set(ed.model.meta.targets || []);
    if (el.checked) set.add(el.dataset.mt);
    else set.delete(el.dataset.mt);
    ed.model.meta.targets = [...set];
    ed.dirty = true;
    return;
  }
  if (el.dataset.g !== undefined) updateGroupField(el);
  if (el.dataset.r !== undefined) updateRuleField(el);
});

function metaField(key, value) {
  const ed = state.editor;
  if (!ed) return;
  ed.model.meta[key] = value;
  ed.dirty = true;
}

function updateGroupField(el) {
  const ed = state.editor;
  if (!ed) return;
  const idx = Number(el.dataset.g);
  const group = ed.model.groups[idx];
  if (!group) return;
  const f = el.dataset.f;
  if (f === 'refs') {
    group.refs = el.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  } else if (f === 'patterns') {
    group.patterns = el.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  } else if (f === 'pattern') {
    group.patterns = [el.value.trim()].filter(Boolean);
  } else if (f === 'name' || f === 'type' || f === 'url' || f === 'interval' || f === 'tolerance') {
    group[f] = el.value;
  }
  ed.dirty = true;
}

function updateRuleField(el) {
  const ed = state.editor;
  if (!ed) return;
  const idx = Number(el.dataset.r);
  const rule = ed.model.rules[idx];
  if (!rule) return;
  const f = el.dataset.f;
  if (f === 'noResolve') {
    const opts = new Set(rule.options || []);
    if (el.checked) opts.add('no-resolve');
    else opts.delete('no-resolve');
    rule.options = [...opts];
  } else if (f === 'kind') {
    rule.kind = el.value;
  } else {
    rule[f] = el.value;
  }
  ed.dirty = true;
}

window.addEventListener('hashchange', () => { router(); });

/* ── 启动 ─────────────────────────────────────────────────── */
(async function boot() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('theme');
    const savedTheme = fromUrl || localStorage.getItem('subhub.theme');
    if (savedTheme) applyTheme(savedTheme, !fromUrl);
  } catch { /* ignore */ }
  try {
    await loadState();
  } catch (e) {
    const view = $('#view');
    if (view) {
      view.innerHTML = `<div class="card"><div class="card-title">无法连接网关</div><p class="card-desc">${esc(e.message || '')}</p><button class="btn primary" data-act="reload">重试</button></div>`;
    }
    return;
  }
  if (!location.hash) location.hash = '#/convert';
  await router();

  // 轻量轮询：每 60 秒刷新一次状态指示灯
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const data = await api('/api/state', { admin: true });
      state.status.engine = data.engine;
      state.status.stats = data.stats;
      updateShell();
    } catch { /* 忽略 */ }
  }, 60000);
}());

