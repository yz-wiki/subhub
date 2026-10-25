<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { NModal, NButton } from 'naive-ui';
import { state } from '../state.js';
import UiIcon from './UiIcon.vue';

/*
 * 订阅「配置」弹窗：一个订阅的链接 / 二维码 / 下载 / 预览都收在这里。
 * 链接来源仍是后端 profileView() 下发的 profile.links[targetId]
 * （形如 `${publicBase}/s/:token/:target`），links.auto 作为通用链接保留。
 *
 * 弹窗被 teleport 到 body，拿不到 .sub-page 上的 --sp-* 变量；
 * 因此这里只用 :root / html[data-theme] 定义的全局变量，并自带亮暗两套
 * 代码块配色（与 ConvertView 的实时预览保持一致）。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  profile: { type: Object, default: null },
  loadQr: { type: Function, required: true },
  download: { type: Function, default: null },
});
const emit = defineEmits(['update:show', 'copy']);

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
});

const links = computed(() => (props.profile && props.profile.links) || {});
const allowedList = computed(() => {
  const p = props.profile || {};
  return Array.isArray(p.allowedTargets) ? p.allowedTargets : [];
});

const EMPTY = { id: '', label: '', subtitle: '', accent: 'var(--accent)', url: '', allowed: false, format: { ext: 'conf', label: '配置' } };

/* 各客户端的文件格式（与后端 gateway/lib/targets.js 的 engine 对应）。 */
const FORMATS = {
  mihomo: { ext: 'yaml', label: 'Clash / mihomo YAML' },
  stash: { ext: 'yaml', label: 'Stash YAML' },
  singbox: { ext: 'json', label: 'sing-box JSON' },
  daed: { ext: 'txt', label: 'Base64 节点订阅' },
  v2ray: { ext: 'txt', label: 'Base64 节点订阅' },
  surge: { ext: 'conf', label: 'Surge 配置' },
  loon: { ext: 'conf', label: 'Loon 配置' },
  quanx: { ext: 'conf', label: 'Quantumult X 配置' },
  surfboard: { ext: 'conf', label: 'Surfboard 配置' },
};

const clients = computed(() => {
  const src = (state.targets && state.targets.length ? state.targets : []).map((t) => ({
    id: t.id,
    label: t.label || t.id,
    subtitle: t.subtitle || '',
    accent: t.accent || '#818cf8',
  }));
  const list = src.length
    ? src
    : Object.keys(links.value)
        .filter((k) => k !== 'auto')
        .map((k) => ({ id: k, label: k, subtitle: '', accent: '#818cf8' }));
  return list.map((t) => ({
    ...t,
    format: FORMATS[t.id] || { ext: 'conf', label: '配置文件' },
    url: links.value[t.id] || '',
    allowed: allowedList.value.length === 0 || allowedList.value.includes(t.id),
  }));
});
const openCount = computed(() => clients.value.filter((c) => c.allowed).length);
const autoLink = computed(() => links.value.auto || '');

/* ---------------- 客户端选择 ---------------- */

const picked = ref('');
const pickDefault = () => {
  const usable = clients.value.filter((c) => c.url && c.allowed);
  if (usable.some((c) => c.id === 'mihomo')) return 'mihomo';
  return (usable[0] || clients.value[0] || EMPTY).id;
};

watch(clients, () => {
  if (!picked.value || !clients.value.some((c) => c.id === picked.value)) picked.value = pickDefault();
});

const current = computed(() => clients.value.find((c) => c.id === picked.value) || null);
const currentUrl = computed(() => (current.value ? current.value.url : ''));
const previewReady = computed(() => !!currentUrl.value && !!current.value.allowed);
const safeName = computed(() => String((props.profile && props.profile.name) || 'subscription').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'subscription');
const fileName = computed(() => {
  const c = current.value || EMPTY;
  return `${safeName.value}-${c.id || 'auto'}.${c.format.ext}`;
});
const tab = ref('link');

/* ---------------- 品牌图标（内联 SVG，无第三方依赖） ---------------- */

const GLYPHS = {
  mihomo: `<path d="M4.7 5.2 9.1 7h5.8l4.4-1.8-.6 4.6a7 7 0 1 1-13.8 0Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="9.3" cy="11.6" r="1.05" fill="currentColor"/><circle cx="14.7" cy="11.6" r="1.05" fill="currentColor"/><path d="M11 14.1h2l-1 1.5Z" fill="currentColor"/><path d="M3 12.6h2M19 12.6h2M3.6 15.4l1.9-.5M18.5 14.9l1.9.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>`,
  daed: `<ellipse cx="11" cy="15.6" rx="7.2" ry="4.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M14.6 12.4c.4-1.6 1-2.9 1.9-3.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="17.2" cy="7.2" r="2.3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M19.3 6.6 22 7.7l-2.7 1.2Z" fill="currentColor"/>`,
  stash: `<path d="M12 3.3 20.6 7.7 12 12.1 3.4 7.7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m3.4 12.1 8.6 4.4 8.6-4.4M3.4 16.5l8.6 4.4 8.6-4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>`,
  singbox: `<path d="M12 3.1 20.5 7.8v8.4L12 20.9 3.5 16.2V7.8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3.6 7.9 12 12.6l8.4-4.7M12 12.6v8.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" opacity=".55"/>`,
  surge: `<path d="M13.9 2.3 5.1 13.5h5.3l-1 8.2 8.9-11.5h-5.5Z" fill="currentColor"/>`,
  loon: `<circle cx="10.2" cy="8.2" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M13.9 7.1 21.4 9.2l-7.5 2.1Z" fill="currentColor"/><circle cx="9" cy="7.4" r=".8" fill="currentColor"/><path d="M3 18.2c2-1.5 4.1-1.5 6.1 0s4.1 1.5 6.1 0 3.6-1.4 5.4-.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".7"/>`,
  quanx: `<circle cx="10.8" cy="10.8" r="7.1" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 5.2 5.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="10.8" cy="10.8" r="2.1" fill="currentColor" opacity=".8"/>`,
  surfboard: `<path d="M12 2.4c3.5 2.5 5.4 5.9 5.4 9.4 0 3.6-1.9 6.5-5.4 9.8-3.5-3.3-5.4-6.2-5.4-9.8 0-3.5 1.9-6.9 5.4-9.4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 4.6v14.8" stroke="currentColor" stroke-width="1.4" opacity=".6"/>`,
  v2ray: `<path d="M21.4 3.1 2.7 10.5l6.6 2.4 2.4 6.6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m9.2 12.9 5-5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".7"/>`,
};
const FALLBACK_GLYPH = `<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.4 16.2 16H7.8Z" fill="currentColor" opacity=".8"/>`;
const glyphOf = (id) => GLYPHS[id] || FALLBACK_GLYPH;

/* ---------------- 二维码 ---------------- */

const qrSvg = ref('');
const qrBusy = ref(false);
const qrError = ref('');
const autoQrSvg = ref('');
let qrSeq = 0;

async function toggleAutoQr() {
  if (autoQrSvg.value) { autoQrSvg.value = ''; return; }
  if (!autoLink.value) return;
  try {
    const qrcode = await props.loadQr();
    const qr = qrcode(0, 'M');
    qr.addData(autoLink.value);
    qr.make();
    autoQrSvg.value = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch (e) { autoQrSvg.value = ''; }
}

watch([() => props.show, () => picked.value, () => current.value && current.value.url], ([open]) => {
  qrSvg.value = '';
  qrError.value = '';
  qrBusy.value = false;
  qrSeq += 1;
  if (open) { nextTick(() => renderQr()); setTimeout(renderQr, 350); }
}, { immediate: true });

function renderQr() {
  const c = current.value;
  const seq = ++qrSeq;
  qrSvg.value = '';
  qrError.value = '';
  if (!c || !c.url) {
    qrError.value = '暂无可编码的链接';
    return;
  }
  if (!c.allowed) {
    qrError.value = `${c.label} 暂未开放`;
    return;
  }
  qrBusy.value = true;
  props
    .loadQr()
    .then((qrcode) => {
      if (seq !== qrSeq || !props.show) return;
      const qr = qrcode(0, 'M');
      qr.addData(c.url);
      qr.make();
      qrSvg.value = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    })
    .catch((err) => {
      if (seq === qrSeq) qrError.value = (err && err.message) || '二维码生成失败';
    })
    .finally(() => {
      if (seq === qrSeq) qrBusy.value = false;
    });
}

const qrHint = computed(() => {
  const c = current.value;
  if (!c) return '';
  if (!c.url) return `这个订阅没有生成 ${c.label} 的链接。`;
  if (!c.allowed) return `${c.label} 尚未开放，暂不能导入。`;
  return `用 ${c.label} 扫码导入；节点更新会跟随订阅，随时可以回来重新扫码。`;
});

/* ---------------- 通用交互 ---------------- */

const emitCopy = (text) => {
  if (text) emit('copy', text);
};
const copyLink = () => {
  if (previewReady.value) emitCopy(currentUrl.value);
};
const openUrl = (url) => {
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
};
const openLink = () => {
  if (previewReady.value) openUrl(currentUrl.value);
};

const downloading = ref(false);
async function doDownload() {
  const c = current.value;
  if (!c || !c.url || !c.allowed) return;
  downloading.value = true;
  try {
    if (typeof props.download === 'function') await props.download(props.profile, c.id);
    else openUrl(c.url);
  } finally {
    downloading.value = false;
  }
}

/* ---------------- 预览：拉取 + 解析 + 渲染 ---------------- */

const MAX_LINES = 2000;
const previewCache = new Map();
let pvSeq = 0;

const pv = reactive({
  open: false,
  view: 'visual',
  theme: 'dark',
  loading: false,
  error: '',
  kind: '',
  text: '',
  size: 0,
  ms: 0,
  at: 0,
});

function openPreview() {
  if (!previewReady.value) return;
  pv.view = 'visual';
  pv.theme = state.theme === 'light' ? 'light' : 'dark';
  pv.open = true;
  pv.error = '';
  loadPreview(false);
}
function closePreview() {
  pv.open = false;
  pvSeq += 1;
}

function friendlyError(e) {
  const msg = String((e && e.message) || e || '预览失败');
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) {
    return '浏览器读不到这个订阅链接：可能是跨域限制、网络不可达，或订阅已经失效。可以先点「打开链接」在浏览器里确认。';
  }
  return msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
}

function errorLine(text) {
  const s =
    String(text || '')
      .split('\n')
      .map((x) => x.replace(/^#+\s*/, '').trim())
      .filter(Boolean)[0] || '';
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

function normalizeContent(raw) {
  const text = String(raw || '');
  const compact = text.replace(/\s+/g, '');
  if (compact.length > 64 && /^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    try {
      let b64 = compact.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const decoded = atob(b64);
      if (decoded.includes('://')) return { kind: 'links', text: decoded };
    } catch {
      /* 不是 Base64，继续往下判断 */
    }
  }
  if (text.trim().startsWith('{')) return { kind: 'json', text };
  if (/^(proxies|proxy-groups|proxy-providers|mixed-port|port|socks-port|redir-port|tproxy-port|allow-lan|mode|log-level|external-controller|dns|rules|rule-providers):/m.test(text)) {
    return { kind: 'yaml', text };
  }
  return { kind: 'text', text };
}

function applyPreview(data) {
  pv.kind = data.kind;
  pv.text = data.text;
  pv.size = data.size;
  pv.ms = data.ms;
  pv.at = data.at;
  pv.error = '';
  pv.loading = false;
}

async function loadPreview(force) {
  const c = current.value;
  if (!c || !c.url) {
    pv.loading = false;
    pv.text = '';
    pv.kind = '';
    pv.error = c ? `${c.label} 没有可预览的链接。` : '没有可预览的客户端。';
    return;
  }
  if (!c.allowed) {
    pv.error = `${c.label} 暂未开放，无法预览。`;
    pv.loading = false;
    return;
  }
  if (!force) {
    const hit = previewCache.get(c.id);
    if (hit) {
      applyPreview(hit);
      return;
    }
  }
  const ticket = ++pvSeq;
  pv.loading = true;
  pv.error = '';
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    const previewUrl = (() => {
      try {
        const u = new URL(c.url, location.href);
        if (u.pathname.startsWith('/s/')) return u.pathname + u.search;
        return u.href;
      } catch { return c.url; }
    })();
    const res = await fetch(previewUrl, { cache: 'no-store', credentials: 'same-origin', redirect: 'follow' });
    const raw = await res.text();
    if (ticket !== pvSeq) return;
    if (!res.ok) throw new Error(errorLine(raw) || `HTTP ${res.status}`);
    if (!raw.trim()) throw new Error('服务器返回了空内容');
    const norm = normalizeContent(raw);
    const data = {
      kind: norm.kind,
      text: norm.text,
      size: new Blob([raw]).size,
      ms: Math.max(0, Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started)),
      at: Date.now(),
    };
    previewCache.set(c.id, data);
    applyPreview(data);
  } catch (e) {
    if (ticket !== pvSeq) return;
    pv.loading = false;
    pv.text = '';
    pv.kind = '';
    pv.error = friendlyError(e);
  }
}

/* 切换客户端时，若预览已打开则跟着换一份内容。 */
watch(
  () => picked.value,
  () => {
    if (props.show && pv.open) loadPreview(false);
  },
);

/* 生成 YAML / JSON / 链接的可视化摘要。 */
const cleanYaml = (v) =>
  String(v == null ? '' : v)
    .trim()
    .replace(/\s+#.*$/, '')
    .replace(/^["']|["']$/g, '')
    .trim();

function parseYaml(text) {
  const groups = [];
  const nodes = [];
  const keys = [];
  let section = '';
  let cur = null;
  let rules = 0;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      const m = line.match(/^([A-Za-z][\w-]*):/);
      section = m ? m[1] : '';
      if (m) keys.push(m[1]);
      cur = null;
    }
    if (section === 'proxies') {
      if (/^\s*-\s*(name:|\{)/.test(line)) {
        const nm = line.match(/name:\s*(?:"([^"]*)"|'([^']*)'|([^,\n}]+))/);
        nodes.push({ name: nm ? cleanYaml(nm[1] || nm[2] || nm[3] || '') : '', type: '' });
      }
    } else if (section === 'proxy-groups') {
      const nm = line.match(/^\s*-\s*name:\s*(.+)$/);
      if (nm) {
        cur = { name: cleanYaml(nm[1]), type: '', members: [] };
        groups.push(cur);
        continue;
      }
      if (!cur) continue;
      const t = line.match(/^\s*type:\s*(.+)$/);
      if (t) {
        cur.type = cleanYaml(t[1]);
        continue;
      }
      const mm = line.match(/^\s*-\s*(.+)$/);
      if (mm && !/^\s*-\s*(name|type):/.test(line)) cur.members.push(cleanYaml(mm[1]));
    } else if (section === 'rules') {
      if (/^\s*-\s*\S/.test(line)) rules += 1;
    }
  }
  return { kind: 'yaml', nodes, groups, rules, keys };
}

function parseJson(text) {
  const conf = JSON.parse(text);
  const groups = [];
  const nodes = [];
  for (const ob of Array.isArray(conf.outbounds) ? conf.outbounds : []) {
    if (!ob || !ob.type) continue;
    const type = String(ob.type);
    const name = String(ob.tag || '');
    if (/^(selector|urltest|fallback|loadbalance|load-balance)$/i.test(type)) {
      groups.push({ name, type, members: (ob.outbounds || ob.proxies || []).map(String) });
    } else if (!/^(direct|block|dns)$/i.test(type)) {
      nodes.push({ name, type });
    }
  }
  const rules = conf.route && Array.isArray(conf.route.rules) ? conf.route.rules.length : 0;
  return { kind: 'json', nodes, groups, rules, keys: Object.keys(conf) };
}

function parseLinks(text) {
  const nodes = [];
  for (const raw of String(text || '').split('\n')) {
    const s = raw.trim();
    if (!s || /^#/.test(s) || !s.includes('://')) continue;
    const scheme = s.slice(0, s.indexOf('://')).toLowerCase();
    let name = '';
    const hash = s.split('#')[1];
    if (hash) {
      try {
        name = decodeURIComponent(hash);
      } catch {
        name = hash;
      }
    }
    if (!name) {
      const host = s.split('@')[1];
      name = host ? host.split(/[?/:]/)[0] : scheme;
    }
    nodes.push({ name, type: scheme });
  }
  return { nodes, groups: [], rules: 0, keys: [], kind: 'links' };
}

function parseIni(text) {
  const nodes = [];
  const groups = [];
  const keys = [];
  let rules = 0;
  let sec = '';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line) || line.startsWith('//')) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) {
      sec = head[1].trim().toLowerCase();
      keys.push(head[1].trim());
      continue;
    }
    if (sec.includes('rule')) {
      rules += 1;
      continue;
    }
    const pair = line.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (!pair) continue;
    const name = cleanYaml(pair[1]);
    const parts = pair[2].split(',').map((x) => x.trim()).filter(Boolean);
    if (sec.includes('group') || sec.includes('policy')) {
      groups.push({ name, type: parts[0] || '', members: parts.slice(1) });
    } else if (sec.includes('proxy') || sec.includes('server') || sec.includes('outbound')) {
      nodes.push({ name, type: parts[0] || '' });
    }
  }
  return { kind: 'ini', nodes, groups, rules, keys };
}

const structure = computed(() => {
  const text = pv.text || '';
  if (!text.trim()) return { nodes: [], groups: [], rules: 0, keys: [], kind: 'empty' };
  try {
    if (pv.kind === 'json') return parseJson(text);
    if (pv.kind === 'links') return parseLinks(text);
    if (pv.kind === 'yaml') return parseYaml(text);
    if (text.trim().startsWith('{')) return parseJson(text);
    if (/^(proxies|proxy-groups):/m.test(text)) return parseYaml(text);
    if (/^\s*\[[^\]]+\]\s*$/m.test(text)) return parseIni(text);
    return parseLinks(text);
  } catch {
    return { nodes: [], groups: [], rules: 0, keys: [], kind: 'error' };
  }
});

const GROUP_TYPE_LABELS = {
  select: '手动选择',
  selector: '手动选择',
  'url-test': '自动测速',
  urltest: '自动测速',
  fallback: '故障转移',
  'load-balance': '负载均衡',
  loadbalance: '负载均衡',
  relay: '链式代理',
};
const groupTypeLabel = (t) => {
  const k = String(t || '').trim().toLowerCase();
  return GROUP_TYPE_LABELS[k] || k || '代理组';
};

const GROUP_COLORS = ['#6366f1', '#34d399', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#14b8a6', '#8b5cf6'];
function groupColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

const previewKindLabel = computed(() => {
  if (pv.kind === 'json') return 'sing-box / JSON';
  if (pv.kind === 'yaml') return 'Clash / YAML';
  if (pv.kind === 'links') return '节点订阅（已解码）';
  if (structure.value.kind === 'ini') return 'Surge / Loon / INI 配置';
  if (pv.kind === 'text') return '纯文本配置';
  return '配置内容';
});

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
};
const fmtTime = (ts) => {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
};

/* 配置文件视图：JSON 先格式化，Base64 链接已在上游解码。 */
const displayText = computed(() => {
  const raw = String(pv.text || '');
  if (pv.kind === 'json') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
});

const totalLines = computed(() => displayText.value.split('\n').length);
const codeLines = computed(() =>
  displayText.value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(0, MAX_LINES)
    .map((line, i) => ({ i, html: highlight(line) })),
);
const codeTruncated = computed(() => totalLines.value > MAX_LINES);

/* 与 ConvertView 实时预览一致的 YAML 高亮（暗/亮由 .sl-code 的变量决定）。 */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const HIGHLIGHT_RE = /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(^[ \t]*-)|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?)|([A-Za-z0-9_.-]+)(?=\s*:)/g;
function highlight(line) {
  const src = String(line);
  HIGHLIGHT_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = HIGHLIGHT_RE.exec(src))) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'dash' : m[4] ? 'bool' : m[5] ? 'num' : 'key';
    out += `<span class="syn-${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(src.slice(last));
  return out || '&nbsp;';
}

/* 打开 / 关闭弹窗：复位 tab、预览和二维码；每次打开都重新拉预览，
 * 避免订阅在后台更新后仍显示旧内容。 */
watch(
  () => props.show,
  (open) => {
    pv.open = false;
    pv.error = '';
    pv.loading = false;
    pvSeq += 1;
    qrSvg.value = '';
    qrError.value = '';
    qrBusy.value = false;
    qrSeq += 1;
    if (!open) return;
    previewCache.clear();
    tab.value = 'link';
    pv.view = 'visual';
    pv.text = '';
    pv.kind = '';
    picked.value = pickDefault();
  },
  { immediate: true },
);

/* profile 被替换（列表刷新）时缓存失效，防止拿旧订阅的内容。 */
watch(
  () => (props.profile && props.profile.token) || '',
  () => {
    previewCache.clear();
    pv.open = false;
    pv.text = '';
    pv.kind = '';
    pv.error = '';
    pv.loading = false;
    pvSeq += 1;
    tab.value = 'link';
  },
);
</script>

<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    title="订阅配置"
    style="width: 800px; max-width: 96vw"
    content-style="max-height: calc(100vh - 180px); overflow: auto;"
  >
    <div v-if="profile" class="sl">
      <div class="sl-head">
        <span class="sl-avatar"><UiIcon name="file-text" :size="17" /></span>
        <div class="sl-head-txt">
          <div class="sl-title">{{ profile.name }}</div>
          <div class="sl-sub">链接、二维码、下载与预览都在这里：先选客户端，再决定导入方式。</div>
        </div>
        <span v-if="clients.length" class="sl-count">{{ openCount }}/{{ clients.length }} 已开放</span>
      </div>

      <div v-if="!clients.length && !autoLink" class="sl-empty">
        <UiIcon name="alert-circle" :size="18" />
        <p>订阅仍在生成中，暂时没有可用链接。</p>
      </div>

      <template v-else>
        <section v-if="clients.length" class="sl-sec">
          <div class="sl-sec-head">
            <span>选择客户端</span>
            <span class="sl-sec-hint">共 {{ clients.length }} 种 · 已开放 {{ openCount }} 种</span>
          </div>
          <div class="sl-brands">
            <button
              v-for="c in clients"
              :key="c.id"
              type="button"
              class="sl-brand"
              :class="{ on: picked === c.id, dim: !c.url || !c.allowed }"
              :style="{ '--brand': c.accent }"
              :aria-pressed="picked === c.id"
              :title="c.url ? `${c.label}${c.allowed ? '' : '（未开放）'}` : `${c.label}：这个订阅还没有生成该格式的链接`"
              @click="picked = c.id"
            >
              <span class="sl-brand-ico">
                <svg class="sl-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false" v-html="glyphOf(c.id)" />
              </span>
              <span class="sl-brand-txt">
                <span class="sl-brand-name">{{ c.label }}</span>
                <span class="sl-brand-sub">{{ c.subtitle }}</span>
              </span>
              <span v-if="!c.allowed" class="sl-brand-tag">未开放</span>
              <span v-else-if="!c.url" class="sl-brand-tag muted">无链接</span>
            </button>
          </div>
        </section>

        <template v-if="current">
          <div class="sl-selected" :style="{ '--brand': current.accent }">
            <span class="sl-brand-ico sm">
              <svg class="sl-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false" v-html="glyphOf(current.id)" />
            </span>
            <b>{{ current.label }}</b>
            <span class="sl-selected-fmt" :class="{ yaml: current.format.ext === 'yaml' }">{{ current.format.label }}</span>
            <span class="sl-selected-file mono">{{ fileName }}</span>
            <span class="sl-selected-state" :class="{ off: !current.url || !current.allowed }">
              {{ !current.url ? '无链接' : current.allowed ? '可导入' : '未开放' }}
            </span>
          </div>

          <template v-if="!pv.open">
            <div v-if="false" class="sl-tabs" role="tablist">
              <button type="button" role="tab" class="sl-tab" :class="{ on: tab === 'link' }" :aria-selected="tab === 'link'" @click="tab = 'link'">
                <UiIcon name="link" :size="14" /> 链接
              </button>
              <button type="button" role="tab" class="sl-tab" :class="{ on: tab === 'qr' }" :aria-selected="tab === 'qr'" @click="tab = 'qr'">
                <UiIcon name="qr" :size="14" /> 二维码
              </button>
              <button type="button" role="tab" class="sl-tab" :class="{ on: tab === 'download' }" :aria-selected="tab === 'download'" @click="tab = 'download'">
                <UiIcon name="download" :size="14" /> 下载
              </button>
              <button type="button" class="sl-prevbtn" :disabled="!previewReady" @click="openPreview">
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path d="M2.2 12S5.8 5.8 12 5.8 21.8 12 21.8 12 18.2 18.2 12 18.2 2.2 12 2.2 12Z" fill="none" stroke="currentColor" stroke-width="1.7" />
                  <circle cx="12" cy="12" r="2.9" fill="none" stroke="currentColor" stroke-width="1.7" />
                </svg>
                预览
              </button>
            </div>

            <div class="sl-pane sl-media">
              <div class="sl-qr-box">
                <div v-if="qrSvg" class="sl-qr" v-html="qrSvg" />
                <div v-else-if="qrBusy" class="sl-qr-state">正在生成二维码…</div>
                <div v-else class="sl-qr-state err">{{ qrError || '暂无可编码的链接' }}</div>
              </div>
              <div class="sl-media-main">
                <div class="sl-field">
                  <span class="sl-field-label">订阅链接</span>
                  <div class="sl-url mono" :class="{ empty: !current.url }" :title="current.url || ''">{{ current.url || '该客户端暂无链接' }}</div>
                </div>
                <div class="sl-actions">
                  <n-button size="small" :disabled="!previewReady" @click="copyLink">
                    <template #icon><UiIcon name="copy" :size="14" /></template>
                    复制链接
                  </n-button>
                  <n-button size="small" tertiary :disabled="!previewReady" @click="openLink">
                    <template #icon><UiIcon name="external" :size="14" /></template>
                    打开
                  </n-button>
                  <n-button type="primary" size="small" :loading="downloading" :disabled="!previewReady" @click="doDownload">
                    <template #icon><UiIcon name="download" :size="14" /></template>
                    下载配置
                  </n-button>
                  <n-button size="small" quaternary :disabled="!previewReady" @click="openPreview">预览</n-button>
                </div>
                <p class="sl-hint">下载得到 {{ fileName }}，导入后节点与规则都来自当前订阅；每次下载会消耗一次订阅拉取。</p>
                <p v-if="current.url && !current.allowed" class="sl-warn">{{ current.label }} 尚未开放，链接与下载暂不可用。</p>
                <p v-else-if="!current.url" class="sl-warn">这个订阅没有 {{ current.label }} 格式的输出。</p>
              </div>
            </div>
          </template>

          <div v-else class="sl-preview">
            <div class="sl-prev-head">
              <button type="button" class="sl-back" @click="closePreview">
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                  <path d="M14.5 5.5 8 12l6.5 6.5M8.4 12H20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                返回
              </button>
              <span class="sl-prev-title">预览 <b class="mono">{{ fileName }}</b></span>
              <span class="sl-seg">
                <button type="button" :class="{ on: pv.view === 'visual' }" @click="pv.view = 'visual'">可视化</button>
                <button type="button" :class="{ on: pv.view === 'config' }" @click="pv.view = 'config'">配置文件</button>
              </span>
              <button
                v-if="pv.view === 'config'"
                type="button"
                class="sl-iconbtn"
                :title="pv.theme === 'dark' ? '切换亮色' : '切换暗色'"
                @click="pv.theme = pv.theme === 'dark' ? 'light' : 'dark'"
              >
                <svg v-if="pv.theme === 'dark'" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="1.7" />
                  <path d="M12 2.6v2.2M12 19.2v2.2M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path d="M20.2 14.6A8.4 8.4 0 0 1 9.4 3.8 8.5 8.5 0 1 0 20.2 14.6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
                </svg>
              </button>
              <button type="button" class="sl-iconbtn" title="重新拉取" :disabled="pv.loading" @click="loadPreview(true)">
                <UiIcon name="refresh" :size="14" />
              </button>
              <button type="button" class="sl-iconbtn" title="关闭预览" @click="closePreview">
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
              </button>
            </div>

            <div v-if="pv.loading" class="sl-prev-state">
              <span class="sl-spin" />
              正在拉取订阅内容…
            </div>
            <div v-else-if="pv.error" class="sl-prev-state err">
              <UiIcon name="alert-circle" :size="16" />
              <div class="sl-prev-err-txt">{{ pv.error }}</div>
              <div class="sl-actions">
                <n-button size="tiny" @click="loadPreview(true)">重试</n-button>
                <n-button size="tiny" tertiary @click="openLink">新窗口打开</n-button>
              </div>
            </div>
            <template v-else>
              <div v-if="pv.view === 'visual'" class="sl-visual">
                <div class="sl-stats">
                  <div class="sl-stat"><b>{{ structure.nodes.length }}</b><span>节点 / 出站</span></div>
                  <div class="sl-stat"><b>{{ structure.groups.length }}</b><span>代理组</span></div>
                  <div class="sl-stat"><b>{{ structure.rules }}</b><span>规则</span></div>
                  <div class="sl-stat"><b>{{ fmtBytes(pv.size) }}</b><span>大小</span></div>
                </div>
                <div v-if="structure.groups.length" class="sl-block">
                  <div class="sl-block-head">代理组 <span>{{ structure.groups.length }}</span></div>
                  <div class="sl-groups">
                    <div v-for="(g, gi) in structure.groups" :key="gi" class="sl-group">
                      <span class="sl-group-dot" :style="{ background: groupColor(g.name) }" />
                      <div class="sl-group-main">
                        <div class="sl-group-top">
                          <b>{{ g.name || '未命名' }}</b>
                          <em>{{ groupTypeLabel(g.type) }}</em>
                          <span>{{ g.members.length }} 成员</span>
                        </div>
                        <div class="sl-members">
                          <span v-for="(m, mi) in g.members.slice(0, 6)" :key="mi" class="sl-member">{{ m }}</span>
                          <span v-if="g.members.length > 6" class="sl-member more">+{{ g.members.length - 6 }}</span>
                          <span v-if="!g.members.length" class="sl-member more">无成员</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-if="structure.nodes.length" class="sl-block">
                  <div class="sl-block-head">节点 <span>{{ structure.nodes.length }}</span></div>
                  <div class="sl-nodes">
                    <span v-for="(n, ni) in structure.nodes.slice(0, 48)" :key="ni" class="sl-node">
                      <em v-if="n.type">{{ n.type }}</em>{{ n.name || '未命名' }}
                    </span>
                    <span v-if="structure.nodes.length > 48" class="sl-node more">还有 {{ structure.nodes.length - 48 }} 个…</span>
                  </div>
                </div>
                <div v-if="!structure.groups.length && !structure.nodes.length" class="sl-prev-empty">
                  没能从内容里解析出节点或分组，可能是一个纯文本 / 错误页配置。切到「配置文件」可以查看原文。
                </div>
              </div>

              <div v-else class="sl-code" :class="{ light: pv.theme === 'light' }">
                <div class="sl-code-head">
                  <span class="sl-dot red" /><span class="sl-dot amber" /><span class="sl-dot green" />
                  <span class="sl-code-file mono">{{ fileName }}</span>
                  <span class="sl-code-meta">{{ codeLines.length }} 行 · {{ fmtBytes(pv.size) }}</span>
                  <button type="button" class="sl-code-act" @click="emitCopy(displayText)">复制</button>
                </div>
                <div class="sl-code-body">
                  <div v-for="row in codeLines" :key="row.i" class="sl-line">
                    <span class="sl-ln">{{ row.i + 1 }}</span>
                    <span class="sl-lc" v-html="row.html" />
                  </div>
                </div>
                <div v-if="codeTruncated" class="sl-code-more">
                  内容较大，预览只显示前 {{ MAX_LINES }} 行（共 {{ totalLines }} 行）；下载后可看到完整配置。
                </div>
              </div>
            </template>

            <div v-if="!pv.loading && !pv.error" class="sl-prev-foot">
              <span>{{ previewKindLabel }}</span>
              <span>拉取于 {{ fmtTime(pv.at) }}</span>
              <span>{{ pv.ms }} ms</span>
              <span class="sl-foot-note">只读预览 · 会消耗一次订阅拉取</span>
            </div>
          </div>
        </template>

        <section v-if="autoLink" class="sl-auto">
          <div class="sl-sec-head">
            <span>通用链接</span>
            <span class="sl-sec-hint">未匹配客户端时使用</span>
          </div>
          <div class="sl-url mono">{{ autoLink }}</div>
          <div class="sl-actions">
            <n-button size="small" @click="emitCopy(autoLink)">
              <template #icon><UiIcon name="copy" :size="14" /></template>
              复制
            </n-button>
            <n-button size="small" tertiary @click="openUrl(autoLink)">
              <template #icon><UiIcon name="external" :size="14" /></template>
              打开
            </n-button>
            <n-button size="small" quaternary @click="toggleAutoQr">
              <template #icon><UiIcon name="qr" :size="14" /></template>
              二维码
            </n-button>
          </div>
          <div v-if="autoQrSvg" class="sl-auto-qr" v-html="autoQrSvg" />
          <p class="sl-hint">通用链接会按请求的 User-Agent 自动判断客户端，适合手动粘贴到任意软件。</p>
        </section>
        <p v-else class="sl-hint sl-hint-block">这个订阅暂时没有通用链接，可能仍在生成中。</p>
      </template>
    </div>
  </n-modal>
</template>

<style scoped>
.sl {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ---------- 头部 ---------- */
.sl-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.sl-avatar {
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 10px;
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent);
}
.sl-head-txt {
  flex: 1;
  min-width: 0;
}
.sl-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-sub {
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-dim);
}
.sl-count {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 10.5px;
  color: var(--text-dim);
  white-space: nowrap;
}

.sl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 30px 12px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  color: var(--text-dim);
}
.sl-empty p {
  margin: 0;
  font-size: 12.5px;
}

/* ---------- 区块与客户端图标 ---------- */
.sl-sec {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sl-sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-dim);
}
.sl-sec-hint {
  font-weight: 400;
  font-size: 10.5px;
  color: var(--text-dim);
  opacity: 0.85;
}

.sl-brands {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 8px;
}
.sl-brand {
  --brand: var(--accent);
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-strong);
  color: var(--text-dim);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.14s ease,
    background 0.14s ease,
    box-shadow 0.14s ease,
    opacity 0.14s ease;
}
.sl-brand:hover {
  border-color: color-mix(in srgb, var(--brand) 50%, var(--line));
}
.sl-brand:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand) 65%, transparent);
  outline-offset: 1px;
}
.sl-brand.on {
  border-color: color-mix(in srgb, var(--brand) 62%, transparent);
  background: color-mix(in srgb, var(--brand) 13%, var(--panel-strong));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--brand) 24%, transparent);
}
.sl-brand.dim {
  opacity: 0.5;
  filter: grayscale(0.9);
}
.sl-brand.dim.on {
  opacity: 0.82;
  filter: grayscale(0.25);
}
.sl-brand-ico {
  width: 28px;
  height: 28px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--brand) 30%, transparent);
  background: color-mix(in srgb, var(--brand) 14%, transparent);
  color: var(--brand);
}
.sl-brand-ico.sm {
  width: 24px;
  height: 24px;
  border-radius: 7px;
}
html[data-theme='light'] .sl-brand-ico {
  color: color-mix(in srgb, var(--brand) 72%, #0f172a);
}
.sl-glyph {
  width: 17px;
  height: 17px;
  display: block;
}
.sl-brand-ico.sm .sl-glyph {
  width: 14px;
  height: 14px;
}
.sl-brand-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sl-brand-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-brand-sub {
  font-size: 10px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-brand-tag {
  flex: none;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 9.5px;
  line-height: 15px;
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.sl-brand-tag.muted {
  color: var(--text-dim);
  border-color: var(--line);
  background: transparent;
}

/* ---------- 当前选中 ---------- */
.sl-selected {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 7px 10px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  background: color-mix(in srgb, var(--brand, var(--accent)) 5%, transparent);
}
.sl-selected b {
  font-size: 12.5px;
  color: var(--text);
}
.sl-selected-fmt {
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 5px;
  font-size: 10px;
  color: var(--text-dim);
}
.sl-selected-fmt.yaml {
  color: #10b981;
  border-color: color-mix(in srgb, #10b981 40%, transparent);
  background: color-mix(in srgb, #10b981 10%, transparent);
}
html[data-theme='light'] .sl-selected-fmt.yaml {
  color: #047857;
}
.sl-selected-file {
  margin-left: auto;
  max-width: 46%;
  font-size: 10.5px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-selected-state {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  color: #34d399;
  border: 1px solid color-mix(in srgb, #34d399 40%, transparent);
}
.sl-selected-state.off {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 40%, transparent);
}
html[data-theme='light'] .sl-selected-state {
  color: #047857;
}
html[data-theme='light'] .sl-selected-state.off {
  color: #b45309;
}

/* ---------- tab ---------- */
.sl-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line-soft);
}
.sl-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.sl-tab:hover {
  color: var(--text);
  background: var(--panel-strong);
}
.sl-tab.on {
  color: var(--accent-2, var(--accent));
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
html[data-theme='light'] .sl-tab.on {
  color: #4f46e5;
}
.sl-prevbtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin-left: auto;
  padding: 0 12px;
  border: 1px dashed var(--accent-line);
  border-radius: 8px;
  background: transparent;
  color: var(--accent-2, var(--accent));
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.sl-prevbtn:hover:not(:disabled) {
  background: var(--accent-soft);
}
.sl-prevbtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
html[data-theme='light'] .sl-prevbtn {
  color: #4f46e5;
}

/* ---------- 面板 ---------- */
.sl-pane {
  display: flex;
  flex-direction: column;
  gap: 11px;
  min-height: 188px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-strong);
}
.sl-pane-qr {
  flex-direction: row;
  align-items: center;
  gap: 18px;
}
.sl-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.sl-field-label {
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.sl-url {
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel);
  color: var(--text);
  font-size: 11.5px;
  line-height: 1.65;
  word-break: break-all;
}
.sl-url.empty {
  color: var(--text-dim);
  border-style: dashed;
}
.sl-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sl-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.65;
  color: var(--text-dim);
}
.sl-hint-block {
  padding: 10px 2px;
}
.sl-warn {
  margin: 0;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 8%, transparent);
  color: var(--text);
  font-size: 11.5px;
  line-height: 1.6;
}

/* ---------- 二维码 ---------- */
.sl-qr-box {
  width: 176px;
  height: 176px;
  flex: none;
  display: grid;
  place-items: center;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
}
.sl-qr {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
}
.sl-qr :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.sl-qr-state {
  font-size: 11.5px;
  line-height: 1.6;
  text-align: center;
  color: #6b7280;
}
.sl-qr-state.err {
  color: #b91c1c;
}
.sl-qr-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.sl-qr-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

/* ---------- 下载 ---------- */
.sl-file {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  background: var(--panel);
}
.sl-file-ico {
  width: 38px;
  height: 38px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid var(--accent-line);
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
}
.sl-file-txt {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.sl-file-txt b {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-file-txt span {
  font-size: 10.5px;
  color: var(--text-dim);
}

/* ---------- 预览外壳 ---------- */
.sl-preview {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg-soft);
}
.sl-prev-head {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.sl-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel-strong);
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.sl-back:hover {
  color: var(--text);
  border-color: var(--accent-line);
}
.sl-prev-title {
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-prev-title b {
  font-weight: 550;
  color: var(--text);
}
.sl-seg {
  display: inline-flex;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-strong);
}
.sl-seg button {
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.sl-seg button.on {
  color: var(--text);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent-line);
}
.sl-iconbtn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel-strong);
  color: var(--text-dim);
  cursor: pointer;
}
.sl-iconbtn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent-line);
}
.sl-iconbtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sl-prev-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 240px;
  padding: 40px 16px;
  border: 1px dashed var(--line);
  border-radius: 10px;
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
}
.sl-prev-state.err {
  color: var(--text);
}
.sl-prev-err-txt {
  max-width: 520px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-dim);
}
.sl-spin {
  width: 16px;
  height: 16px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: sl-spin 0.8s linear infinite;
}
@keyframes sl-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------- 可视化 ---------- */
.sl-visual {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.sl-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
}
.sl-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--line-soft);
  border-radius: 9px;
  background: var(--panel-strong);
}
.sl-stat b {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.sl-stat span {
  font-size: 10px;
  color: var(--text-dim);
}
.sl-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sl-block-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.sl-block-head span {
  font-weight: 400;
  opacity: 0.8;
}
.sl-groups {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 210px;
  overflow: auto;
  padding-right: 2px;
}
.sl-group {
  display: flex;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--line-soft);
  border-radius: 9px;
  background: var(--panel-strong);
}
.sl-group-dot {
  width: 3px;
  flex: none;
  border-radius: 3px;
}
.sl-group-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sl-group-top {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-dim);
}
.sl-group-top b {
  font-size: 12px;
  font-weight: 550;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-group-top em {
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--line);
  border-radius: 4px;
  font-style: normal;
  font-size: 9.5px;
  line-height: 15px;
  color: var(--text-dim);
}
.sl-members {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sl-member {
  max-width: 140px;
  padding: 1px 6px;
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  background: var(--panel);
  font-size: 10px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-member.more {
  border-style: dashed;
}
.sl-nodes {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 160px;
  overflow: auto;
}
.sl-node {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--panel-strong);
  font-size: 10.5px;
  color: var(--text-dim);
}
.sl-node em {
  font-style: normal;
  font-size: 9px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent-2, var(--accent));
}
html[data-theme='light'] .sl-node em {
  color: #4f46e5;
}
.sl-prev-empty {
  padding: 26px 14px;
  border: 1px dashed var(--line);
  border-radius: 10px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-dim);
  text-align: center;
}

/* ---------- 配置文件（亮暗两套，贴合 ConvertView 的实时预览） ---------- */
.sl-code {
  --c-bg: #0a0b10;
  --c-head: rgba(255, 255, 255, 0.04);
  --c-line: rgba(255, 255, 255, 0.08);
  --c-ln: #0a0b10;
  --c-ln-text: #4b5563;
  --c-text: #e5e7eb;
  --c-key: #8ab4ff;
  --c-str: #7ee0b8;
  --c-num: #f5b57a;
  --c-bool: #c792ea;
  --c-com: #5c677d;
  --c-dash: #f78fb3;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--c-bg);
}
.sl-code.light {
  --c-bg: #ffffff;
  --c-head: #f6f8fa;
  --c-line: #e5e7eb;
  --c-ln: #ffffff;
  --c-ln-text: #8c959f;
  --c-text: #1f2328;
  --c-key: #0550ae;
  --c-str: #0a7d33;
  --c-num: #953800;
  --c-bool: #8250df;
  --c-com: #6e7781;
  --c-dash: #cf222e;
}
.sl-code-head {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--c-line);
  background: var(--c-head);
}
.sl-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
}
.sl-dot.red {
  background: #f87171;
}
.sl-dot.amber {
  background: #fbbf24;
}
.sl-dot.green {
  background: #34d399;
}
.sl-code-file {
  margin-left: 6px;
  font-size: 10.5px;
  color: #9aa6bd;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-code.light .sl-code-file {
  color: #57606a;
}
.sl-code-meta {
  flex: none;
  margin-left: auto;
  font-size: 10px;
  color: #7d8799;
}
.sl-code.light .sl-code-meta {
  color: #6e7781;
}
.sl-code-act {
  flex: none;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--c-line);
  border-radius: 5px;
  background: transparent;
  color: #d1d5db;
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.sl-code.light .sl-code-act {
  color: #1f2328;
}
.sl-code-act:hover {
  border-color: var(--accent);
  color: #fff;
}
.sl-code.light .sl-code-act:hover {
  color: #fff;
}
.sl-code-body {
  max-height: clamp(220px, 38vh, 380px);
  overflow: auto;
  padding: 6px 0;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.62;
  color: var(--c-text);
}
.sl-line {
  display: flex;
  align-items: flex-start;
  min-width: max-content;
}
.sl-ln {
  flex: none;
  width: 46px;
  padding: 0 9px 0 0;
  border-right: 1px solid var(--c-line);
  background: var(--c-ln);
  color: var(--c-ln-text);
  text-align: right;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.sl-lc {
  padding: 0 10px 0 9px;
  white-space: pre;
}
.sl-code-more {
  padding: 7px 10px;
  border-top: 1px solid var(--c-line);
  background: var(--c-head);
  font-size: 10.5px;
  color: #9aa6bd;
}
.sl-code.light .sl-code-more {
  color: #57606a;
}
.sl-code :deep(.syn-key) {
  color: var(--c-key);
}
.sl-code :deep(.syn-str) {
  color: var(--c-str);
}
.sl-code :deep(.syn-num) {
  color: var(--c-num);
}
.sl-code :deep(.syn-bool) {
  color: var(--c-bool);
}
.sl-code :deep(.syn-com) {
  color: var(--c-com);
  font-style: italic;
}
.sl-code :deep(.syn-dash) {
  color: var(--c-dash);
}

/* ---------- 底部 ---------- */
.sl-prev-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 0 2px;
  font-size: 10px;
  color: var(--text-dim);
}
.sl-foot-note {
  margin-left: auto;
  opacity: 0.8;
}
.sl-auto {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--text) 2%, transparent);
}

@media (max-width: 640px) {
  .sl-brands {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
  .sl-pane-qr {
    flex-direction: column;
    align-items: stretch;
  }
  .sl-qr-box {
    width: 150px;
    height: 150px;
    margin: 0 auto;
  }
  .sl-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .sl-selected-file {
    max-width: 100%;
    margin-left: 0;
  }
}
.sl-pane + .sl-pane { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--line-soft, #26314a); }
.sl-pane { border: 0; border-radius: 0; background: transparent; padding: 14px 0; }
.sl-pane:first-of-type { padding-top: 4px; }
.sl-pane + .sl-pane { margin-top: 0; border-top: 1px dashed var(--line-soft, #26314a); }
.sl-head { order: 0; }
.sl-auto { order: 1; }
.sl-sec, .sl-pane { order: 2; }
.sl-auto { border: 1px solid var(--line, #26314a); border-radius: 12px; padding: 12px 14px; background: var(--panel-strong, rgba(255,255,255,.02)); }
.sl-auto-qr { width: 148px; height: 148px; margin-top: 10px; padding: 8px; border-radius: 10px; background: #fff; }
.sl-auto-qr :deep(svg) { width: 100%; height: 100%; display: block; }
.sl-media { flex-direction: row; align-items: flex-start; gap: 20px; }
.sl-media .sl-qr-box { width: 204px; height: 204px; border-radius: 14px; }
.sl-media-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 11px; }
.sl-media .sl-url { width: 100%; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sl-media .sl-field { min-width: 0; }
.sl-media .sl-actions { flex-wrap: wrap; }
@media (max-width: 720px) { .sl-media { flex-direction: column; } .sl-media .sl-qr-box { width: 100%; max-width: 240px; align-self: center; } }
</style>







