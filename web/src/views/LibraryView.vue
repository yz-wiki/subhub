<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import {
  NCard, NTabs, NTabPane, NInput, NButton, NTag, NModal, NSelect, NSpin,
  NSwitch, NInputNumber, NTooltip, useMessage, useDialog,
} from 'naive-ui';
import { state, loadState, can } from '../state.js';
import { api } from '../api.js';
import CodeEditor from '../components/CodeEditor.vue';
import DiffView from '../components/DiffView.vue';
import BaseDnsForm from '../components/BaseDnsForm.vue';
import IconCatManager from '../components/IconCatManager.vue';
import UiIcon from '../components/UiIcon.vue';
import RulesetMetaTip from '../components/RulesetMetaTip.vue';
import rulesetMeta from '../data/rulesetMeta.json';
import {
  PRESET_COLORS, SWATCHES, UNCAT,
  iconCatChips as makeIconCatChips, iconCatList as makeIconCatList,
  iconCatOptions as makeIconCatOptions, iconCatLabel as labelForIconCat,
  resolveIconCat as resolveCatKey, ensureIconCat, syncIconCats,
} from '../components/iconCats.js';

const message = useMessage();
const dialog = useDialog();
const tab = ref('ruleset');
const DENSITY_KEY = 'subhub.libDensity';
const density = ref(localStorage.getItem(DENSITY_KEY) || 'normal');
watch(density, (v) => localStorage.setItem(DENSITY_KEY, v));

const DEFAULT_GROUP = '🚀 节点选择';

const q = ref('');
const results = ref([]);
const total = ref(0);
const searching = ref(false);
let timer = 0;

async function search(v) {
  q.value = v;
  clearTimeout(timer);
  if (!String(v || '').trim()) { results.value = []; total.value = 0; return; }
  timer = setTimeout(async () => {
    searching.value = true;
    try {
      const data = await api(`/api/rules?limit=24&q=${encodeURIComponent(v)}`);
      // 目录条目没有 tags，说明也偏模板化：用 rulesetMeta.json 补名称 / 说明 / 标签
      results.value = (data.items || []).map((it) => {
        const meta = rulesetMetaFor(it);
        const ownDesc = String(it.desc || '').trim();
        return {
          ...it,
          meta,
          title: String(it.zh || it.label || (meta && meta.name) || it.name || it.id || '').trim(),
          desc: composeDesc(ownDesc, meta),
          tags: mergeRulesetTags(it.tags, meta),
        };
      });
      total.value = data.total || 0;
    } catch (e) { message.error(e.message); }
    searching.value = false;
  }, 220);
}

const rulesets = computed(() => state.library.rulesets || []);

/* ── 分类：优先后端 categories，缺失时按规则集 cat 聚合兜底 ── */
const categories = computed(() => {
  const raw = Array.isArray(state.library && state.library.categories) ? state.library.categories : [];
  if (raw.length) {
    return raw
      .filter((c) => c && String(c.name || '').trim())
      .map((c, i) => ({
        name: String(c.name).trim(),
        color: String(c.color || '').trim() || PRESET_COLORS[i % PRESET_COLORS.length],
        order: Number.isFinite(c.order) ? c.order : i,
        count: Number(c.count) || 0,
      }));
  }
  const seen = new Map();
  for (const r of rulesets.value) {
    const name = String(r.cat || '').trim() || UNCAT;
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  return [...seen.entries()].map(([name, count], i) => ({
    name, count, order: i, color: PRESET_COLORS[i % PRESET_COLORS.length],
  }));
});

const catFilter = ref('');

/** 同一个分类永远同一个颜色：先查 categories，查不到再按调色板 index 回退 */
function catColor(name) {
  const key = String(name || '').trim();
  if (!key) return 'var(--text-dim)';
  const hit = categories.value.find((c) => c.name === key);
  if (hit && hit.color) return hit.color;
  const names = categories.value.map((c) => c.name);
  for (const r of rulesets.value) {
    const n = String(r.cat || '').trim();
    if (n && !names.includes(n)) names.push(n);
  }
  const idx = names.indexOf(key);
  return PRESET_COLORS[(idx < 0 ? 0 : idx) % PRESET_COLORS.length];
}

/* 来源仓库用与分类不同的一套色：按名称做稳定 hash，取 6 色之一。
   同一仓库在深/浅色主题、刷新后颜色都不变，也不再为未知仓库退化成灰色。 */
const REPO_PALETTE = ['#3b82f6', '#8b5cf6', '#0ea5e9', '#f59e0b', '#10b981', '#ec4899'];
function hashString(value) {
  let h = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function repoColor(repo) {
  const key = String(repo || '').trim() || '内置';
  return REPO_PALETTE[hashString(key) % REPO_PALETTE.length];
}

/* ── 规则集分类新增 / 管理 ── */
const catManageOpen = ref(false);
const catRows = ref([]);
const catQuick = reactive({ name: '', color: PRESET_COLORS[2] });
const catBusy = ref(false);
const catDelete = ref({ open: false, name: '', count: 0, moveTo: '', options: [] });
const catOptions = computed(() => categories.value.map((c) => ({ label: c.name, value: c.name })));

function applyCategories(list) {
  if (Array.isArray(list) && state.library) state.library.categories = list;
}

function syncCatRows() {
  catRows.value = categories.value.map((c) => ({
    name: c.name,
    count: c.count,
    editName: c.name,
    editColor: c.color || PRESET_COLORS[0],
  }));
}

function openCatManage() {
  syncCatRows();
  catQuick.name = '';
  catQuick.color = PRESET_COLORS[(categories.value.length + 2) % PRESET_COLORS.length];
  catManageOpen.value = true;
}

function catMoveOptions(name) {
  const out = categories.value.filter((c) => c.name !== name).map((c) => ({ label: c.name, value: c.name }));
  if (!out.some((o) => o.value === UNCAT)) out.unshift({ label: UNCAT, value: UNCAT });
  return out;
}

/** 新增分类的公共入口：管理弹窗内联新增、独立弹窗、添加规则集弹窗都复用它 */
function goAddRule() {
  location.hash = '#/convert?pane=rules&new=rule';
}

function onRulesetFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'mrs' || ext === 'srs') {
    const reader = new FileReader();
    reader.onload = async () => {
      const buf = new Uint8Array(reader.result || new ArrayBuffer(0));
      let bin = '';
      for (let i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);
      try {
        message.loading({ content: `正在上传 ${file.name}…`, key: 'ruleset-upload', duration: 0 });
        const out = await api('/api/library/upload', { method: 'POST', body: { name: file.name, data: btoa(bin) } });
        editor.value.url = out.url;
        editor.value.urlKey = ext === 'srs' ? 'singbox' : 'mihomo';
        editor.value.format = ext;
        if (!editor.value.name) editor.value.name = name;
        if (!editor.value.id) editor.value.id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        message.success({ content: `已上传 ${file.name}，生成可拉取地址`, key: 'ruleset-upload' });
      } catch (err) {
        message.error({ content: err.payload?.error || err.message || '上传失败', key: 'ruleset-upload' });
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '').replace(/\r\n/g, '\n').trim();
    if (!text) { message.warning('文件为空'); return; }
    editor.value.inline = text;
    if (!editor.value.name) editor.value.name = name;
    if (!editor.value.id) editor.value.id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    message.success(`已导入 ${file.name}，共 ${text.split('\n').length} 行`);
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function addCategory(name, color) {
  const clean = String(name || '').trim().slice(0, 20);
  if (!clean) { message.warning('请填写分类名称'); return null; }
  if (categories.value.some((c) => c.name === clean)) { message.warning(`分类「${clean}」已存在`); return null; }
  try {
    const out = await api('/api/library/categories', { method: 'POST', body: { name: clean, color } });
    applyCategories(out && out.categories);
    await loadState().catch(() => {});
    if (catManageOpen.value) syncCatRows();
    return (out && out.category) || { name: clean, color };
  } catch (e) {
    message.error(e.payload?.error || e.message || '新增分类失败');
    return null;
  }
}

async function createCatInline() {
  if (catBusy.value) return;
  catBusy.value = true;
  const created = await addCategory(catQuick.name, catQuick.color);
  catBusy.value = false;
  if (!created) return;
  catQuick.name = '';
  message.success(`已新增分类「${created.name}」`);
}

async function saveCatRow(row) {
  if (catBusy.value) return;
  if (row.name === UNCAT) { message.warning('「未分类」是系统分类，不能重命名或改色'); return; }
  const name = String(row.editName || '').trim();
  if (!name) { message.warning('分类名称不能为空'); return; }
  catBusy.value = true;
  try {
    const out = await api(`/api/library/categories/${encodeURIComponent(row.name)}`, {
      method: 'PUT',
      body: { name, color: row.editColor },
    });
    applyCategories(out && out.categories);
    if (catFilter.value === row.name) catFilter.value = name;
    message.success(`已保存分类「${name}」`);
    await loadState().catch(() => {});
    syncCatRows();
  } catch (e) { message.error(e.payload?.error || e.message || '保存分类失败'); }
  catBusy.value = false;
}

/** 上移/下移后按当前行顺序整体写回 order；同时会保存行内尚未提交的名称与颜色 */
async function persistCatOrder() {
  if (catBusy.value) return;
  catBusy.value = true;
  try {
    let last = null;
    for (let i = 0; i < catRows.value.length; i += 1) {
      const row = catRows.value[i];
      last = await api(`/api/library/categories/${encodeURIComponent(row.name)}`, {
        method: 'PUT',
        body: { name: String(row.editName || row.name).trim() || row.name, color: row.editColor, order: i * 10 },
      });
    }
    applyCategories(last && last.categories);
    if (catFilter.value && !categories.value.some((c) => c.name === catFilter.value)) catFilter.value = '';
    message.success('分类顺序已更新');
    await loadState().catch(() => {});
    syncCatRows();
  } catch (e) {
    message.error(e.payload?.error || e.message || '调整顺序失败');
    await loadState().catch(() => {});
    syncCatRows();
  }
  catBusy.value = false;
}

async function moveCatRow(index, delta) {
  if (catBusy.value) return;
  if (catRows.value[index] && catRows.value[index].name === UNCAT) return;
  const next = index + delta;
  if (next < 0 || next >= catRows.value.length) return;
  // 「未分类」固定在最后，普通分类不能通过下移跨过它
  if (delta > 0 && catRows.value[next] && catRows.value[next].name === UNCAT) return;
  const rows = catRows.value.slice();
  [rows[index], rows[next]] = [rows[next], rows[index]];
  catRows.value = rows;
  await persistCatOrder();
}

function askDeleteCategory(row) {
  const options = catMoveOptions(row.name);
  catDelete.value = {
    open: true,
    name: row.name,
    count: row.count,
    moveTo: row.count > 0 ? (options[0]?.value || '') : '',
    options,
  };
}

async function confirmDeleteCategory() {
  const d = catDelete.value;
  if (d.count > 0 && !d.moveTo) { message.warning('该分类下还有规则集，请先选择迁移目标'); return; }
  if (catBusy.value) return;
  catBusy.value = true;
  try {
    const suffix = d.count > 0 ? `?moveTo=${encodeURIComponent(d.moveTo)}` : '';
    const out = await api(`/api/library/categories/${encodeURIComponent(d.name)}${suffix}`, { method: 'DELETE' });
    applyCategories(out && out.categories);
    const moved = Number(out && out.moved) || 0;
    if (catFilter.value === d.name) catFilter.value = '';
    message.success(d.count > 0
      ? `已删除分类「${d.name}」，迁移 ${moved} 个规则集到「${d.moveTo}」`
      : `已删除空分类「${d.name}」`);
    catDelete.value = { open: false, name: '', count: 0, moveTo: '', options: [] };
    await loadState().catch(() => {});
    syncCatRows();
  } catch (e) { message.error(e.payload?.error || e.message || '删除分类失败'); }
  catBusy.value = false;
}

const bases = computed(() => state.library.bases || []);
const dns = computed(() => state.library.dns || []);
const repos = computed(() => state.library.repos || []);

/* ── 规则集格式 / 自动更新 ──
   后端 normalizeRuleset 已经把这些字段落库，这里只做展示与提交。 */
const FORMAT_LABELS = { mrs: 'mrs', srs: 'srs', yaml: 'yaml', text: 'text', inline: 'inline' };
function detectRulesetFormat(url) {
  const u = String(url || '');
  if (/\.mrs(\?|#|$)/i.test(u)) return 'mrs';
  if (/\.srs(\?|#|$)/i.test(u)) return 'srs';
  if (/\.ya?ml(\?|#|$)/i.test(u)) return 'yaml';
  if (/\.(list|txt|conf)(\?|#|$)/i.test(u)) return 'text';
  return 'text';
}
function rulesetUrls(r) {
  return (r && r.urls) || {};
}
function rulesetPrimaryUrl(r) {
  const urls = rulesetUrls(r);
  return String(urls.mihomo || urls.clash || urls.singbox || (r && r.url) || '');
}
function rulesetFormat(r) {
  const f = r && r.format;
  if (f && FORMAT_LABELS[f]) return f;
  const url = rulesetPrimaryUrl(r);
  return url ? detectRulesetFormat(url) : 'inline';
}
function isRemoteRuleset(r) {
  return /^https?:\/\//i.test(rulesetPrimaryUrl(r));
}

/* ── 目录元数据：web/src/data/rulesetMeta.json（2170 条） ──────────────
   对照表的键是规则名（youtube / aws / cn…），资源库 id 本身就是规则名；
   官方目录的 id 带 gs: / gi: 前缀，所以按「原 id → 去前缀 → name」查。
   geoip 与域名条目共用国家码键（cn / us / ad…），用文案里的 geoip 字样
   区分，免得把「中国大陆域名总表」套到 IP 规则集上。 */
const META_TABLE = rulesetMeta && typeof rulesetMeta === 'object' ? rulesetMeta : {};

function metaKeysFor(item) {
  const keys = [];
  const push = (value) => {
    const key = String(value || '').trim().toLowerCase();
    if (key && !keys.includes(key)) keys.push(key);
  };
  push(item && item.id);
  push(item && item.name);
  const id = String((item && item.id) || '');
  if (id.includes(':')) push(id.slice(id.lastIndexOf(':') + 1));
  // 内置库里是 geoip-cn / geosite-cn 这种写法，去掉前缀再查一次国家/品牌键
  const prefixed = id.match(/^(geoip|geosite)[-:](.+)$/i);
  if (prefixed) push(prefixed[2]);
  // 从目录加入的规则集 id 会变成 gs-youtube 这种，只好再按地址里的文件名兜底
  const url = rulesetPrimaryUrl(item || {});
  if (url) {
    const file = url.split('/').pop().split(/[?#]/)[0].replace(/\.(mrs|srs|ya?ml|list|txt|conf)$/i, '');
    push(file);
  }
  return keys;
}

function wantsGeoipMeta(item) {
  const id = String((item && item.id) || '');
  if (/^geoip[-:]/i.test(id)) return true;
  if (/^geosite[-:]/i.test(id)) return false;
  return String((item && item.kind) || '').toLowerCase() === 'geoip';
}

function rulesetMetaFor(item) {
  if (!item) return null;
  const wantGeoip = wantsGeoipMeta(item);
  for (const key of metaKeysFor(item)) {
    const hit = META_TABLE[key];
    if (!hit) continue;
    const text = `${hit.name || ''} ${hit.desc || ''}`;
    if (/geoip/i.test(text) !== wantGeoip) continue;
    return hit;
  }
  return null;
}

/* 对照表的 tags 首项常是文档章节名（附录 A、全量索引 / A.1 geoip），属于
   解析噪声；用户已有标签永远排前面，合并时去重并保留顺序。 */
const META_TAG_NOISE = /^(附录|[A-Z]\.\d|第[一二三四五六七八九十0-9]{1,3}[章节部分])/;
function mergeRulesetTags(existing, meta) {
  const out = [];
  const add = (tag) => {
    const text = String(tag || '').trim();
    if (!text || text.length > 16 || META_TAG_NOISE.test(text) || text === '其它' || text === '全量索引' || out.includes(text)) return;
    out.push(text);
  };
  (Array.isArray(existing) ? existing : []).forEach(add);
  ((meta && meta.tags) || []).forEach(add);
  return out.slice(0, 8);
}

/* 对照表的 desc 大多带文档式前缀（「10.1 国际视频：」「A.1 geoip（260）：」），
   整段塞进卡片太吵；只剥掉「章节号 / 与 meta.name 相同」的那一段前缀。 */
function cleanMetaDesc(meta) {
  const raw = String((meta && meta.desc) || '').trim();
  if (!raw) return '';
  const cut = raw.indexOf('：');
  if (cut <= 0 || cut > 24) return raw;
  const head = raw.slice(0, cut).trim();
  const name = String((meta && meta.name) || '').trim();
  const docLike = /^(附录|A\.\d|\d+(\.\d+)*\s|第[一二三四五六七八九十0-9]{1,3}[章节部分])/.test(head);
  if (!name || head === name || docLike) return raw.slice(cut + 1).trim();
  return raw;
}
function composeDesc(own, meta) {
  const detail = cleanMetaDesc(meta);
  const base = String(own || '').trim();
  if (detail && base && detail !== base) return `${base} · ${detail}`;
  return detail || base;
}

/* 标签多色：先按语义关键词定色系（广告红 / 常用琥珀 / 流媒体紫…），没命中
   再用稳定 hash 取色 —— 同一标签在任何卡片里颜色一致，且不再是整排灰色。 */
const TAG_TONE_RULES = [
  [/广告|拦截|去广告|追踪|privacy/i, '#f87171'],
  [/常用|推荐|必备/, '#fbbf24'],
  [/流媒体|视频|音乐|影视/, '#c084fc'],
  [/游戏/, '#34d399'],
  [/国内|大陆|直连|cn/i, '#38bdf8'],
  [/社交|通讯|telegram/i, '#22d3ee'],
  [/ai|人工智能|大模型|openai/i, '#818cf8'],
  [/开发|下载|cdn|开源|github/i, '#2dd4bf'],
  [/代理|gfw|兜底/, '#fb923c'],
];
const TAG_TONES = ['#60a5fa', '#a78bfa', '#f472b6', '#facc15', '#4ade80', '#fb923c', '#38bdf8', '#fb7185'];
function tagTone(tag) {
  const text = String(tag || '').trim();
  const hit = TAG_TONE_RULES.find(([re]) => re.test(text));
  return hit ? hit[1] : TAG_TONES[hashString(text) % TAG_TONES.length];
}

/* ── 内置规则集本地覆盖 ────────────────────────────────────────────────
   后端 PUT 接受内置项，但 gateway/lib/library.js 的 syncBuiltins() 每次启动
   都会用 seed 覆盖内置条目，服务端改动会丢。所以内置项的名称 / 分类 / 标签
   / 说明一律先落 localStorage，读取时叠加在接口数据之上；非内置项仍以接口
   为准，只在本地记 check-only、自定义间隔这类后端没有字段的展示标记。 */
const OVERRIDE_KEY = 'subhub.rulesetMeta.overrides';
const localOverrides = reactive({});

function loadOverrides() {
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const items = parsed && parsed.items && typeof parsed.items === 'object' ? parsed.items : parsed;
    if (!items || typeof items !== 'object') return;
    for (const [id, patch] of Object.entries(items)) {
      if (id && patch && typeof patch === 'object') localOverrides[id] = patch;
    }
  } catch { /* localStorage 不可用时退化为纯接口数据 */ }
}
function persistOverrides() {
  try {
    window.localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ version: 1, items: localOverrides }));
  } catch { /* 配额满：仅本次会话生效 */ }
}
function saveOverride(id, patch) {
  if (!id) return;
  const next = { ...(localOverrides[id] || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined || value === null || value === '') delete next[key];
    else next[key] = value;
  }
  if (Object.keys(next).length) localOverrides[id] = next;
  else delete localOverrides[id];
  persistOverrides();
}
function dropOverride(id) {
  if (!id || !localOverrides[id]) return;
  delete localOverrides[id];
  persistOverrides();
}
const overrideOf = (id) => (id && localOverrides[id]) || {};

/* 接口数据 + 本地覆盖 + 目录元数据 → 卡片要展示的一行。 */
function rulesetView(item) {
  if (!item || !item.id) return null;
  const ov = overrideOf(item.id);
  const meta = rulesetMetaFor(item);
  const ownDesc = String(ov.desc != null ? ov.desc : (item.desc || '')).trim();
  return {
    ...item,
    meta,
    metaCount: Number((meta && meta.count) || 0) || 0,
    metaSize: String((meta && meta.size) || '').trim(),
    name: String(ov.name || item.name || (meta && meta.name) || item.id).trim(),
    cat: String(ov.cat != null ? ov.cat : (item.cat || '')).trim(),
    desc: ownDesc || cleanMetaDesc(meta),
    baseDesc: ownDesc,
    tags: mergeRulesetTags(ov.tags != null ? ov.tags : item.tags, meta),
    baseTags: Array.isArray(ov.tags) ? ov.tags : (Array.isArray(item.tags) ? item.tags : []),
    override: Object.keys(ov).length > 0,
    metaOverride: ['name', 'cat', 'tags', 'desc'].some((k) => ov[k] !== undefined),
    remote: isRemoteRuleset(item),
    checkOnly: !!ov.checkOnly,
    customPlan: !!ov.custom,
    pullTemplate: String(ov.pullTemplate || ''),
    intervalHours: Math.max(1, Math.min(720, Number(ov.intervalHours || item.intervalHours) || 24)),
  };
}
const rulesetViews = computed(() => (state.library.rulesets || []).map(rulesetView).filter(Boolean));
const shownRulesets = computed(() => {
  if (!catFilter.value) return rulesetViews.value;
  return rulesetViews.value.filter((r) => (String(r.cat || '').trim() || UNCAT) === catFilter.value);
});

/* ── 检查状态：上次检查 MM/DD HH:mm + remoteHash 前 7 位 ── */
function shortTime(value) {
  const t = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function shortHash(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 7) : '';
}

/* 本次会话的检查结果覆盖在卡片上；落库的 checkedAt / remoteHash 作为兜底。 */
const rulesetCheck = reactive({});
function rulesetCheckBusy(id) {
  return !!(rulesetCheck[id] && rulesetCheck[id].busy);
}
function rulesetCheckInfo(r) {
  const local = rulesetCheck[r.id] || {};
  const at = shortTime(local.at) || shortTime(r.checkedAt);
  const hash = shortHash(r.remoteHash || local.hash);
  const full = String(r.remoteHash || local.hash || '');
  if (local.error) return { at, hash, full, text: '检查失败', cls: 'tag-bad', title: local.error };
  if (local.at) {
    return local.changed
      ? { at, hash, full, text: '有更新', cls: 'tag-warn', title: '本次检查发现远端内容变化' }
      : { at, hash, full, text: '已是最新', cls: 'tag-ok', title: '本次检查未发现变化' };
  }
  if (r.checkError) return { at, hash, full, text: '检查失败', cls: 'tag-bad', title: r.checkError };
  if (r.changedAt && r.checkedAt && r.changedAt === r.checkedAt) {
    return { at, hash, full, text: '有更新', cls: 'tag-warn', title: `上次检查（${shortTime(r.checkedAt)}）发现更新` };
  }
  if (r.checkedAt) return { at, hash, full, text: '已是最新', cls: 'tag-ok', title: `上次检查：${shortTime(r.checkedAt)}` };
  return { at, hash, full, text: '', cls: '', title: '尚未检查远端' };
}
const checkInfos = computed(() => {
  const map = {};
  for (const r of rulesetViews.value) map[r.id] = rulesetCheckInfo(r);
  return map;
});
const CHECK_IDLE = { at: '', hash: '', full: '', text: '', cls: '', title: '尚未检查远端' };
const checkInfoOf = (r) => checkInfos.value[(r && r.id) || ''] || CHECK_IDLE;
const cardTip = (r) => !!(r && (r.meta || r.desc || (r.tags && r.tags.length)));

async function checkRuleset(item) {
  if (!item || !item.id || rulesetCheckBusy(item.id)) return;
  rulesetCheck[item.id] = { busy: true, changed: false, hash: '', error: '', at: 0 };
  try {
    const out = await api(`/api/library/rulesets/${encodeURIComponent(item.id)}/check`, { method: 'POST' });
    const hash = String((out && out.hash) || '').trim();
    const changed = !!(out && out.changed && !out.notModified);
    rulesetCheck[item.id] = { busy: false, changed, hash, error: '', at: Date.now() };
    if (changed) message.warning(`「${item.name || item.id}」有更新${hash ? ` · ${shortHash(hash)}` : ''}`);
    else message.success(`「${item.name || item.id}」已是最新${hash ? ` · ${shortHash(hash)}` : ''}`);
    await loadState();
  } catch (e) {
    const error = (e.payload && e.payload.error) || e.message || '检查远端失败';
    rulesetCheck[item.id] = { busy: false, changed: false, hash: '', error, at: Date.now() };
    message.error(error);
  }
}

const formatHelpOpen = ref(false);
const formatHelpRows = [
  { fmt: 'mrs', name: 'mihomo 编译规则集', desc: 'mihomo 官方二进制格式，由源规则编译而来。客户端按整文件加载，无法按行合并或增量修改，因此 SubHub 对网络规则集统一按整文件 replace 检测更新，适合开启自动更新。' },
  { fmt: 'srs', name: 'sing-box 编译规则集', desc: 'sing-box 的二进制规则集，同样只能整文件替换。SubHub 以哈希比对判断远端是否变化，变化后整份下发。' },
  { fmt: 'yaml', name: '文本 YAML 规则集', desc: '可读、可手工编辑的文本规则集，内容便于审阅与 diff；但客户端仍然整文件加载，所以自动更新策略同样是 replace。' },
  { fmt: 'text', name: '文本列表规则集', desc: 'list / txt / conf 等纯文本规则列表，可读、可手工增量编辑；但客户端仍按整文件加载，所以 SubHub 统一用整文件 replace 方式检测更新，append 只是合并写入的选项。' },
  { fmt: 'inline', name: '内联规则', desc: '直接写在订阅模板或规则集库里的规则行，不涉及远程地址，也就没有自动更新。' },
];

const openLayer = ref('');
const layerCache = reactive({});
const layerKey = (kind, item) => `${kind}:${item.id}`;
function layerText(kind, item) {
  const key = layerKey(kind, item);
  if (layerCache[key] != null) return layerCache[key] || '（空内容）';
  return String(item.content || '').trim() || '加载中…';
}
const layerLines = (kind, item) => {
  const text = layerCache[layerKey(kind, item)];
  return text ? String(text).split('\n').length : 0;
};
const layerChars = (kind, item) => {
  const text = layerCache[layerKey(kind, item)];
  return text ? String(text).length : 0;
};
async function fetchLayer(kind, item) {
  const key = layerKey(kind, item);
  if (layerCache[key] != null) return layerCache[key];
  if (item.content) { layerCache[key] = String(item.content).trim(); return layerCache[key]; }
  const res = await api(`/api/library/${kind === 'base' ? 'bases' : 'dns'}/${encodeURIComponent(item.id)}`);
  const got = res && (res.content != null ? res : res.item || null);
  layerCache[key] = String((got && got.content) || '').trim();
  return layerCache[key];
}
async function toggleLayer(kind, item) {
  const key = layerKey(kind, item);
  if (openLayer.value === key) { openLayer.value = ''; return; }
  openLayer.value = key;
  if (layerCache[key] != null) return;
  try { await fetchLayer(kind, item); } catch (e) { layerCache[key] = ''; message.error(e.message || '读取内容失败'); }
}
async function copyLayer(kind, item) {
  try {
    const text = await fetchLayer(kind, item);
    await navigator.clipboard.writeText(text || '');
    message.success(text ? '已复制内容' : '内容为空');
  } catch { message.error('复制失败，请手动选择'); }
}

/* ── YAML 高亮 ──
   逐段转义后再包 <span>，既保证 v-html 安全，又避免先转义把引号变成实体后匹配不到字符串。 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const YAML_TOKENS = /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(^[ \t]*-)(?=[ \t]|$)|(\btrue\b|\bfalse\b|\bnull\b|\byes\b|\bno\b|\bon\b|\boff\b)|(-?\b\d+(?:\.\d+)?\b)|([A-Za-z0-9_.$-]+)(?=[ \t]*:(?!\/\/))/g;

function highlightYaml(text) {
  const src = String(text == null ? '' : text);
  if (!src) return '';
  return src.split('\n').map((line) => {
    let out = '';
    let last = 0;
    let m;
    YAML_TOKENS.lastIndex = 0;
    while ((m = YAML_TOKENS.exec(line))) {
      out += escapeHtml(line.slice(last, m.index));
      if (m[1]) out += `<span class="syn-com">${escapeHtml(m[1])}</span>`;
      else if (m[2]) out += `<span class="syn-str">${escapeHtml(m[2])}</span>`;
      else if (m[3]) out += `<span class="syn-dash">${escapeHtml(m[3])}</span>`;
      else if (m[4]) out += `<span class="syn-bool">${escapeHtml(m[4])}</span>`;
      else if (m[5]) out += `<span class="syn-num">${escapeHtml(m[5])}</span>`;
      else if (m[6]) out += `<span class="syn-key">${escapeHtml(m[6])}</span>`;
      last = m.index + m[0].length;
    }
    out += escapeHtml(line.slice(last));
    return out;
  }).join('\n');
}

const COMMON_IDS = ['ad-block', 'geoip-cn', 'geosite-cn', 'local-area', 'telegram', 'youtube', 'netflix', 'openai', 'apple', 'microsoft', 'google', 'proxy-gfw'];
const commonRulesets = computed(() => rulesetViews.value.filter((r) => COMMON_IDS.includes(r.id)));

const editorOpen = ref(false);
const editorIsNew = ref(true);
const editor = ref({ kind: 'ruleset', id: '', name: '', format: 'any', group: '🚀 节点选择', behavior: 'domain', repo: '', url: '', inline: '', desc: '', tags: '', cat: '' });
const editorLines = computed(() => String(editor.value.inline || '').split('\n').length);
const editorChars = computed(() => String(editor.value.inline || '').length);
/* 基础/DNS：左侧编辑、右侧只读预览；「对比」时右侧换成行级 diff。 */
const editorDiff = ref(false);
const editorOriginal = ref('');
const editorCheck = ref({ text: '', kind: '', busy: false });
const editorLanguage = computed(() => {
  if (/json|sing-?box/i.test(String(editor.value.format || ''))) return 'json';
  // 格式字段是 any 时，用内容特征判断 sing-box 的 JSON
  const text = String(editor.value.inline || '').trim();
  if (/^[[{]/.test(text) && /"\s*:/.test(text)) return 'json';
  return 'yaml';
});
/* ── 可视化 / 原始 YAML（仅 base / dns 的 mihomo YAML 有表单） ──
   表单只接管常用字段：未知字段、注释、其它段落都原样保留；
   sing-box JSON 没有对应表单，自动回落到原始编辑器。 */
const editorMode = ref('visual');
const editorCanVisual = computed(() => editor.value.kind !== 'ruleset' && editorLanguage.value === 'yaml');
const editorVisualMode = computed(() => editorCanVisual.value && editorMode.value === 'visual');

const editorRemote = computed(() => /^https?:\/\//i.test(String(editor.value.url || '')));
const editorDetectedFormat = computed(() => (editorRemote.value ? detectRulesetFormat(editor.value.url) : 'inline'));

/* ── 更新方式（仅 URL 型规则集） ──
   后端只有 replace / append 两种 updateMode，check-only 与自定义间隔属于
   前端语义：updateMode 仍写后端认的值，另外在 localStorage 覆盖里记标记。 */
const PLAN_OPTIONS = [
  { label: '全量替换（replace）', value: 'replace' },
  { label: '追加合并（append）', value: 'append' },
  { label: '仅检查不写入（check-only）', value: 'check-only' },
  { label: '自定义（间隔 + 拉取模板）', value: 'custom' },
];
function planOf(item, ov) {
  if (ov && ov.checkOnly) return 'check-only';
  if (item && item.updateMode === 'check') return 'check-only';
  if (ov && ov.custom) return 'custom';
  return item && item.updateMode === 'append' ? 'append' : 'replace';
}
const editorPlan = computed(() => editor.value.updatePlan || (editor.value.updateMode === 'check' ? 'check-only' : editor.value.updateMode === 'append' ? 'append' : 'replace'));
const editorPlanHint = computed(() => {
  if (!editorRemote.value) return '内联规则没有远端地址，不参与自动更新';
  if (editorDetectedFormat.value === 'mrs' || editorDetectedFormat.value === 'srs') return 'mrs / srs 二进制规则集只能整文件 replace';
  if (editorPlan.value === 'append') return '文本规则按行追加合并，官方二进制集合仍整文件替换';
  if (editorPlan.value === 'check-only') return '只比对远端 hash 与检查时间，不写入规则内容';
  if (editorPlan.value === 'custom') return `自定义间隔 ${Number(editor.value.intervalHours) || 24} 小时（1–720），可附拉取模板说明`;
  return '整文件替换，最稳妥，适合 mrs / srs 与官方集合';
});
const editorPlanLocked = computed(() => editorPlan.value === 'check-only' || editorPlan.value === 'custom');
function setUpdatePlan(plan) {
  editor.value.updatePlan = plan;
  if (editorRemote.value && (plan === 'check-only' || plan === 'custom')) editor.value.autoUpdate = true;
}

async function copyEditor() {
  try {
    const text = String(editor.value.inline || '');
    await navigator.clipboard.writeText(text);
    message.success(text ? '已复制内容' : '内容为空');
  } catch { message.error('复制失败，请手动选择'); }
}

async function openEditor(kind, item) {
  editorIsNew.value = !item;
  editorDiff.value = false;
  editorOriginal.value = '';
  editorMode.value = 'visual';
  editorCheck.value = { text: '', kind: '', busy: false };
  if (kind !== 'ruleset') {
    let content = item ? String(item.content || '') : '';
    if (item && !content) {
      try { content = await fetchLayer(kind, item); } catch { content = ''; }
    }
    editor.value = {
      kind, id: item ? item.id : '', name: item ? item.name || '' : '', format: (item && item.format) || 'any',
      desc: (item && item.desc) || '', inline: content,
    };
    editorOriginal.value = content;
    editorOpen.value = true;
    return;
  }
  const urls = (item && item.urls) || {};
  const urlKey = urls.clash ? 'clash' : urls.mihomo ? 'mihomo' : urls.singbox ? 'singbox' : 'clash';
  const ov = overrideOf(item && item.id);
  editor.value = item
    ? { kind, id: item.id, name: item.name || '', format: 'any', group: item.group || '🚀 节点选择', behavior: item.behavior || 'domain', repo: item.repo || '', url: urls[urlKey] || '', urlKey, inline: (item.inline || []).join('\n'), desc: item.baseDesc != null ? item.baseDesc : (item.desc || ''), tags: (item.baseTags || item.tags || []).join(', '), cat: item.cat || '', autoUpdate: item.autoUpdate !== false, intervalHours: Number(item.intervalHours) || 24, updateMode: item.updateMode || 'replace', updatePlan: planOf(item, ov), pullTemplate: ov.pullTemplate || '' }
    : { kind, id: '', name: '', format: 'any', group: '🚀 节点选择', behavior: 'domain', repo: '自建', url: '', urlKey: 'clash', inline: '', desc: '', tags: '', cat: '', autoUpdate: true, intervalHours: 24, updateMode: 'replace', updatePlan: 'replace', pullTemplate: '' };
  editorOpen.value = true;
}

const splitTags = (s) => String(s || '').split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);

const clampInterval = (value) => Math.min(720, Math.max(1, Math.round(Number(value) || 24)));

async function saveEditor() {
  const e = editor.value;
  if (!e.id) { message.warning('请填写 id（小写字母、数字、短横线）'); return; }
  const plan = e.updatePlan || 'replace';
  const checkOnly = plan === 'check-only';
  const customPlan = plan === 'custom';
  const intervalHours = clampInterval(e.intervalHours);
  const pullTemplate = customPlan ? String(e.pullTemplate || '').trim() : '';
  const tags = splitTags(e.tags);
  const body = e.kind === 'ruleset'
    ? {
      id: e.id, name: e.name || e.id, group: e.group, behavior: e.behavior, repo: e.repo || '自建', desc: e.desc, cat: e.cat,
      format: editorDetectedFormat.value,
      // check-only / 自定义都必须保持 autoUpdate，否则后端根本不会触发检查
      autoUpdate: editorRemote.value && (editorPlanLocked.value ? true : !!e.autoUpdate),
      updateMode: checkOnly ? 'check' : (['mrs', 'srs'].includes(editorDetectedFormat.value) ? 'replace' : (plan === 'append' ? 'append' : 'replace')),
      intervalHours,
      tags,
      urls: e.url ? { [e.urlKey || 'clash']: e.url } : {},
      inline: e.inline.split('\n').map((s) => s.trim()).filter(Boolean),
    }
    : { id: e.id, name: e.name || e.id, format: e.format || 'any', desc: e.desc, content: e.inline };
  try {
    const exists = e.kind === 'ruleset'
      ? rulesets.value.some((r) => r.id === e.id)
      : (e.kind === 'base' ? bases.value : dns.value).some((r) => r.id === e.id);
    const base = e.kind === 'ruleset' ? '/api/library/rulesets' : e.kind === 'base' ? '/api/library/bases' : '/api/library/dns';
    const current = e.kind === 'ruleset' ? rulesets.value.find((r) => r.id === e.id) || null : null;
    const builtin = !!(current && current.builtin);
    let remoteSaved = false;

    if (!builtin || can('library:write')) {
      try {
        await api(exists ? `${base}/${encodeURIComponent(e.id)}` : base, { method: exists ? 'PUT' : 'POST', body });
        remoteSaved = true;
      } catch (err) {
        if (!builtin) throw err;
        message.warning(`后端拒绝改写内置项（${err.message || '未知错误'}），已改存本地覆盖`);
      }
    }

    if (e.kind === 'ruleset') {
      /* 内置项：名称 / 分类 / 标签 / 说明落本地覆盖（后端 syncBuiltins 重启会还原）；
         非内置项：只记 check-only、自定义间隔、拉取模板这类后端没有字段的标记。
         只有「和接口值不同」的字段才写覆盖，否则直接保存一次就会冻结住 seed 更新。 */
      const rawName = String((current && current.name) || '').trim();
      const rawCat = String((current && current.cat) || '').trim();
      const rawDesc = String((current && current.desc) || '').trim();
      const rawTags = current && Array.isArray(current.tags) ? current.tags : [];
      const nextName = String(e.name || '').trim();
      const nextCat = String(e.cat || '').trim();
      const nextDesc = String(e.desc || '').trim();
      const sameTags = tags.length === rawTags.length && tags.every((t, i) => t === rawTags[i]);
      saveOverride(e.id, {
        name: builtin && nextName !== rawName ? nextName : undefined,
        cat: builtin && nextCat !== rawCat ? nextCat : undefined,
        tags: builtin && !sameTags ? tags : undefined,
        desc: builtin && nextDesc !== rawDesc ? nextDesc : undefined,
        checkOnly: checkOnly || undefined,
        custom: customPlan || undefined,
        intervalHours: intervalHours > 168 ? intervalHours : undefined,
        pullTemplate: pullTemplate || undefined,
      });
    }

    message.success(builtin ? '已保存（内置项：元数据存本地覆盖）' : '已保存');
    editorOpen.value = false;
    if (remoteSaved) await loadState();
  } catch (err) { message.error(err.message || '保存失败'); }
}

async function removeItem(kind, id) {
  const base = kind === 'ruleset' ? '/api/library/rulesets' : kind === 'base' ? '/api/library/bases' : '/api/library/dns';
  try {
    await api(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (kind === 'ruleset') dropOverride(id);
    message.success('已删除');
    await loadState();
  } catch (e) { message.error(e.message || '删除失败'); }
}

/* ── 规则集更新设置（全局 / 单项优先） ── */
const settingsOpen = ref(false);
const settingsBusy = ref(false);
const settingsForm = ref({
  autoUpdate: true, mode: 'item', scope: 'all', defaultMode: 'check', intervalHours: 24,
});
async function openSettings() {
  settingsOpen.value = true;
  try {
    const r = await api('/api/library/settings');
    settingsForm.value = { ...settingsForm.value, ...(r.settings || {}) };
  } catch (e) { message.error(e.message || '读取更新设置失败'); }
}
async function saveSettings() {
  settingsBusy.value = true;
  try {
    const r = await api('/api/library/settings', { method: 'PUT', body: settingsForm.value });
    settingsForm.value = { ...settingsForm.value, ...(r.settings || {}) };
    settingsOpen.value = false;
    message.success('更新设置已保存');
    await loadState();
  } catch (e) { message.error(e.message || '保存失败'); }
  finally { settingsBusy.value = false; }
}

/* ── 规则集批量管理（按当前分类筛选范围） ── */
const bulkSel = ref([]);
const bulkBusy = ref(false);
const bulkAllChecked = computed(() => shownRulesets.value.length > 0 && shownRulesets.value.every((r) => bulkSel.value.includes(r.id)));
function toggleBulk(id) {
  const set = new Set(bulkSel.value);
  if (set.has(id)) set.delete(id); else set.add(id);
  bulkSel.value = [...set];
}
function toggleBulkAll() {
  bulkSel.value = bulkAllChecked.value ? [] : shownRulesets.value.map((r) => r.id);
}
watch(() => catFilter.value, () => { bulkSel.value = []; });
async function bulkCheck() {
  const rows = rulesets.value.filter((r) => bulkSel.value.includes(r.id) && r.remote);
  if (!rows.length) { message.warning('所选规则集没有网络地址，无法检查'); return; }
  bulkBusy.value = true;
  let ok = 0; let fail = 0;
  for (const r of rows) {
    try { await api(`/api/library/rulesets/${encodeURIComponent(r.id)}/check`, { method: 'POST' }); ok += 1; }
    catch { fail += 1; }
  }
  bulkBusy.value = false;
  message.success(`批量检查完成：成功 ${ok}${fail ? `，失败 ${fail}` : ''}`);
  bulkSel.value = [];
  await loadState();
}
async function bulkRemove() {
  const rows = rulesets.value.filter((r) => bulkSel.value.includes(r.id));
  const deletable = rows.filter((r) => !r.builtin);
  if (!deletable.length) { message.warning('内置规则集不可删除'); return; }
  try {
    await dialog.warning({
      title: '批量删除规则集',
      content: `将删除 ${deletable.length} 个自建规则集${rows.length !== deletable.length ? `（另有 ${rows.length - deletable.length} 个内置项会跳过）` : ''}，不可撤销。`,
      positiveText: '删除', negativeText: '取消',
    });
  } catch { return; }
  bulkBusy.value = true;
  let ok = 0;
  for (const r of deletable) {
    try { await api(`/api/library/rulesets/${encodeURIComponent(r.id)}`, { method: 'DELETE' }); dropOverride(r.id); ok += 1; } catch { /* 继续 */ }
  }
  bulkBusy.value = false;
  message.success(`已删除 ${ok} 个规则集`);
  bulkSel.value = [];
  await loadState();
}

// 编辑器里也能删除：内置项保留（元数据可改），自建项可删
const editorTarget = computed(() => {
  const e = editor.value;
  if (!e.id) return null;
  if (e.kind === 'ruleset') return rulesetViews.value.find((r) => r.id === e.id) || null;
  return ((e.kind === 'base' ? bases.value : dns.value).find((r) => r.id === e.id)) || null;
});
const editorCheckMeta = computed(() => {
  const target = editorTarget.value;
  const local = editorCheck.value || {};
  return {
    at: shortTime(local.at) || shortTime(target && target.checkedAt),
    hash: shortHash((target && target.remoteHash) || local.hash),
  };
});
async function removeEditorItem() {
  const item = editorTarget.value;
  if (!item) return;
  if (item.builtin) { message.info('内置规则集不可删除，可编辑分类 / 标签 / 说明'); return; }
  if (!window.confirm(`确定删除「${item.name || item.id}」？`)) return;
  await removeItem(editor.value.kind, item.id);
  editorOpen.value = false;
}

/* 清掉本机覆盖，回到接口原值（内置项专用；非内置项也会丢掉 check-only 等标记） */
function resetEditorOverride() {
  const e = editor.value;
  if (!e.id) return;
  dropOverride(e.id);
  const raw = rulesets.value.find((r) => r.id === e.id) || null;
  openEditor('ruleset', raw);
  message.success('已恢复接口数据');
}

/* 规则集弹窗里的图标按钮：必须已保存，POST /api/library/rulesets/:id/check */
async function checkEditorRuleset() {
  const e = editor.value;
  const id = String(e.id || '').trim();
  if (!id || !rulesets.value.some((r) => r.id === id)) { message.info('请先保存规则集，再检查远端'); return; }
  if (editorCheck.value.busy) return;
  editorCheck.value = { text: '', kind: '', busy: true, at: Date.now(), hash: '' };
  try {
    const out = await api(`/api/library/rulesets/${encodeURIComponent(id)}/check`, { method: 'POST' });
    const hash = String((out && out.hash) || '').trim();
    const changed = !!(out && out.changed && !out.notModified);
    editorCheck.value = {
      text: changed ? '有更新' : '已是最新',
      kind: changed ? 'warn' : 'ok', busy: false, at: Date.now(), hash,
    };
    if (changed) message.warning(`「${e.name || id}」有更新${hash ? ` · ${shortHash(hash)}` : ''}`);
    else message.success(`「${e.name || id}」已是最新${hash ? ` · ${shortHash(hash)}` : ''}`);
    await loadState();
  } catch (err) {
    const msg = (err.payload && err.payload.error) || err.message || '检查远端失败';
    editorCheck.value = { text: msg, kind: 'error', busy: false, at: Date.now(), hash: '' };
    message.error(msg);
  }
}

/** 目录搜索结果加入规则集库。
 *  group 从「已添加规则集里出现过的分组」中选，缺省用默认分组；
 *  cat 为第三个可选参数，传空字符串表示不归类；不传时沿用目录条目自带的分类（兼容旧调用）。 */
async function collect(it, group, cat) {
  if (!can('library:write')) { message.warning('固定规则集需要「资源库编辑」权限'); return false; }
  const id = String(it.id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const target = String(group || DEFAULT_GROUP).trim() || DEFAULT_GROUP;
  const category = cat === undefined || cat === null ? String(it.cat || '').trim() : String(cat).trim();
  const meta = it.meta || rulesetMetaFor(it);
  const name = String(it.zh || it.label || (meta && meta.name) || it.name || id).trim();
  try {
    await api('/api/library/rulesets', {
      method: 'POST',
      body: {
        id, name, group: target, behavior: it.behavior,
        desc: String(it.desc || (meta && meta.desc) || '').trim(),
        repo: 'MetaCubeX', cat: category,
        tags: mergeRulesetTags(it.tags, meta),
        urls: it.urls || {},
      },
    });
    message.success(`已固定「${name}」到「${target}」${category ? ` · ${category}` : ''}`);
    await loadState();
    return true;
  } catch (e) { message.error(e.message || '固定失败'); return false; }
}

const groupChoices = computed(() => {
  const seen = new Set();
  for (const r of rulesets.value) {
    const g = String(r.group || '').trim();
    if (g) seen.add(g);
  }
  return [...seen];
});
const groupPickOptions = computed(() => {
  const opts = [{ label: `默认（${DEFAULT_GROUP}）`, value: DEFAULT_GROUP }];
  for (const g of groupChoices.value) {
    if (g !== DEFAULT_GROUP) opts.push({ label: g, value: g });
  }
  return opts;
});

/* ── 从官方目录添加规则集：先选分类与目标策略组，再写库 ── */
const addOpen = ref(false);
const addItem = ref(null);
const addForm = reactive({ cat: '', group: DEFAULT_GROUP });
const addBusy = ref(false);
const addNewCatOpen = ref(false);
const addNewCat = reactive({ name: '', color: PRESET_COLORS[3] });
const addCatChoices = computed(() => {
  const list = categories.value.map((c) => ({ name: c.name, color: c.color, count: c.count }));
  const own = addItem.value && String(addItem.value.cat || '').trim();
  if (own && !list.some((c) => c.name === own)) {
    list.unshift({ name: own, color: catColor(own), count: 0 });
  }
  return list;
});

function openAddDialog(it) {
  addItem.value = it;
  addForm.cat = String(it.cat || '').trim();
  addForm.group = DEFAULT_GROUP;
  addNewCatOpen.value = false;
  addNewCat.name = '';
  addNewCat.color = PRESET_COLORS[(categories.value.length + 3) % PRESET_COLORS.length];
  addOpen.value = true;
}

async function createAddCategory() {
  if (addBusy.value) return;
  addBusy.value = true;
  const created = await addCategory(addNewCat.name, addNewCat.color);
  addBusy.value = false;
  if (!created) return;
  addForm.cat = created.name;
  addNewCatOpen.value = false;
  addNewCat.name = '';
  message.success(`已新增分类「${created.name}」，将用于本次添加`);
}

async function confirmAdd() {
  if (!addItem.value || addBusy.value) return;
  addBusy.value = true;
  const ok = await collect(addItem.value, addForm.group, addForm.cat);
  addBusy.value = false;
  if (ok) addOpen.value = false;
}

async function addWithDefaults(it) {
  const target = it || addItem.value;
  if (!target || addBusy.value) return;
  addBusy.value = true;
  const ok = await collect(target);
  addBusy.value = false;
  if (ok && addOpen.value) addOpen.value = false;
}

/* ── 模板编辑器：原始 INI / 可视化模型 ──
   raw 模式在 CodeEditor 里编辑 INI；visual 模式编辑结构化模型，切换时用
   /api/templates/build 生成 INI，保证两边看到的是同一份模板。 */
const tplOpen = ref(false);
const tpl = ref({
  name: '', title: '', content: '', mode: 'raw',
  model: null, rawModel: null, warnings: [], loading: false, saving: false, validating: false,
});
const tplEditor = ref(null);
const tplMarks = ref([]);
const tplCheck = ref({ ok: true, text: '', errors: [] });
const tplSaveAsOpen = ref(false);
const tplSaveAsName = ref('');
const tplSaveAsBusy = ref(false);

const TPL_GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance', 'relay'];
const TPL_GROUP_TYPE_OPTIONS = TPL_GROUP_TYPES.map((v) => ({ label: v, value: v }));
const TPL_RULE_TYPES = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'GEOSITE', 'SRC-IP-CIDR', 'DST-PORT', 'SRC-PORT', 'PROCESS-NAME', 'RULE-SET', 'MATCH', 'FINAL'];
const TPL_RULE_TYPE_OPTIONS = TPL_RULE_TYPES.map((v) => ({ label: v, value: v }));
const tplRuleTargets = computed(() => {
  const names = ((tpl.value.model && tpl.value.model.groups) || []).map((g) => String(g.name || '').trim()).filter(Boolean);
  return [...new Set([...names, 'DIRECT', 'REJECT'])].map((v) => ({ label: v, value: v }));
});
const tplIssueList = computed(() => [
  ...(tpl.value.warnings || []).map((text) => ({ text: String(text), kind: 'warn' })),
  ...(tplCheck.value.errors || []).map((text) => ({ text: String(text), kind: 'error' })),
]);

function tplWarnLine(text) {
  const m = /第\s*(\d+)\s*行/.exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}
function syncTplMarks() {
  const out = [];
  for (const text of tpl.value.warnings || []) {
    const line = tplWarnLine(text);
    if (line) out.push({ line, kind: 'warn', text: String(text) });
  }
  for (const text of tplCheck.value.errors || []) {
    const line = tplWarnLine(text);
    if (line) out.push({ line, kind: 'error', text: String(text) });
  }
  tplMarks.value = out;
}
/* build 失败一般只给文字错误，没有行号：从「」或冒号后的关键词回查所在行。 */
function findLineByKeyword(text) {
  const raw = String(text || '');
  const tokens = [];
  for (const m of raw.matchAll(/[「"“]([^」"”]{1,64})[」"”]/g)) tokens.push(m[1]);
  for (const m of raw.matchAll(/[：:]\s*([^\s，。；、]+)/g)) tokens.push(m[1]);
  const lines = String(tpl.value.content || '').split('\n');
  for (const token of tokens) {
    const needle = String(token || '').trim();
    if (needle.length < 2) continue;
    const idx = lines.findIndex((line) => line.includes(needle));
    if (idx >= 0) return idx + 1;
  }
  return 0;
}

function toEditableModel(raw) {
  const model = raw || {};
  const meta = model.meta || {};
  return {
    meta: {
      title: meta.title || '',
      description: meta.description || '',
      targets: Array.isArray(meta.targets) ? meta.targets.join(', ') : String(meta.targets || ''),
      author: meta.author || '',
      version: meta.version || '',
      extra: meta.extra && typeof meta.extra === 'object' && !Array.isArray(meta.extra) ? { ...meta.extra } : {},
    },
    groups: (model.groups || []).map((g) => ({
      name: g.name || '',
      type: g.type || 'select',
      refs: Array.isArray(g.refs) ? g.refs.join(', ') : String(g.refs || ''),
      patterns: Array.isArray(g.patterns) ? g.patterns.join(', ') : String(g.patterns || ''),
      url: g.url || '',
      interval: Number(g.interval) || 300,
      tolerance: Number(g.tolerance) || 50,
    })),
    rules: (model.rules || []).map((r) => ({
      target: r.target || '',
      kind: r.kind === 'inline' ? 'inline' : 'url',
      type: r.type || '',
      value: r.value || '',
      options: Array.isArray(r.options) ? r.options.join(',') : String(r.options || ''),
    })),
    extras: Array.isArray(model.extras) ? model.extras : [],
  };
}

function buildModelPayload() {
  const model = tpl.value.model;
  if (!model) return null;
  const groups = (model.groups || []).map((g) => {
    const name = String(g.name || '').trim();
    const type = String(g.type || 'select');
    const refs = String(g.refs || '').split(/[,，]+/).map((s) => s.trim()).filter(Boolean);
    const patterns = String(g.patterns || '').split(/[,，]+/).map((s) => s.trim()).filter(Boolean);
    const out = { name, type };
    if (type === 'select' || type === 'relay') {
      out.refs = refs;
    } else {
      out.patterns = patterns.length ? patterns : ['.*'];
      out.url = String(g.url || '').trim() || 'http://www.gstatic.com/generate_204';
      out.interval = Math.max(1, Math.round(Number(g.interval) || 300));
      out.tolerance = Math.max(0, Math.round(Number(g.tolerance) || 50));
    }
    return out;
  });
  const rules = (model.rules || [])
    .filter((r) => String(r.target || '').trim() || String(r.type || '').trim() || String(r.value || '').trim())
    .map((r) => {
      const out = {
        target: String(r.target || '').trim(),
        kind: r.kind === 'inline' ? 'inline' : 'url',
        type: String(r.type || '').trim().toUpperCase(),
        value: String(r.value || '').trim(),
      };
      const opts = String(r.options || '').split(/[,，]+/).map((s) => s.trim()).filter(Boolean);
      out.options = opts;
      return out;
    });
  if (!groups.length) { message.warning('至少需要一个策略组'); return null; }
  const badGroup = groups.find((g) => !g.name);
  if (badGroup) { message.warning('存在未命名的策略组'); return null; }
  // FINAL / MATCH 这类收尾规则没有 value，不能按普通规则要求内容
  const badRule = rules.find((r) => {
    if (!r.target) return true;
    if (r.kind === 'url') return !r.value;
    if (!r.type) return true;
    return !r.value && !['FINAL', 'MATCH'].includes(r.type);
  });
  if (badRule) { message.warning('存在未填完整的规则（目标组 / 类型 / 内容）'); return null; }
  const metaIn = model.meta || {};
  const meta = {};
  for (const key of ['title', 'description', 'author', 'version']) {
    const v = String(metaIn[key] || '').trim();
    if (v) meta[key] = v;
  }
  const targets = String(metaIn.targets || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  if (targets.length) meta.targets = targets;
  if (metaIn.extra && typeof metaIn.extra === 'object' && !Array.isArray(metaIn.extra)) meta.extra = { ...metaIn.extra };
  return { meta, groups, rules, extras: Array.isArray(model.extras) ? model.extras : [] };
}

function onTplContent(value) {
  tpl.value.content = value;
  // 手改原始内容后，可视化模型视为过期，下次切换时重新解析
  tpl.value.rawModel = null;
  tpl.value.model = null;
  tpl.value.warnings = [];
  if (tplMarks.value.length) tplMarks.value = [];
  if (tplCheck.value.errors.length || !tplCheck.value.ok) tplCheck.value = { ok: true, text: '', errors: [] };
}

async function switchTplMode(mode) {
  if (mode === tpl.value.mode || tpl.value.loading) return true;
  if (mode === 'visual') {
    if (!tpl.value.rawModel) {
      try {
        const out = await api('/api/templates/parse', { method: 'POST', body: { content: tpl.value.content } });
        tpl.value.rawModel = out.model || null;
        tpl.value.warnings = (out.warnings || []).map(String);
        syncTplMarks();
      } catch (e) {
        message.error((e.payload && e.payload.error) || e.message || '解析失败，无法切换到可视化');
        return false;
      }
    }
    if (!tpl.value.rawModel) tpl.value.rawModel = { meta: {}, groups: [], rules: [], extras: [] };
    if (tpl.value.model) {
      // 可视化模型已有未提交的改动，直接沿用
      tpl.value.mode = 'visual';
      return true;
    }
    tpl.value.model = toEditableModel(tpl.value.rawModel);
    tpl.value.mode = 'visual';
    return true;
  }
  if (!tpl.value.model) { tpl.value.mode = 'raw'; return true; }
  const payload = buildModelPayload();
  if (!payload) return false;
  try {
    const out = await api('/api/templates/build', { method: 'POST', body: { model: payload } });
    tpl.value.content = String(out.content || '');
    tpl.value.rawModel = payload;
    tpl.value.warnings = [];
    tplCheck.value = { ok: true, text: '已由可视化模型生成 INI', errors: [] };
    tplMarks.value = [];
    tpl.value.mode = 'raw';
    return true;
  } catch (e) {
    message.error((e.payload && e.payload.error) || e.message || '模型生成 INI 失败');
    return false;
  }
}

async function validateTemplate() {
  if (tpl.value.validating || tpl.value.loading) return;
  if (tpl.value.mode === 'visual') {
    const payload = buildModelPayload();
    if (!payload) return;
    tpl.value.validating = true;
    tplCheck.value = { ok: true, text: '', errors: [] };
    try {
      const out = await api('/api/templates/build', { method: 'POST', body: { model: payload } });
      const lines = String(out.content || '').split('\n').length;
      tplCheck.value = { ok: true, text: `校验通过，可生成 ${lines} 行 INI`, errors: [] };
      message.success(tplCheck.value.text);
    } catch (e) {
      const errs = ((e.payload && e.payload.details && e.payload.details.errors) || []).slice();
      const msg = errs[0] || (e.payload && e.payload.error) || e.message || '校验失败';
      tplCheck.value = { ok: false, text: msg, errors: errs.length ? errs : [msg] };
      message.error(msg);
    } finally { tpl.value.validating = false; }
    return;
  }
  if (!String(tpl.value.content || '').trim()) { message.warning('模板内容为空'); return; }
  tpl.value.validating = true;
  tplCheck.value = { ok: true, text: '', errors: [] };
  try {
    const out = await api('/api/templates/parse', { method: 'POST', body: { content: tpl.value.content } });
    const warnings = (out.warnings || []).map(String);
    tpl.value.warnings = warnings;
    tpl.value.rawModel = out.model || null;
    syncTplMarks();
    const build = await api('/api/templates/build', { method: 'POST', body: { model: out.model || {} } });
    const lines = String(build.content || '').split('\n').length;
    const text = warnings.length ? `解析完成，${warnings.length} 条警告；模型可生成 ${lines} 行` : `校验通过，模型可生成 ${lines} 行`;
    tplCheck.value = { ok: true, text, errors: [] };
    message.success(text);
  } catch (e) {
    const payload = e.payload || {};
    const errs = ((payload.details && payload.details.errors) || []).slice();
    const msg = errs[0] || payload.error || e.message || '校验失败';
    tplCheck.value = { ok: false, text: msg, errors: errs.length ? errs : [msg] };
    syncTplMarks();
    const line = tplWarnLine(msg) || findLineByKeyword(msg);
    if (line && !tplMarks.value.some((m) => m.line === line && m.kind === 'error')) {
      tplMarks.value = [...tplMarks.value, { line, kind: 'error', text: msg }];
    }
    message.error(msg);
    if (line) await focusTplLine(line);
  } finally { tpl.value.validating = false; }
}

// 切换到原始 INI 时编辑器是 v-if 挂载的，等 DOM 更新后再定位行
async function focusTplLine(line) {
  if (!line) return;
  await nextTick();
  tplEditor.value?.focusLine(line);
}

async function jumpTplLine(issue) {
  if (tpl.value.mode !== 'raw') {
    // 先切回原始 INI（会用 build 重建内容），再按最新内容定位关键词
    const ok = await switchTplMode('raw');
    if (!ok) return;
  }
  const line = tplWarnLine(issue) || findLineByKeyword(issue);
  if (!line) { message.info('这条提示没有行号'); return; }
  await focusTplLine(line);
}

function addTplGroup() {
  if (!tpl.value.model) tpl.value.model = toEditableModel(tpl.value.rawModel || {});
  tpl.value.model.groups.push({ name: '新策略组', type: 'select', refs: 'DIRECT', patterns: '', url: '', interval: 300, tolerance: 50 });
}
function removeTplGroup(index) {
  if (!tpl.value.model) return;
  tpl.value.model.groups.splice(index, 1);
}
function addTplRule() {
  if (!tpl.value.model) tpl.value.model = toEditableModel(tpl.value.rawModel || {});
  tpl.value.model.rules.push({ target: '🚀 节点选择', kind: 'url', type: 'DOMAIN-SUFFIX', value: '', options: '' });
}
function removeTplRule(index) {
  if (!tpl.value.model) return;
  tpl.value.model.rules.splice(index, 1);
}

async function editTemplate(name) {
  if (!can('templates:write')) { message.warning('需要「模板编辑」权限'); return; }
  tplOpen.value = true;
  tpl.value = {
    name, title: name, content: '', mode: 'raw',
    model: null, rawModel: null, warnings: [], loading: true, saving: false, validating: false,
  };
  tplCheck.value = { ok: true, text: '', errors: [] };
  tplMarks.value = [];
  try {
    const info = await api(`/api/templates/${encodeURIComponent(name)}`);
    tpl.value.title = info.title || info.name || name;
    tpl.value.content = String(info.content || '');
    tpl.value.rawModel = info.model || null;
    tpl.value.warnings = (info.warnings || (info.model && info.model.warnings) || []).map(String);
    syncTplMarks();
  } catch (e) {
    message.error(e.message || '读取模板失败');
    tplOpen.value = false;
  } finally { tpl.value.loading = false; }
}

async function saveTemplate() {
  if (!tpl.value.name || tpl.value.saving) return;
  let body;
  if (tpl.value.mode === 'visual') {
    const model = buildModelPayload();
    if (!model) return;
    body = { model };
  } else {
    if (!String(tpl.value.content || '').trim()) { message.warning('模板内容为空，无法保存'); return; }
    body = { content: tpl.value.content };
  }
  tpl.value.saving = true;
  try {
    await api(`/api/templates/${encodeURIComponent(tpl.value.name)}`, { method: 'PUT', body });
    message.success('模板已保存');
    tplOpen.value = false;
    await loadState();
  } catch (e) {
    const msg = (e.payload && e.payload.error) || e.message || '保存失败';
    message.error(msg);
    if (tpl.value.mode !== 'raw' && !(await switchTplMode('raw'))) return;
    const line = findLineByKeyword(msg);
    if (line) await focusTplLine(line);
  } finally { tpl.value.saving = false; }
}

function openTplSaveAs() {
  tplSaveAsName.value = `${tpl.value.name}-copy`;
  tplSaveAsOpen.value = true;
}
async function saveTemplateAs() {
  const name = String(tplSaveAsName.value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) { message.warning('模板名只能用小写字母、数字、点、下划线与短横线'); return; }
  if (state.templates.some((t) => t.name === name)) { message.warning('同名模板已存在'); return; }
  let body;
  if (tpl.value.mode === 'visual') {
    const model = buildModelPayload();
    if (!model) return;
    body = { name, model };
  } else {
    if (!String(tpl.value.content || '').trim()) { message.warning('模板内容为空，无法另存'); return; }
    body = { name, content: tpl.value.content };
  }
  tplSaveAsBusy.value = true;
  try {
    await api('/api/templates', { method: 'POST', body });
    message.success(`已另存为 ${name}`);
    tplSaveAsOpen.value = false;
    await loadState();
  } catch (e) { message.error((e.payload && e.payload.error) || e.message || '另存失败'); }
  finally { tplSaveAsBusy.value = false; }
}

// 新建模板（从现有模板复制）
const newTplOpen = ref(false);
const newTpl = ref({ name: '', from: '' });
async function createTemplate() {
  const name = String(newTpl.value.name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) { message.warning('模板名只能用小写字母、数字、点、下划线与短横线'); return; }
  if (state.templates.some((t) => t.name === name)) { message.warning('同名模板已存在'); return; }
  const from = newTpl.value.from || (state.templates[0] && state.templates[0].name);
  try {
    const src = await api(`/api/templates/${encodeURIComponent(from)}`);
    await api('/api/templates', { method: 'POST', body: { name, content: src.content } });
    message.success(`已创建模板 ${name}`);
    newTplOpen.value = false;
    newTpl.value = { name: '', from: '' };
    await loadState();
  } catch (e) { message.error(e.message || '创建失败'); }
}

// 来源仓库
const repoOpen = ref(false);
const repoForm = ref({ id: '', name: '', home: '', clash: '', mihomo: '', singbox: '', note: '' });
function openRepo(item) {
  repoForm.value = item
    ? { id: item.id, name: item.name || '', home: item.home || '', clash: item.clash || '', mihomo: item.mihomo || '', singbox: item.singbox || '', note: item.note || '' }
    : { id: '', name: '', home: '', clash: '', mihomo: '', singbox: '', note: '' };
  repoOpen.value = true;
}
async function saveRepo() {
  const f = repoForm.value;
  if (!f.name.trim()) { message.warning('请填写仓库名称'); return; }
  const body = { name: f.name.trim(), home: f.home.trim(), clash: f.clash.trim(), mihomo: f.mihomo.trim(), singbox: f.singbox.trim(), note: f.note.trim() };
  if (!f.id) body.id = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  try {
    const exists = !!f.id && repos.value.some((r) => r.id === f.id);
    const base = '/api/library/repos';
    await api(exists ? `${base}/${encodeURIComponent(f.id)}` : base, { method: exists ? 'PUT' : 'POST', body: { ...body, id: exists ? f.id : body.id } });
    message.success('仓库已保存');
    repoOpen.value = false;
    await loadState();
  } catch (e) { message.error(e.message || '保存失败'); }
}
async function removeRepo(id) {
  try { await api(`/api/library/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }); message.success('已删除'); await loadState(); }
  catch (e) { message.error(e.message || '删除失败'); }
}
function addRulesetFromRepo(repo) {
  const prefix = repo.clash || repo.mihomo || repo.singbox || '';
  openEditor('ruleset', null);
  editor.value.repo = repo.name;
  editor.value.url = prefix ? `${prefix}/` : '';
  message.info('填写规则名并补全地址，例如 ' + (prefix ? prefix + '/Video/Video.list' : 'https://…'));
}
function useTemplate(name) {
  state.convert.template = name;
  state.view = 'convert';
  message.success(`已切换模板：${name}`);
}

async function refreshCatalog() {
  try {
    const data = await api('/api/catalog/refresh', { method: 'POST' });
    message.success(`目录已更新，共 ${data.count} 条`);
    await loadState();
  } catch (e) { message.error(e.message || '更新失败'); }
}

onMounted(async () => {
  loadOverrides();
  if (!state.library.rulesets.length) await loadState().catch(() => {});
});

/* ── 图标库 ──
   分类展示元数据（名称/颜色/顺序/删除迁移）由 components/iconCats.js 统一维护，
   与 IconPicker 共用；后端图标只保存 category 字段。 */
const iconQ = ref('');
const iconUploadName = ref('');
const iconUploadCat = ref('自定义');
const iconCat = ref('');
const iconBusy = ref(false);
const iconEditBusy = ref(false);
const iconEditOpen = ref(false);
const iconEdit = ref({ id: '', name: '', category: '' });
const iconManageOpen = ref(false);

const iconCats = computed(() => makeIconCatList(state.icons || []));
const iconCatChips = computed(() => makeIconCatChips(state.icons || [], iconCat.value));
const iconCatOptions = computed(() => makeIconCatOptions(state.icons || []));
const iconSummary = computed(() => {
  const list = state.icons || [];
  const builtin = list.filter((it) => it.builtin).length;
  return {
    total: list.length,
    builtin,
    custom: list.length - builtin,
    cats: iconCats.value.filter((c) => c.key !== UNCAT).length,
  };
});
const iconFiltered = computed(() => {
  let list = (state.icons || []).slice();
  if (iconCat.value) list = list.filter((it) => resolveCatKey(it.category) === iconCat.value);
  const needle = iconQ.value.trim().toLowerCase();
  if (needle) {
    list = list.filter((it) => `${it.name} ${it.category} ${labelForIconCat(resolveCatKey(it.category))} ${it.id}`
      .toLowerCase().includes(needle));
  }
  return list;
});
const shownIcons = computed(() => iconFiltered.value);
const iconGroups = computed(() => {
  const cats = iconCat.value ? iconCats.value.filter((c) => c.key === iconCat.value) : iconCats.value;
  return cats
    .map((c) => ({ ...c, icons: iconFiltered.value.filter((it) => resolveCatKey(it.category) === c.key) }))
    .filter((g) => g.icons.length);
});
const iconEditTarget = computed(() => (state.icons || []).find((it) => it.id === iconEdit.value.id) || null);

function normalizeIconCatValue(value, create = true) {
  const raw = String(value || '').trim();
  if (!raw) return '自定义';
  const byKey = iconCats.value.find((c) => c.key === raw);
  if (byKey) return byKey.key;
  const byLabel = iconCats.value.find((c) => c.label === raw);
  if (byLabel) return byLabel.key;
  if (create) ensureIconCat(raw, raw);
  return raw;
}
function onIconUploadCatChange(value) {
  iconUploadCat.value = normalizeIconCatValue(value, false);
}
function openIconCatManage() {
  syncIconCats(state.icons || []);
  iconManageOpen.value = true;
}
const iconCatText = (key) => labelForIconCat(key);
function clearIconFilters() {
  iconQ.value = '';
  iconCat.value = '';
}

async function uploadIconFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 96 * 1024) { message.warning('图片不能超过 96KB'); return; }
  const category = normalizeIconCatValue(iconUploadCat.value, true);
  const reader = new FileReader();
  reader.onload = async () => {
    iconBusy.value = true;
    try {
      const name = (iconUploadName.value || file.name.replace(/\.[^.]+$/, '')).slice(0, 24);
      const out = await api('/api/icons', { method: 'POST', body: { name, value: String(reader.result || ''), category } });
      state.icons.push(out.icon);
      ensureIconCat(out.icon.category, labelForIconCat(out.icon.category));
      iconUploadName.value = '';
      message.success(`已上传 ${out.icon.name}（分类：${labelForIconCat(out.icon.category)}）`);
    } catch (e) { message.error(e.payload?.error || e.message || '上传失败'); }
    iconBusy.value = false;
  };
  reader.readAsDataURL(file);
}

function editIcon(icon) {
  iconEdit.value = { id: icon.id, name: icon.name, category: icon.category || UNCAT };
  iconEditOpen.value = true;
}

async function saveIconEdit() {
  if (iconEditBusy.value) return;
  const name = String(iconEdit.value.name || '').trim();
  if (!name) { message.warning('请填写图标名称'); return; }
  const category = normalizeIconCatValue(iconEdit.value.category, true);
  iconEditBusy.value = true;
  try {
    const out = await api(`/api/icons/${encodeURIComponent(iconEdit.value.id)}`, { method: 'PUT', body: { name, category } });
    const idx = state.icons.findIndex((it) => it.id === out.icon.id);
    if (idx >= 0) state.icons[idx] = out.icon;
    ensureIconCat(out.icon.category, labelForIconCat(out.icon.category));
    iconEditOpen.value = false;
    message.success('图标已保存');
  } catch (e) { message.error(e.payload?.error || e.message || '保存失败'); }
  iconEditBusy.value = false;
}

async function removeIcon(icon) {
  if (!window.confirm(`确定删除图标「${icon.name}」？`)) return;
  try {
    await api(`/api/icons/${encodeURIComponent(icon.id)}`, { method: 'DELETE' });
    state.icons = state.icons.filter((it) => it.id !== icon.id);
    message.success('图标已删除');
  } catch (e) { message.error(e.payload?.error || e.message || '删除失败'); }
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">资源库</h1>
    <p class="page-desc">规则集、转换模板、基础配置与 DNS 统一在这里管理，可在转换页直接引用。</p>

    <n-card size="small">
      <n-tabs v-model:value="tab" type="segment" animated>
        <n-tab-pane name="ruleset" tab="规则集管理">
          <div class="stack">
            <n-card size="small" title="官方规则集目录" :bordered="false" embedded>
              <template #header-extra>
                <div class="row">
                  <n-tag size="small">{{ state.catalog.count }} 条</n-tag>
                  <n-button size="tiny" quaternary :disabled="!can('catalog:refresh')" @click="refreshCatalog">↻ 更新目录</n-button>
                  <n-button size="tiny" quaternary :disabled="!can('library:write')" @click="openSettings">更新设置</n-button>
                  <n-button size="tiny" quaternary :disabled="!can('library:write')" @click="openEditor('ruleset', null)">＋ 添加规则集</n-button>
                </div>
              </template>

              <!-- 分类平铺：替代原下拉框，点 chip 即筛选下方的规则集卡片 -->
              <div class="cat-row">
                <button
                  type="button" class="cat-chip" :class="{ active: !catFilter }"
                  style="--cat-color: var(--accent)" title="显示全部分类" @click="catFilter = ''"
                >
                  <span class="cat-dot" style="background: var(--accent)" />
                  <span>全部</span><span class="cat-num">{{ rulesets.length }}</span>
                </button>
                <button
                  v-for="c in categories" :key="c.name" type="button" class="cat-chip"
                  :class="{ active: catFilter === c.name }"
                  :style="{ '--cat-color': c.color }"
                  :title="`只看「${c.name}」分类的规则集`"
                  @click="catFilter = catFilter === c.name ? '' : c.name"
                >
                  <span class="cat-dot" :style="{ background: c.color }" />
                  <span>{{ c.name }}</span><span class="cat-num">{{ c.count }}</span>
                </button>
                <span v-if="!categories.length" class="hint">还没有分类，点「＋ 分类」新建后即可给规则集归类。</span>
                <span class="spacer" />
                <div v-if="can('library:write')" class="cat-actions">
                  <n-button size="tiny" quaternary title="新建、重命名、删除分类" @click="openCatManage">＋ 分类</n-button>
                </div>
              </div>

              <n-input :value="q" placeholder="搜索：Netflix、Google、广告、流媒体…（支持中文）" @update:value="search" />
              <n-spin :show="searching">
                <div v-if="!results.length" class="hint" style="margin-top: 10px">
                  输入关键词搜索 {{ state.catalog.count }} 条官方规则集，支持中文名，例如「广告」「谷歌」「流媒体」「cn」。
                </div>
                <div v-else class="stack" style="margin-top: 10px">
                  <div class="hint">匹配 {{ total }} 条</div>
                  <div v-for="it in results" :key="it.id" class="node-row" style="align-items: flex-start">
                    <span class="tag tag-src" :class="it.kind === 'geoip' ? 'is-ip' : 'is-domain'">
                      {{ it.kind === 'geoip' ? 'IP' : '域名' }}
                    </span>
                    <div style="min-width: 0; flex: 1">
                      <div class="row" style="gap: 6px">
                        <n-tooltip v-if="it.desc || (it.tags || []).length" trigger="hover" placement="top-start" :show-arrow="false">
                          <template #trigger><b class="tip-target">{{ it.title }}</b></template>
                          <RulesetMetaTip :meta="it.meta" :name="it.title" :desc="it.desc" :tags="it.tags" />
                        </n-tooltip>
                        <b v-else>{{ it.title }}</b>
                        <span class="hint mono">{{ it.id }}</span>
                        <span class="hint">{{ it.cnt || (it.meta && it.meta.count) || 0 }} 条</span>
                        <span v-if="it.meta && it.meta.size" class="hint">{{ it.meta.size }}</span>
                      </div>
                      <div v-if="it.desc" class="hint rule-desc" style="margin-top: 2px">{{ it.desc }}</div>
                      <div v-if="(it.tags || []).length" class="row tag-row">
                        <n-tooltip v-for="t in it.tags" :key="t" trigger="hover" placement="top" :show-arrow="false">
                          <template #trigger>
                            <span class="tag tag-pill" :style="{ '--tag-color': tagTone(t) }">{{ t }}</span>
                          </template>
                          <RulesetMetaTip :meta="it.meta" :name="it.title" :desc="it.desc" :tags="it.tags" />
                        </n-tooltip>
                      </div>
                    </div>
                    <div class="row" style="gap: 6px">
                      <n-button size="tiny" type="primary" ghost @click="openAddDialog(it)">加入</n-button>
                      <n-button size="tiny" quaternary :loading="addBusy" @click="addWithDefaults(it)">默认加入</n-button>
                    </div>
                  </div>
                </div>
              </n-spin>
            </n-card>

            <div class="row">
              <b>规则集管理</b>
              <n-tag size="small">{{ shownRulesets.length }}</n-tag>
              <span class="hint">{{ catFilter ? `分类：${catFilter}` : '全部分类' }}</span>
              <span style="margin-left: auto" />
              <n-button size="tiny" quaternary @click="formatHelpOpen = true">格式说明</n-button>
              <n-button size="tiny" type="primary" ghost :disabled="!can('library:write')" @click="goAddRule">＋ 添加规则</n-button>
              <n-select v-model:value="density" size="tiny" :options="[{label:'紧凑',value:'compact'},{label:'标准',value:'normal'},{label:'宽松',value:'wide'},{label:'列表',value:'list'}]" style="width: 104px" />
            </div>
            <div class="row tag-row" style="gap: 6px; align-items: center">
              <span class="hint">常用规则集：</span>
              <n-tooltip
                v-for="r in commonRulesets" :key="r.id" trigger="hover" placement="top"
                :show-arrow="false" :disabled="!cardTip(r)"
              >
                <template #trigger>
                  <span class="tag tag-pill" :class="r.builtin ? 'is-builtin' : 'is-own'" :style="{ '--tag-color': r.builtin ? '#38bdf8' : '#4ade80' }">
                    <button type="button" class="tag-link" title="编辑" @click="openEditor('ruleset', r)">{{ r.name }}</button>
                  </span>
                </template>
                <RulesetMetaTip :meta="r.meta" :name="r.name" :desc="r.desc" :tags="r.tags" />
              </n-tooltip>
              <button type="button" class="tag tag-add" :disabled="!can('library:write')" @click="openEditor('ruleset', null)">＋ 新增</button>
              <span class="hint">点名称编辑；内置规则集也可改分类 / 标签 / 说明（存在本机覆盖）；自建规则集可删除。</span>
            </div>
            <div v-if="can('library:write')" class="bulk-bar" :class="{ active: bulkSel.length }">
              <n-checkbox :checked="bulkAllChecked" :indeterminate="bulkSel.length > 0 && !bulkAllChecked" @update:checked="toggleBulkAll">
                全选本分类
              </n-checkbox>
              <span class="hint">已选 {{ bulkSel.length }} / {{ shownRulesets.length }}</span>
              <template v-if="bulkSel.length">
                <n-button size="tiny" quaternary :loading="bulkBusy" @click="bulkCheck">批量检查更新</n-button>
                <n-button size="tiny" quaternary type="error" :loading="bulkBusy" @click="bulkRemove">批量删除</n-button>
                <n-button size="tiny" quaternary @click="bulkSel = []">取消选择</n-button>
              </template>
            </div>
            <div class="lib-grid" :class="{ compact: density === 'compact', wide: density === 'wide', list: density === 'list' }">
              <div v-for="r in shownRulesets" :key="r.id" class="lib-card" :class="{ picked: bulkSel.includes(r.id) }">
                <div class="row">
                  <n-checkbox v-if="can('library:write')" :checked="bulkSel.includes(r.id)" @update:checked="toggleBulk(r.id)" />
                  <n-tooltip v-if="cardTip(r)" trigger="hover" placement="top-start" :show-arrow="false" :style="{ maxWidth: '320px' }">
                    <template #trigger><b class="tip-target">{{ r.name }}</b></template>
                    <RulesetMetaTip :meta="r.meta" :name="r.name" :desc="r.desc" :tags="r.tags" />
                  </n-tooltip>
                  <b v-else>{{ r.name }}</b>
                  <span v-if="r.cat" class="tag tag-cat" :style="{ '--tag-color': catColor(r.cat) }">{{ r.cat }}</span>
                  <span class="tag tag-repo" :style="{ '--tag-color': repoColor(r.repo || (r.builtin ? '内置' : '自建')) }">{{ r.repo || (r.builtin ? '内置' : '自建') }}</span>
                  <span v-if="r.metaOverride" class="tag tag-src is-local" title="名称 / 分类 / 标签 / 说明在本机覆盖，未写入服务端">本地改</span>
                </div>
                <div class="row tag-row">
                  <span class="tag tag-fmt" :class="`fmt-${rulesetFormat(r)}`">{{ rulesetFormat(r) }}</span>
                  <span
                    v-if="r.remote && r.checkOnly" class="tag tag-plan is-checkonly"
                    :title="`只比对远端 hash，不写入规则内容 · 每 ${r.intervalHours} 小时`"
                  >check-only</span>
                  <span
                    v-else-if="r.remote && r.customPlan" class="tag tag-plan is-custom"
                    :title="`自定义间隔 ${r.intervalHours} 小时（1–720）`"
                  >custom {{ r.intervalHours }}h</span>
                  <span
                    v-else-if="r.remote && r.autoUpdate" class="tag tag-ok"
                    :title="`每 ${r.intervalHours || 24} 小时检查一次 · ${r.updateMode === 'append' ? 'append' : 'replace'}`"
                  >自动 {{ r.intervalHours || 24 }}h</span>
                  <span
                    v-if="r.remote && !r.checkOnly" class="tag tag-plan"
                    :class="r.updateMode === 'append' ? 'is-append' : 'is-replace'"
                  >{{ r.updateMode === 'append' ? 'append' : 'replace' }}</span>
                </div>
                <div class="hint mono">{{ r.id }}</div>
                <div v-if="r.desc" class="hint rule-desc">{{ r.desc }}</div>
                <div v-if="(r.tags || []).length" class="row tag-row">
                  <n-tooltip v-for="t in r.tags" :key="t" trigger="hover" placement="top" :show-arrow="false">
                    <template #trigger>
                      <span class="tag tag-pill" :style="{ '--tag-color': tagTone(t) }">{{ t }}</span>
                    </template>
                    <RulesetMetaTip :meta="r.meta" :name="r.name" :desc="r.desc" :tags="r.tags" />
                  </n-tooltip>
                </div>
                <div class="row tag-row">
                  <span class="tag tag-soft">{{ r.group }}</span>
                  <span class="tag tag-behavior" :data-b="r.behavior" :title="r.behavior === 'domain' ? '域名规则：按域名匹配' : r.behavior === 'ipcidr' ? 'IP 段规则：按 CIDR 匹配' : 'classical：经典规则类型，混合域名/关键词/IP'">{{ r.behavior }}</span>
                  <span v-if="r.builtin" class="tag tag-builtin" title="内置规则集：可编辑元数据与更新方式，但不可删除">内置</span>
                </div>
                <div class="row tag-row check-line">
                  <span v-if="checkInfoOf(r).text" class="tag check-state" :class="checkInfoOf(r).cls || 'tag-idle'" :title="checkInfoOf(r).title">
                    {{ checkInfoOf(r).text }}
                  </span>
                  <span class="tag tag-time" :class="checkInfoOf(r).at ? 'is-ok' : 'is-idle'" :title="`上次检查时间（MM/DD HH:mm）：${checkInfoOf(r).at || '尚未检查'}`">
                    {{ checkInfoOf(r).at || '未检查' }}
                  </span>
                  <span
                    class="tag tag-hash mono"
                    :title="checkInfoOf(r).full ? `remoteHash ${checkInfoOf(r).full}` : '还没有远端 hash'"
                  >{{ checkInfoOf(r).hash || '—' }}</span>
                  <n-tooltip trigger="hover" placement="top" :show-arrow="false">
                    <template #trigger>
                      <n-button
                        size="tiny" quaternary circle class="check-btn"
                        :loading="rulesetCheckBusy(r.id)" :disabled="!r.remote"
                        @click="checkRuleset(r)"
                      ><UiIcon name="refresh" :size="13" /></n-button>
                    </template>
                    <span>{{ r.remote ? '检查远端更新：只比对 hash 与检查时间，不写入规则内容' : '内联规则没有远端地址，无法检查' }}</span>
                  </n-tooltip>
                </div>
                <div class="row lib-actions">
                  <n-button size="tiny" quaternary @click="openEditor('ruleset', r)">编辑</n-button>
                  <n-button v-if="!r.builtin" size="tiny" quaternary type="error" @click="removeItem('ruleset', r.id)">删除</n-button>
                </div>
              </div>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="template" tab="转换模板">
          <div class="stack">
            <div class="row">
              <span class="hint">模板决定策略组与规则骨架，可直接使用，也可以复制后修改。</span>
              <span style="margin-left: auto" />
              <n-button size="tiny" type="primary" ghost :disabled="!can('templates:write')" @click="newTplOpen = true">＋ 新建模板</n-button>
            </div>
            <div class="lib-grid">
              <div v-for="t in state.templates" :key="t.name" class="lib-card">
                <div class="row"><b>{{ t.title || t.name }}</b><n-tag size="tiny" :bordered="false">{{ t.name }}</n-tag></div>
                <div class="hint">{{ t.description || '—' }}</div>
                <div class="hint">{{ t.groups }} 组 · {{ t.rules }} 条规则 · {{ t.bytes }} B</div>
                <div class="row">
                  <n-button size="tiny" type="primary" ghost @click="useTemplate(t.name)">使用</n-button>
                  <n-button size="tiny" quaternary :disabled="!can('templates:write')" @click="editTemplate(t.name)">编辑</n-button>
                </div>
              </div>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="layer" tab="基础与 DNS">
          <div class="cfg-grid">
            <section class="cfg-card" style="--cfg-color: #14b8a6">
              <header class="cfg-head">
                <div class="cfg-title">
                  <span class="cfg-badge">B</span>
                  <div>
                    <b>基础配置</b>
                    <div class="hint">合并进输出：端口、模式、嗅探等全局项</div>
                  </div>
                </div>
                <div class="row">
                  <n-tag size="small" :bordered="false">{{ bases.length }} 项</n-tag>
                  <n-button size="tiny" type="primary" ghost :disabled="!can('library:write')" @click="openEditor('base', null)">＋ 新建</n-button>
                </div>
              </header>
              <div class="cfg-list">
                <div v-if="!bases.length" class="cfg-empty">
                  <span>还没有基础配置。</span>
                  <n-button size="tiny" quaternary :disabled="!can('library:write')" @click="openEditor('base', null)">新建第一份</n-button>
                </div>
                <div v-for="b in bases" :key="b.id" class="cfg-item">
                  <div class="cfg-item-head">
                    <b>{{ b.name }}</b>
                    <span class="tag tag-muted">{{ b.format }}</span>
                    <span class="hint mono">{{ b.id }}</span>
                    <span class="spacer" />
                    <n-button size="tiny" quaternary @click="toggleLayer('base', b)">{{ openLayer === 'base:' + b.id ? '收起' : '预览' }}</n-button>
                    <n-button size="tiny" quaternary @click="openEditor('base', b)">查看/编辑</n-button>
                  </div>
                  <div v-if="openLayer === 'base:' + b.id" class="cfg-preview">
                    <div class="cfg-preview-head">
                      <span class="tag tag-muted">YAML</span>
                      <span class="hint">{{ layerLines('base', b) }} 行 · {{ layerChars('base', b) }} 字符</span>
                      <span class="spacer" />
                      <n-button size="tiny" quaternary @click="copyLayer('base', b)">复制</n-button>
                    </div>
                    <pre class="mini-code hl"><code v-html="highlightYaml(layerText('base', b))"></code></pre>
                  </div>
                </div>
              </div>
            </section>

            <section class="cfg-card" style="--cfg-color: #8b5cf6">
              <header class="cfg-head">
                <div class="cfg-title">
                  <span class="cfg-badge">D</span>
                  <div>
                    <b>DNS 配置</b>
                    <div class="hint">对应 mihomo 的 dns 段，可单独预览与编辑</div>
                  </div>
                </div>
                <div class="row">
                  <n-tag size="small" :bordered="false">{{ dns.length }} 项</n-tag>
                  <n-button size="tiny" type="primary" ghost :disabled="!can('library:write')" @click="openEditor('dns', null)">＋ 新建</n-button>
                </div>
              </header>
              <div class="cfg-list">
                <div v-if="!dns.length" class="cfg-empty">
                  <span>还没有 DNS 配置。</span>
                  <n-button size="tiny" quaternary :disabled="!can('library:write')" @click="openEditor('dns', null)">新建第一份</n-button>
                </div>
                <div v-for="d in dns" :key="d.id" class="cfg-item">
                  <div class="cfg-item-head">
                    <b>{{ d.name }}</b>
                    <span class="tag tag-muted">{{ d.format }}</span>
                    <span class="hint mono">{{ d.id }}</span>
                    <span class="spacer" />
                    <n-button size="tiny" quaternary @click="toggleLayer('dns', d)">{{ openLayer === 'dns:' + d.id ? '收起' : '预览' }}</n-button>
                    <n-button size="tiny" quaternary @click="openEditor('dns', d)">查看/编辑</n-button>
                  </div>
                  <div v-if="openLayer === 'dns:' + d.id" class="cfg-preview">
                    <div class="cfg-preview-head">
                      <span class="tag tag-muted">YAML</span>
                      <span class="hint">{{ layerLines('dns', d) }} 行 · {{ layerChars('dns', d) }} 字符</span>
                      <span class="spacer" />
                      <n-button size="tiny" quaternary @click="copyLayer('dns', d)">复制</n-button>
                    </div>
                    <pre class="mini-code hl"><code v-html="highlightYaml(layerText('dns', d))"></code></pre>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </n-tab-pane>

        <n-tab-pane name="repo" tab="来源仓库">
          <div class="stack">
            <div class="row">
              <span class="hint">规则集出处标签：官方仓库与自建仓库都在这里维护，也可以从仓库快速新建规则集。</span>
              <span style="margin-left: auto" />
              <n-button size="tiny" type="primary" ghost :disabled="!can('library:write')" @click="openRepo(null)">＋ 添加仓库</n-button>
              <n-button size="tiny" quaternary :disabled="!can('library:write')" @click="openEditor('ruleset', null)">＋ 添加规则集</n-button>
            </div>
            <div class="lib-grid">
              <div v-for="r in repos" :key="r.id" class="lib-card">
                <div class="row">
                  <b>{{ r.name }}</b>
                  <span v-if="r.builtin" class="tag tag-muted">内置</span>
                </div>
                <div class="hint mono">{{ r.id }}</div>
                <div class="hint">{{ r.note || '—' }}</div>
                <div class="row tag-row">
                  <span v-if="r.clash" class="tag tag-muted">Clash</span>
                  <span v-if="r.mihomo" class="tag tag-accent">mihomo</span>
                  <span v-if="r.singbox" class="tag tag-ok">sing-box</span>
                </div>
                <div class="row">
                  <n-button size="tiny" type="primary" ghost :disabled="!can('library:write')" @click="addRulesetFromRepo(r)">新建规则集</n-button>
                  <n-button size="tiny" quaternary :disabled="!can('library:write')" @click="openRepo(r)">编辑</n-button>
                  <n-button size="tiny" quaternary type="error" :disabled="r.builtin || !can('library:write')" @click="removeRepo(r.id)">删除</n-button>
                </div>
              </div>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="icons" tab="图标库">
          <div class="stack icon-library">
            <div class="icon-toolbar">
              <n-input v-model:value="iconQ" clearable placeholder="搜索图标名称、分类或 id…" class="icon-search" />
              <n-tag size="small" :bordered="false">{{ shownIcons.length }} / {{ (state.icons || []).length }}</n-tag>
              <span class="hint">内置 {{ iconSummary.builtin }} · 自定义 {{ iconSummary.custom }} · {{ iconSummary.cats }} 个分类</span>
              <span class="spacer" />
              <n-button size="small" quaternary @click="openIconCatManage">分类管理</n-button>
            </div>

            <div class="icon-upload-box">
              <div class="icon-upload-copy">
                <b>上传图标</b>
                <span class="hint">PNG / JPEG / WebP / SVG，单张 ≤96KB；也可以把 emoji 作为图标值直接使用。</span>
              </div>
              <div class="icon-upload-fields">
                <n-input v-model:value="iconUploadName" placeholder="图标名称（可选）" style="width: 150px" />
                <n-select
                  v-model:value="iconUploadCat" :options="iconCatOptions" filterable tag
                  placeholder="分类，默认「自定义」" style="width: 170px"
                  @update:value="onIconUploadCatChange"
                />
                <label class="file-btn" :class="{ disabled: !can('icons:write') }">
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" :disabled="!can('icons:write')" @change="uploadIconFile" />
                  {{ iconBusy ? '上传中…' : '选择文件上传' }}
                </label>
                <span v-if="!can('icons:write')" class="hint">当前账号没有图标写入权限</span>
              </div>
            </div>

            <div class="cat-row icon-cat-row">
              <button
                v-for="c in iconCatChips" :key="c.key || 'all'" type="button" class="cat-chip"
                :class="{ active: iconCat === c.key }" :title="c.key ? `只看「${c.label}」分类` : '显示全部图标'"
                :style="{ '--cat-color': c.color }"
                @click="iconCat = c.key"
              >
                <span class="cat-dot" :style="{ background: c.color }" />
                <span>{{ c.label }}</span><span class="cat-num">{{ c.count }}</span>
              </button>
            </div>

            <div v-if="!iconGroups.length" class="icon-empty">
              <span class="icon-empty-glyph">◌</span>
              <b>{{ iconQ.trim() ? '没有找到匹配的图标' : iconCat ? '这个分类下还没有图标' : '图标库还是空的' }}</b>
              <p class="hint">
                {{ iconQ.trim()
                  ? `没有与「${iconQ.trim()}」匹配的图标，换个关键词试试。`
                  : iconCat
                    ? `「${iconCatText(iconCat)}」分类下还没有图标，可以上传或切换到其它分类。`
                    : '上传 PNG / JPEG / WebP / SVG（≤96KB），或在图标名称里直接使用 emoji。' }}
              </p>
              <div class="icon-empty-actions">
                <n-button v-if="iconQ.trim() || iconCat" size="small" quaternary @click="clearIconFilters">查看全部图标</n-button>
                <label class="file-btn" :class="{ disabled: !can('icons:write') }">
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" :disabled="!can('icons:write')" @change="uploadIconFile" />
                  上传图标
                </label>
                <n-button size="small" quaternary @click="openIconCatManage">管理分类</n-button>
              </div>
            </div>
            <template v-else>
              <section v-for="g in iconGroups" :key="g.key" class="icon-section">
                <div class="icon-section-head">
                  <span class="cat-dot" :style="{ background: g.color }" />
                  <b>{{ g.label }}</b>
                  <span class="cat-num">{{ g.icons.length }}</span>
                  <span v-if="g.key === UNCAT" class="hint">尚未归类</span>
                </div>
                <div class="icon-grid">
                  <div v-for="icon in g.icons" :key="icon.id" class="icon-cell" :title="icon.id">
                    <span class="icon-face">
                      <img v-if="String(icon.value).startsWith('data:')" :src="icon.value" :alt="icon.name" />
                      <template v-else>{{ icon.value }}</template>
                    </span>
                    <span class="icon-name" :title="icon.name">{{ icon.name }}</span>
                    <span class="icon-cat"><i class="cat-dot" :style="{ background: g.color }" />{{ g.label }}</span>
                    <div v-if="!icon.builtin && can('icons:write')" class="icon-actions">
                      <n-button size="tiny" quaternary @click.stop="editIcon(icon)">编辑</n-button>
                      <n-button size="tiny" quaternary type="error" @click.stop="removeIcon(icon)">删除</n-button>
                    </div>
                    <span v-else class="icon-lock">内置</span>
                  </div>
                </div>
              </section>
            </template>
            <p class="hint">图标用于节点与策略组的可视化标识，不会写入客户端配置；内置图标只读。</p>
          </div>
        </n-tab-pane>
      </n-tabs>
    </n-card>

    <n-modal v-model:show="catManageOpen" preset="card" title="规则集分类" style="width: 820px; max-width: 96vw">
      <div class="stack cat-manage">
        <div class="row cat-manage-head">
          <span class="hint">重命名会同步更新规则集；上下箭头调整顺序；删除时把规则集迁移到其它分类。</span>
          <span class="spacer" />
          <n-tag size="small">{{ categories.length }} 个分类</n-tag>
          <n-tag size="small">{{ rulesets.length }} 个规则集</n-tag>
        </div>

        <div v-if="!catRows.length" class="cat-empty">还没有分类，在下方创建第一个分类。</div>
        <div
          v-for="(row, index) in catRows" :key="row.name" class="cat-manage-row"
          :class="{ 'is-system': row.name === UNCAT }"
        >
          <span class="cat-dot" :style="{ background: row.editColor }" />
          <n-input
            v-model:value="row.editName" size="small" :maxlength="20"
            :disabled="row.name === UNCAT" placeholder="分类名称" style="width: 150px"
          />
          <div class="cat-swatches">
            <button
              v-for="c in SWATCHES" :key="'m-' + row.name + '-' + c" type="button" class="swatch sm"
              :class="{ on: row.editColor === c }" :style="{ '--sw': c }" :title="c"
              :disabled="row.name === UNCAT" @click="row.editColor = c"
            />
          </div>
          <n-tag size="tiny" :bordered="false">{{ row.count }}</n-tag>
          <span class="spacer" />
          <div class="cat-row-actions">
            <n-button size="tiny" quaternary :disabled="index === 0 || row.name === UNCAT || catBusy" title="上移" @click="moveCatRow(index, -1)">↑</n-button>
            <n-button size="tiny" quaternary :disabled="index === catRows.length - 1 || row.name === UNCAT || catBusy" title="下移" @click="moveCatRow(index, 1)">↓</n-button>
            <n-button size="tiny" type="primary" ghost :loading="catBusy" :disabled="row.name === UNCAT" @click="saveCatRow(row)">保存</n-button>
            <n-button size="tiny" type="error" quaternary :disabled="row.name === UNCAT || catBusy" @click="askDeleteCategory(row)">删除</n-button>
          </div>

          <div v-if="catDelete.open && catDelete.name === row.name" class="cat-del-inline">
            <template v-if="row.count > 0">
              <span class="hint">把 {{ row.count }} 个规则集迁移到</span>
              <n-select
                v-model:value="catDelete.moveTo" size="small" :options="catDelete.options"
                placeholder="选择目标分类" style="width: 170px"
              />
            </template>
            <span v-else class="hint">该分类下没有规则集，可直接删除。</span>
            <n-button size="tiny" @click="catDelete.open = false">取消</n-button>
            <n-button
              size="tiny" type="error" :loading="catBusy"
              :disabled="row.count > 0 && !catDelete.moveTo" @click="confirmDeleteCategory"
            >确认删除</n-button>
          </div>
        </div>

        <div class="cat-new-row">
          <b class="cat-new-title">＋ 新建分类</b>
          <n-input v-model:value="catQuick.name" size="small" :maxlength="20" placeholder="如 广告 / 流媒体" style="width: 165px" @keyup.enter="createCatInline" />
          <div class="cat-swatches">
            <button
              v-for="c in SWATCHES" :key="'new-' + c" type="button" class="swatch sm"
              :class="{ on: catQuick.color === c }" :style="{ '--sw': c }" :title="c"
              @click="catQuick.color = c"
            />
          </div>
          <n-button size="small" type="primary" ghost :loading="catBusy" @click="createCatInline">创建分类</n-button>
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="catManageOpen = false">关闭</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="addOpen" preset="card" title="加入规则集" style="width: 560px; max-width: 94vw">
      <div v-if="addItem" class="stack">
        <div class="add-summary">
          <div class="row" style="gap: 8px">
            <b>{{ addItem.title || addItem.zh || addItem.label || addItem.name }}</b>
            <span class="tag tag-src" :class="addItem.kind === 'geoip' ? 'is-ip' : 'is-domain'">
              {{ addItem.kind === 'geoip' ? 'IP' : '域名' }}
            </span>
            <span class="hint mono">{{ addItem.id }}</span>
          </div>
          <div v-if="addItem.desc" class="hint rule-desc">{{ addItem.desc }}</div>
          <div v-if="(addItem.tags || []).length" class="row tag-row">
            <span v-for="t in addItem.tags" :key="t" class="tag tag-pill" :style="{ '--tag-color': tagTone(t) }">{{ t }}</span>
          </div>
        </div>

        <div class="add-field">
          <div class="add-field-head">
            <b>目标分类</b>
            <span class="hint">可不归类，也可以现场新建</span>
          </div>
          <div class="cat-row" style="margin-bottom: 0">
            <button
              type="button" class="cat-chip" :class="{ active: !addForm.cat }"
              style="--cat-color: var(--text-dim)" @click="addForm.cat = ''"
            >
              <span class="cat-dot" style="background: var(--text-dim)" />
              <span>不归类</span>
            </button>
            <button
              v-for="c in addCatChoices" :key="c.name" type="button" class="cat-chip"
              :class="{ active: addForm.cat === c.name }" :style="{ '--cat-color': c.color }"
              @click="addForm.cat = c.name"
            >
              <span class="cat-dot" :style="{ background: c.color }" />
              <span>{{ c.name }}</span><span class="cat-num">{{ c.count }}</span>
            </button>
            <button type="button" class="cat-chip cat-chip-add" @click="addNewCatOpen = !addNewCatOpen">＋ 新建分类</button>
          </div>
          <div v-if="addNewCatOpen" class="cat-new-row" style="margin-top: 8px">
            <n-input v-model:value="addNewCat.name" size="small" :maxlength="20" placeholder="新分类名称" style="width: 150px" @keyup.enter="createAddCategory" />
            <div class="cat-swatches">
              <button
                v-for="c in SWATCHES" :key="'addcat-' + c" type="button" class="swatch sm"
                :class="{ on: addNewCat.color === c }" :style="{ '--sw': c }" :title="c"
                @click="addNewCat.color = c"
              />
            </div>
            <n-button size="small" type="primary" ghost :loading="addBusy" @click="createAddCategory">创建并使用</n-button>
          </div>
        </div>

        <div class="add-field">
          <div class="add-field-head">
            <b>目标策略组</b>
            <span class="hint">加入后默认放入这个策略组</span>
          </div>
          <n-select v-model:value="addForm.group" :options="groupPickOptions" filterable placeholder="选择目标策略组" />
        </div>

        <div class="add-target">
          <span>将加入</span>
          <span class="tag tag-cat" :style="{ '--tag-color': addForm.cat ? catColor(addForm.cat) : 'var(--text-dim)' }">{{ addForm.cat || '未分类' }}</span>
          <span class="hint">/</span>
          <span class="tag tag-muted">{{ addForm.group }}</span>
          <span class="spacer" />
          <span class="hint">分类与策略组只影响本地规则集库</span>
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="addOpen = false">取消</n-button>
          <n-button quaternary :loading="addBusy" @click="addWithDefaults()">默认加入</n-button>
          <n-button type="primary" :loading="addBusy" :disabled="!addItem" @click="confirmAdd">加入</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="iconEditOpen" preset="card" title="编辑图标" style="width: 460px; max-width: 94vw">
      <div class="stack">
        <div class="icon-edit-head">
          <span class="icon-face icon-face-lg">
            <img v-if="iconEditTarget && String(iconEditTarget.value).startsWith('data:')" :src="iconEditTarget.value" :alt="iconEdit.name" />
            <template v-else>{{ iconEditTarget ? iconEditTarget.value : '◌' }}</template>
          </span>
          <div class="stack" style="gap: 2px">
            <b>{{ iconEdit.name || '未命名图标' }}</b>
            <span class="hint mono">{{ iconEdit.id }}</span>
          </div>
        </div>
        <n-input v-model:value="iconEdit.name" :maxlength="24" show-count placeholder="图标名称" />
        <div>
          <div class="add-field-head" style="margin-bottom: 6px">
            <b>所属分类</b>
            <span class="hint">可输入新分类名</span>
          </div>
          <n-select v-model:value="iconEdit.category" :options="iconCatOptions" filterable tag placeholder="选择或输入分类" />
        </div>
        <div class="hint">自定义图标的名称与分类会写回后端；内置图标只读，无法编辑。</div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="iconEditOpen = false">取消</n-button>
          <n-button type="primary" :loading="iconEditBusy" @click="saveIconEdit">保存</n-button>
        </div>
      </template>
    </n-modal>

    <IconCatManager v-model:show="iconManageOpen" :icons="state.icons || []" />

    <n-modal
      v-model:show="editorOpen" preset="card"
      :title="editor.kind === 'ruleset' ? '规则集' : editor.kind === 'base' ? '基础配置' : 'DNS 配置'"
      :style="editor.kind === 'ruleset' ? 'width: 720px; max-width: 94vw' : 'width: 1000px; max-width: 96vw'"
    >
      <div class="stack">
        <div class="grid-2">
          <n-input v-model:value="editor.id" placeholder="id（小写字母/数字/短横线）" :disabled="editor.kind !== 'ruleset' && !editorIsNew" />
          <n-input v-model:value="editor.name" placeholder="名称" />
        </div>
        <template v-if="editor.kind === 'ruleset'">
          <div v-if="editorTarget && editorTarget.builtin" class="hint">
            内置规则集：名称 / 分类 / 标签 / 说明可改，会叠加在本机覆盖（localStorage）之上并立即生效；服务端 seed 重启后仍以本机覆盖为准。内置项不可删除。
          </div>
          <div class="grid-2">
            <n-input v-model:value="editor.group" placeholder="默认分组，如 🚀 节点选择" />
            <n-select v-model:value="editor.behavior" :options="['domain','ipcidr','classical'].map((v) => ({ label: v, value: v }))" />
          </div>
          <n-input v-model:value="editor.repo" placeholder="来源仓库（MetaCubeX / blackmatrix7 / 自建）" />
          <div class="grid-2">
            <n-select v-model:value="editor.cat" :options="catOptions" filterable tag clearable placeholder="分类（可输入新分类）" />
            <n-input v-model:value="editor.tags" placeholder="标签，用逗号分隔，如 广告,拦截,常用" />
          </div>
          <n-input v-model:value="editor.url" placeholder="远程规则集地址（Clash .list/.yaml/.mrs/.srs，可留空）" />
          <div class="row tag-row editor-fmt-row">
            <span class="hint">识别格式</span>
            <span class="tag tag-fmt" :class="`fmt-${editorDetectedFormat}`">{{ editorDetectedFormat }}</span>
            <span class="hint">{{ editorRemote ? '按地址后缀自动识别' : '留空地址即仅使用内联规则' }}</span>
            <span class="spacer" />
            <n-tooltip trigger="hover" placement="top" :show-arrow="false">
              <template #trigger>
                <n-button
                  size="tiny" quaternary circle
                  :loading="editorCheck.busy" :disabled="!editorRemote || editorIsNew"
                  @click="checkEditorRuleset"
                ><UiIcon name="refresh" :size="13" /></n-button>
              </template>
              <span>{{ editorIsNew ? '先保存，再检查远端' : editorRemote ? '检查远端更新（只比对 hash，不写入规则内容）' : '内联规则没有远端地址，无法检查' }}</span>
            </n-tooltip>
            <span class="hint mono check-time">
              上次 {{ editorCheckMeta.at || '尚未检查' }} · {{ editorCheckMeta.hash || '—' }}
            </span>
          </div>

          <!-- 更新方式：replace / append 走后端字段，check-only 与自定义间隔是前端语义 -->
          <div class="editor-plan">
            <div class="row">
              <span class="hint">更新方式</span>
              <n-select
                :value="editorPlan" size="small" style="width: 236px"
                :options="PLAN_OPTIONS" :disabled="!editorRemote"
                @update:value="setUpdatePlan"
              />
              <span v-if="!editorRemote" class="hint">内联规则不参与自动更新</span>
              <span v-else-if="editorTarget && editorTarget.builtin" class="tag tag-soft is-builtin">内置项</span>
            </div>
            <span class="hint">{{ editorPlanHint }}</span>
            <div class="grid-2">
              <n-input-number
                v-model:value="editor.intervalHours" :min="1" :max="720" :step="1" size="small"
                :disabled="!editorRemote || (!editorPlanLocked && !editor.autoUpdate)"
              >
                <template #suffix>小时</template>
              </n-input-number>
              <div class="row">
                <n-switch v-model:value="editor.autoUpdate" size="small" :disabled="!editorRemote || editorPlanLocked" />
                <span class="hint">自动更新{{ editorRemote ? '' : '（需远程地址）' }}</span>
              </div>
            </div>
            <n-input
              v-if="editorPlan === 'custom'" v-model:value="editor.pullTemplate" type="textarea" :rows="2"
              placeholder="自定义拉取模板说明（可选）：如 cron 周期、上游分支、拉取后如何合并"
            />
            <span v-if="editorPlan === 'check-only'" class="hint">
              check-only：仍写 autoUpdate 让后端定时检查，但只记录 hash / 时间，不写入规则内容；后端无该枚举，标记存在本机覆盖里。
            </span>
            <span v-else-if="editorPlan === 'custom'" class="hint">
              自定义间隔超过 168 小时时，后端会裁到 168，完整值以本机覆盖为准；拉取模板仅作说明，不影响后端行为。
            </span>
          </div>
          <div v-if="editorCheck.text" class="row tag-row">
            <span class="tag" :class="editorCheck.kind === 'ok' ? 'tag-ok' : editorCheck.kind === 'warn' ? 'tag-warn' : 'tag-bad'">{{ editorCheck.text }}</span>
          </div>
          <n-input v-model:value="editor.inline" type="textarea" :rows="5" placeholder="内联规则，每行一条：DOMAIN-SUFFIX,example.com" />
          <div class="row" style="gap: 8px; align-items: center">
            <label class="file-btn">
              上传本地规则文件
              <input type="file" accept=".yaml,.yml,.list,.txt,.conf" hidden @change="onRulesetFile" />
            </label>
            <span class="hint">支持 .yaml / .list / .txt / .conf 文本格式；.mrs / .srs 二进制请用远程地址。</span>
          </div>
          <n-input v-model:value="editor.desc" placeholder="说明（可选；留空时自动用目录说明）" />
        </template>
        <template v-else>
          <div class="grid-2">
            <n-input v-model:value="editor.format" placeholder="格式，如 mihomo / any" />
            <n-input v-model:value="editor.desc" placeholder="说明（可选）" />
          </div>
          <div class="row editor-toolbar">
            <span v-if="editorCanVisual" class="tpl-mode-switch editor-mode-switch">
              <button
                type="button" :class="{ active: editorVisualMode }"
                @click="editorMode = 'visual'"
              >可视化</button>
              <button
                type="button" :class="{ active: editorCanVisual && editorMode === 'raw' }"
                @click="editorMode = 'raw'"
              >原始 YAML</button>
            </span>
            <span class="tag tag-muted">{{ editorLanguage === 'json' ? 'JSON' : 'YAML' }}</span>
            <span class="hint">{{ editorLines }} 行 · {{ editorChars }} 字符</span>
            <span class="spacer" />
            <span class="hint">对比原始内容</span>
            <n-switch v-model:value="editorDiff" size="small" />
          </div>
          <div class="editor-split">
            <div class="editor-pane">
              <template v-if="!editorVisualMode">
                <div class="editor-pane-head">
                  <b>编辑内容</b>
                  <span class="hint">行号 + 高亮，可直接编辑</span>
                  <span class="spacer" />
                  <n-button size="tiny" quaternary @click="copyEditor">复制</n-button>
                </div>
                <CodeEditor
                  v-model="editor.inline" :language="editorLanguage" height="420px"
                  placeholder="YAML / JSON 配置内容"
                />
              </template>
              <BaseDnsForm
                v-else v-model="editor.inline" :kind="editor.kind"
                :original="editorOriginal" height="420px"
              />
            </div>
            <div class="editor-pane">
              <div class="editor-pane-head">
                <b>{{ editorDiff ? '对比（原始 → 编辑）' : '预览' }}</b>
                <span class="hint">{{ editorDiff ? '新增绿色 · 删除红色 · 未变灰色' : '另一套配色 · 只读' }}</span>
              </div>
              <DiffView v-if="editorDiff" :before="editorOriginal" :after="editor.inline" height="420px" />
              <CodeEditor
                v-else :model-value="editor.inline" :language="editorLanguage" palette="alt"
                readonly height="420px"
              />
            </div>
          </div>
          <span v-if="editorVisualMode" class="hint">可视化模式只写回改动过的字段：未改字段、注释、其它段落（tun / rules / hosts / proxy-groups 等）按原文保留。切到「原始 YAML」可编辑全部内容。「对比」显示保存前内容与当前编辑内容的行级差异。</span>
          <span v-else class="hint">基础配置会合并进输出（不要包含 dns / proxies / rules）；DNS 配置对应 mihomo 的 dns 段。「对比」显示保存前内容与当前编辑内容的行级差异。</span>
        </template>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <span class="row" style="margin-right: auto">
            <n-button v-if="editorTarget && editorTarget.metaOverride" ghost size="small" @click="resetEditorOverride">
              恢复默认
            </n-button>
            <n-button
              v-if="editorTarget && !editorTarget.builtin" type="error" ghost size="small"
              @click="removeEditorItem"
            >删除</n-button>
          </span>
          <n-button @click="editorOpen = false">取消</n-button>
          <n-button type="primary" @click="saveEditor">保存</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="repoOpen" preset="card" :title="repoForm.id ? '编辑来源仓库' : '添加来源仓库'" style="width: 680px; max-width: 94vw">
      <div class="stack">
        <div class="grid-2">
          <n-input v-model:value="repoForm.name" placeholder="仓库名称，如 blackmatrix7" />
          <n-input v-model:value="repoForm.home" placeholder="仓库主页 https://github.com/…（可选）" />
        </div>
        <n-input v-model:value="repoForm.clash" placeholder="Clash 规则集前缀，如 .../rule/Clash" />
        <n-input v-model:value="repoForm.mihomo" placeholder="mihomo (.mrs) 前缀（可选）" />
        <n-input v-model:value="repoForm.singbox" placeholder="sing-box (.srs) 前缀（可选）" />
        <n-input v-model:value="repoForm.note" placeholder="说明：规则命名规律、目录结构等（可选）" />
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end"><n-button @click="repoOpen = false">取消</n-button><n-button type="primary" @click="saveRepo">保存</n-button></div>
      </template>
    </n-modal>

    <n-modal v-model:show="newTplOpen" preset="card" title="新建模板" style="width: 520px; max-width: 94vw">
      <div class="stack">
        <n-input v-model:value="newTpl.name" placeholder="模板名，如 my-mihomo（小写字母/数字/-/_/.)" />
        <n-select v-model:value="newTpl.from" :options="state.templates.map((t) => ({ label: `复制自：${t.title || t.name}`, value: t.name }))" placeholder="从哪个模板复制（默认第一个）" />
        <div class="hint">新建后可在转换模板里点「编辑」调整策略组与规则。</div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end"><n-button @click="newTplOpen = false">取消</n-button><n-button type="primary" @click="createTemplate">创建</n-button></div>
      </template>
    </n-modal>

    <n-modal
      v-model:show="tplOpen" preset="card" :title="`编辑模板：${tpl.title || tpl.name}`"
      style="width: 1180px; max-width: 98vw"
    >
      <n-spin :show="tpl.loading">
        <div class="tpl-body">
          <div class="tpl-main">
            <div class="row tpl-toolbar">
              <div class="tpl-mode-switch">
                <button
                  type="button" :class="{ active: tpl.mode === 'visual' }" :disabled="tpl.loading"
                  @click="switchTplMode('visual')"
                >可视化</button>
                <button
                  type="button" :class="{ active: tpl.mode === 'raw' }" :disabled="tpl.loading"
                  @click="switchTplMode('raw')"
                >原始 INI</button>
              </div>
              <span class="hint mono">{{ tpl.name }}</span>
              <span class="spacer" />
              <n-button size="small" quaternary :loading="tpl.validating" :disabled="tpl.loading" @click="validateTemplate">校验</n-button>
              <n-button size="small" quaternary :disabled="tpl.loading" @click="openTplSaveAs">另存为</n-button>
              <n-button size="small" type="primary" :loading="tpl.saving" :disabled="tpl.loading" @click="saveTemplate">保存</n-button>
            </div>

            <div v-if="tpl.mode === 'raw'" class="tpl-raw">
              <CodeEditor
                ref="tplEditor" :model-value="tpl.content" language="ini" :marks="tplMarks"
                height="min(60vh, 600px)" placeholder="; SubHub 订阅模板&#10;[custom]&#10;custom_proxy_group=…"
                @update:model-value="onTplContent" @save="saveTemplate"
              />
              <div class="hint">行号栏的红/黄标记来自校验结果，点击标记或右侧提示可跳转；Ctrl/⌘+S 直接保存。</div>
            </div>

            <div v-else-if="tpl.model" class="tpl-visual">
              <div class="tpl-section">
                <div class="tpl-section-head"><b>模板信息</b><span class="hint">写入 INI 头部的 ; @title 等注释</span></div>
                <div class="grid-2">
                  <n-input v-model:value="tpl.model.meta.title" placeholder="模板标题" />
                  <n-input v-model:value="tpl.model.meta.targets" placeholder="目标客户端，逗号分隔：clash, mihomo, sing-box" />
                </div>
                <n-input v-model:value="tpl.model.meta.description" placeholder="模板说明" />
                <div class="grid-2">
                  <n-input v-model:value="tpl.model.meta.author" placeholder="作者（可选）" />
                  <n-input v-model:value="tpl.model.meta.version" placeholder="版本（可选）" />
                </div>
              </div>

              <div class="tpl-section">
                <div class="tpl-section-head">
                  <b>策略组</b><span class="hint">{{ tpl.model.groups.length }} 个</span>
                  <span class="spacer" />
                  <n-button size="tiny" quaternary @click="addTplGroup">＋ 增加策略组</n-button>
                </div>
                <div v-if="!tpl.model.groups.length" class="hint">还没有策略组，至少添加一个才能生成 INI。</div>
                <div v-for="(g, gi) in tpl.model.groups" :key="gi" class="tpl-row">
                  <div class="grid-2">
                    <n-input v-model:value="g.name" size="small" placeholder="策略组名称，如 🚀 节点选择" />
                    <div class="row">
                      <n-select v-model:value="g.type" size="small" :options="TPL_GROUP_TYPE_OPTIONS" style="flex: 1" />
                      <n-button size="tiny" quaternary type="error" @click="removeTplGroup(gi)">删除</n-button>
                    </div>
                  </div>
                  <n-input
                    v-if="g.type === 'select' || g.type === 'relay'" v-model:value="g.refs" size="small"
                    :placeholder="g.type === 'relay' ? 'relay 成员，逗号分隔（至少 2 个，不能含 DIRECT/REJECT）' : '引用/成员，逗号分隔，如 ♻️ 自动选择, DIRECT'"
                  />
                  <template v-else>
                    <n-input v-model:value="g.patterns" size="small" placeholder="节点过滤正则，逗号分隔，默认 .*" />
                    <div class="tpl-grid-3">
                      <n-input v-model:value="g.url" size="small" placeholder="测速地址 http(s)://…" />
                      <n-input-number v-model:value="g.interval" size="small" :min="1" placeholder="间隔秒" />
                      <n-input-number v-model:value="g.tolerance" size="small" :min="0" placeholder="容差 ms" />
                    </div>
                  </template>
                </div>
              </div>

              <div class="tpl-section">
                <div class="tpl-section-head">
                  <b>规则</b><span class="hint">{{ tpl.model.rules.length }} 条</span>
                  <span class="spacer" />
                  <n-button size="tiny" quaternary @click="addTplRule">＋ 增加规则</n-button>
                </div>
                <div v-if="!tpl.model.rules.length" class="hint">还没有规则；规则行会写入 INI 的 [custom] 之后。</div>
                <div v-for="(r, ri) in tpl.model.rules" :key="ri" class="tpl-rule-row">
                  <n-select v-model:value="r.target" size="small" :options="tplRuleTargets" filterable tag placeholder="目标组" />
                  <n-select v-model:value="r.type" size="small" :options="TPL_RULE_TYPE_OPTIONS" filterable tag placeholder="类型" />
                  <n-select v-model:value="r.kind" size="small" :options="[{ label: 'URL', value: 'url' }, { label: '内联', value: 'inline' }]" />
                  <n-input v-model:value="r.value" size="small" :placeholder="r.kind === 'url' ? '规则集地址' : '匹配内容，如 example.com'" />
                  <n-input v-model:value="r.options" size="small" placeholder="选项" />
                  <n-button size="tiny" quaternary type="error" @click="removeTplRule(ri)">✕</n-button>
                </div>
              </div>
            </div>
          </div>

          <aside class="tpl-side">
            <div class="row">
              <b>校验结果</b>
              <span class="spacer" />
              <span class="tpl-status" :class="tplCheck.ok ? 'ok' : 'bad'">{{ tplCheck.text || '尚未校验' }}</span>
            </div>
            <div class="tpl-issues">
              <div v-if="!tplIssueList.length" class="hint">
                点「校验」会调用 parse 取 warnings，再 build 验证模型可生成 INI；有行号的提示会标在左侧行号栏。
              </div>
              <button
                v-for="(w, wi) in tplIssueList" :key="wi" type="button" class="tpl-issue" :class="w.kind"
                @click="jumpTplLine(w.text)"
              >
                <span class="tpl-issue-kind">{{ w.kind === 'warn' ? '警告' : '错误' }}</span>
                <span class="tpl-issue-text">{{ w.text }}</span>
              </button>
            </div>
            <div class="hint tpl-side-foot">
              {{ tpl.mode === 'raw'
                ? '原始 INI 模式：左侧直接编辑；切到可视化前会 parse 成模型。'
                : '可视化模式：保存或切回原始 INI 时，会用 build 生成 INI。' }}
            </div>
          </aside>
        </div>
      </n-spin>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="tplOpen = false">关闭</n-button>
          <n-button type="primary" :loading="tpl.saving" :disabled="tpl.loading" @click="saveTemplate">保存</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="tplSaveAsOpen" preset="card" title="另存为新模板" style="width: 480px; max-width: 94vw">
      <div class="stack">
        <n-input v-model:value="tplSaveAsName" placeholder="新模板名，如 my-mihomo-copy" />
        <div class="hint">
          复制当前{{ tpl.mode === 'raw' ? '原始 INI' : '可视化模型' }}；模板名只能用小写字母、数字、点、下划线与短横线。
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="tplSaveAsOpen = false">取消</n-button>
          <n-button type="primary" :loading="tplSaveAsBusy" @click="saveTemplateAs">另存为</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="settingsOpen" preset="card" title="规则集更新设置" style="width: 620px; max-width: 94vw">
      <div class="settings-form">
        <div class="set-row">
          <div><b>自动检查更新</b><p class="hint">关闭后不会再按计划检查任何规则集，仍可手动点刷新。</p></div>
          <n-switch v-model:value="settingsForm.autoUpdate" />
        </div>
        <div class="set-row">
          <div><b>生效方式</b><p class="hint">「统一更新」忽略单项设置；「单项优先」以每个规则集自己的开关与间隔为准。</p></div>
          <n-select v-model:value="settingsForm.mode" style="width: 150px" :options="[{label:'单项优先',value:'item'},{label:'统一更新',value:'global'}]" />
        </div>
        <div class="set-row">
          <div><b>应用范围</b><p class="hint">只对匹配范围内的网络规则集生效，内联规则没有远端地址会跳过。</p></div>
          <n-select v-model:value="settingsForm.scope" style="width: 150px" :options="[{label:'全部规则集',value:'all'},{label:'仅内置/官方',value:'builtin'},{label:'仅自定义',value:'custom'}]" />
        </div>
        <div class="set-row">
          <div><b>默认更新方式</b><p class="hint">统一更新时使用；check 只比对远端 hash，不写入规则内容。</p></div>
          <n-select v-model:value="settingsForm.defaultMode" style="width: 150px" :options="[{label:'整文件替换 replace',value:'replace'},{label:'增量 append',value:'append'},{label:'仅检查 check',value:'check'}]" />
        </div>
        <div class="set-row">
          <div><b>默认检查间隔</b><p class="hint">单位小时，1–720；单项优先时仍以各规则集自己的间隔为准。</p></div>
          <n-input-number v-model:value="settingsForm.intervalHours" :min="1" :max="720" style="width: 150px" />
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button size="small" @click="settingsOpen = false">取消</n-button>
          <n-button size="small" type="primary" :loading="settingsBusy" @click="saveSettings">保存设置</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="formatHelpOpen" preset="card" title="规则集格式说明" style="width: 720px; max-width: 94vw">
      <div class="stack">
        <div class="hint">
          SubHub 对网络规则集的更新检测统一按“整文件哈希比对”处理：mrs / srs 是编译后的二进制规则集，只能整文件替换；
          文本 yaml / list 虽然可读、可增量编辑，客户端加载时仍是整文件读取，因此默认同样使用 replace 检测。
        </div>
        <div class="fmt-help-list">
          <div v-for="row in formatHelpRows" :key="row.fmt" class="fmt-help-row">
            <span class="tag tag-fmt" :class="`fmt-${row.fmt}`">{{ row.fmt }}</span>
            <div class="stack" style="gap: 2px">
              <b>{{ row.name }}</b>
              <span class="hint">{{ row.desc }}</span>
            </div>
          </div>
        </div>
        <div class="hint">手动添加支持 mrs / srs / yaml / text / inline；填写远程地址时按后缀自动识别格式，留空则保存为 inline 内联规则。</div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end"><n-button @click="formatHelpOpen = false">知道了</n-button></div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
/* ── 分类行：平铺 chip（替代下拉框），颜色由 --cat-color 驱动 ── */
.cat-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.cat-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel-strong);
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: color .12s, border-color .12s, background .12s, box-shadow .12s;
}
.cat-chip:hover {
  color: var(--text);
  border-color: color-mix(in srgb, var(--cat-color, var(--accent)) 65%, var(--line));
  background: color-mix(in srgb, var(--cat-color, var(--accent)) 8%, var(--panel-strong));
}
.cat-chip.active {
  color: var(--text);
  font-weight: 550;
  border-color: var(--cat-color, var(--accent));
  background: color-mix(in srgb, var(--cat-color, var(--accent)) 15%, var(--panel-strong));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--cat-color, var(--accent)) 35%, transparent),
    0 2px 8px color-mix(in srgb, var(--cat-color, var(--accent)) 14%, transparent);
}
.cat-chip.active .cat-dot {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cat-color, var(--accent)) 20%, transparent);
}
.cat-chip-add {
  border-style: dashed;
  border-color: var(--line-strong);
  color: var(--text-dim);
}
.cat-row .spacer { flex: 1 1 auto; }
.cat-actions { display: flex; gap: 4px; flex: none; white-space: nowrap; }
.cat-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--text-dim);
}
.cat-num {
  font-size: 10.5px;
  opacity: .68;
  font-variant-numeric: tabular-nums;
}
.spacer { margin-left: auto; }

/* ── 规则集卡片：分类 tag 左色条；仓库 tag 带 hash 色圆点；普通 tags 中性可读 ── */
.lib-card {
  border-radius: 13px;
  padding: 12px 13px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .10);
  transition: border-color .15s, box-shadow .15s;
}
.lib-card:hover {
  border-color: color-mix(in srgb, var(--accent) 32%, var(--line));
  box-shadow: 0 5px 16px rgba(0, 0, 0, .12);
}
/* 目录说明可能很长：卡片内最多两行，细节交给悬浮提示 */
.lib-card .rule-desc {
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.5;
}
.tag.tag-cat {
  color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 78%, var(--text));
  border-color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 30%, transparent);
  border-left: 3px solid var(--tag-color, var(--text-dim));
  background: color-mix(in srgb, var(--tag-color, var(--text-dim)) 12%, transparent);
  padding-left: 6px;
  font-weight: 550;
}
.tag.tag-repo {
  color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 76%, var(--text));
  border-color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 28%, transparent);
  background: color-mix(in srgb, var(--tag-color, var(--text-dim)) 9%, transparent);
}
.tag.tag-repo::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--tag-color, var(--text-dim));
}
.tag.tag-muted {
  color: color-mix(in srgb, var(--text) 82%, var(--text-dim));
  border-color: var(--line);
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
html[data-theme='light'] .tag.tag-cat {
  color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 72%, #0f172a);
  background: color-mix(in srgb, var(--tag-color, var(--text-dim)) 14%, #fff);
}
html[data-theme='light'] .tag.tag-repo {
  color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 70%, #0f172a);
  background: color-mix(in srgb, var(--tag-color, var(--text-dim)) 11%, #fff);
}
html[data-theme='light'] .tag.tag-muted {
  color: #334155;
  background: rgba(15, 23, 42, .045);
  border-color: rgba(15, 23, 42, .12);
}
html[data-theme='light'] .lib-card {
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
}

/* ── 标签多色：胶囊（--tag-color 驱动）——「广告/拦截/去广告/常用」不再是灰块 ── */
.tag.tag-pill {
  height: 21px;
  padding: 0 9px;
  border-radius: 999px;
  color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 74%, var(--text));
  border-color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 34%, transparent);
  background: color-mix(in srgb, var(--tag-color, var(--text-dim)) 14%, transparent);
  font-weight: 550;
  letter-spacing: .1px;
}
.tag.tag-pill::before {
  content: '';
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  margin-right: -2px;
  border-radius: 50%;
  background: var(--tag-color, var(--text-dim));
  opacity: .85;
}
.tag.tag-pill .tag-link { color: inherit; }
html[data-theme='light'] .tag.tag-pill {
  color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 66%, #0f172a);
  background: color-mix(in srgb, var(--tag-color, var(--text-dim)) 16%, #fff);
}

/* 来源 / 更新方式 / hash / 检查状态共用一套着色：类别色 → 边框 + 淡底 */
.tag.tag-src,
.tag.tag-plan,
.tag.tag-hash,
.tag.check-state {
  color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 76%, var(--text));
  border-color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 30%, transparent);
  background: color-mix(in srgb, var(--tag-color, var(--text-dim)) 10%, transparent);
}
.tag.tag-src.is-domain { --tag-color: #38bdf8; }
.tag.tag-src.is-ip { --tag-color: #a78bfa; }
.tag.tag-src.is-local { --tag-color: #fbbf24; }
.tag.tag-plan { border-style: dashed; }
.tag.tag-plan.is-replace { --tag-color: #60a5fa; }
.tag.tag-plan.is-append { --tag-color: #34d399; }
.tag.tag-plan.is-checkonly { --tag-color: #f59e0b; }
.tag.tag-plan.is-custom { --tag-color: #c084fc; }
.tag.tag-hash {
  --tag-color: #94a3b8;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  letter-spacing: .2px;
}
.tag.check-state.tag-ok { --tag-color: #4ade80; }
.tag.check-state.tag-warn { --tag-color: #fbbf24; }
.tag.check-state.tag-bad { --tag-color: #f87171; }
.tag.tag-idle { --tag-color: #94a3b8; }
.tag.tag-soft {
  color: color-mix(in srgb, var(--text) 66%, var(--text-dim));
  border-color: var(--line-soft);
  background: transparent;
}
.tag.tag-soft.is-builtin { --tag-color: #38bdf8; color: color-mix(in srgb, #38bdf8 55%, var(--text)); }
html[data-theme='light'] .tag.tag-src,
html[data-theme='light'] .tag.tag-plan,
html[data-theme='light'] .tag.tag-hash,
html[data-theme='light'] .tag.check-state {
  color: color-mix(in srgb, var(--tag-color, var(--text-dim)) 64%, #0f172a);
  background: color-mix(in srgb, var(--tag-color, var(--text-dim)) 14%, #fff);
}
html[data-theme='light'] .tag.tag-soft { color: #475569; background: transparent; }

/* 悬停提示的触发体：标题与标签都给出 help 光标 + 虚线下划线 */
.tip-target {
  cursor: help;
  padding-bottom: .5px;
  border-bottom: 1px dashed color-mix(in srgb, var(--text-dim) 55%, transparent);
}
.tip-target:hover {
  color: var(--accent);
  border-bottom-color: color-mix(in srgb, var(--accent) 70%, transparent);
}
.tag.tag-pill:hover { filter: brightness(1.12); }

/* 检查状态行：状态标签 + MM/DD HH:mm + 短 hash + 图标按钮 */
.check-line { align-items: center; gap: 6px; }
.check-line .check-time { font-size: 10.5px; font-variant-numeric: tabular-nums; }
.check-link { display: inline-flex; align-items: center; }
.check-btn { --n-text-color: var(--text-dim); }

/* 编辑器「更新方式」分组 */
.editor-plan {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 11px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--panel-strong);
}
.editor-plan .hint { font-size: 11.5px; line-height: 1.5; }
html[data-theme='light'] .editor-plan { background: rgba(15, 23, 42, .022); }

/* ── 分类管理：行、色板、内联新增 ── */
.cat-manage-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--panel-strong);
}
.cat-swatches { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
.cat-manage-row.is-system .cat-swatches { opacity: .45; pointer-events: none; }
.cat-row-actions { display: flex; align-items: center; gap: 2px; }
.native-color-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  overflow: hidden;
  cursor: pointer;
}
.native-color {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
}
.native-color::-webkit-color-swatch-wrapper { padding: 2px; }
.native-color::-webkit-color-swatch { border: none; border-radius: 4px; }
.native-color::-moz-color-swatch { border: none; border-radius: 4px; }
.swatch {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--sw, var(--text-dim));
  cursor: pointer;
  transition: transform .12s, border-color .12s;
}
.swatch.sm { width: 16px; height: 16px; border-radius: 5px; }
.swatch:hover { transform: translateY(-1px); }
.swatch.on {
  border-color: var(--text);
  outline: 2px solid var(--accent-soft);
  outline-offset: 1px;
}
.cat-new-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 9px 10px;
  border: 1px dashed var(--line-strong);
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 4%, var(--panel));
}
.cat-new-title { font-size: 12px; font-weight: 600; color: var(--text); white-space: nowrap; }

/* ── 添加规则集对话框 ── */
.add-summary {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-strong);
}
.add-summary .row { margin-bottom: 2px; }
.add-field {
  padding: 10px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--panel);
}
.add-field-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.add-field-head b { font-size: 12.5px; }

/* ── 图标库：工具栏、分组、卡片 ── */
.icon-library { gap: 12px; }
.icon-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.icon-search { flex: 1 1 220px; max-width: 280px; }
.icon-cat-row { margin-bottom: 0; }
.icon-section {
  padding: 10px 12px 12px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--panel);
}
.icon-section-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-bottom: 8px;
  margin-bottom: 9px;
  border-bottom: 1px dashed var(--line-soft);
}
.icon-section-head b { font-size: 13px; }
.icon-grid {
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}
.icon-cell {
  align-items: center;
  gap: 5px;
  padding: 10px 8px 8px;
  min-height: 108px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--panel-strong);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .08);
  transition: transform .15s, box-shadow .15s, border-color .15s, background .15s;
}
.icon-cell:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  box-shadow: 0 8px 20px rgba(0, 0, 0, .16);
  background: var(--panel);
}
html[data-theme='light'] .icon-cell {
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
}
html[data-theme='light'] .icon-cell:hover {
  box-shadow: 0 8px 20px rgba(15, 23, 42, .10);
}
.icon-face {
  width: 34px;
  height: 34px;
  font-size: 24px;
}
.icon-face img { width: 30px; height: 30px; }
.icon-name {
  max-width: 100%;
  font-size: 12px;
  font-weight: 550;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.icon-cat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  font-size: 10.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.icon-cat .cat-dot { width: 5px; height: 5px; }
.icon-actions {
  display: flex;
  justify-content: center;
  gap: 0;
  height: 18px;
  opacity: 0;
  transition: opacity .12s;
}
.icon-cell:hover .icon-actions,
.icon-cell:focus-within .icon-actions { opacity: 1; }
.icon-lock {
  display: inline-flex;
  align-items: center;
  height: 18px;
  font-size: 10px;
  color: var(--text-dim);
  opacity: .65;
}
.icon-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 38px 16px;
  border: 1px dashed var(--line-strong);
  border-radius: 14px;
  background: var(--panel);
  text-align: center;
}
.icon-empty-glyph { font-size: 34px; line-height: 1; color: var(--text-dim); opacity: .6; }
.icon-empty p { margin: 0; max-width: 460px; }
.icon-edit-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-strong);
}
.icon-face-lg { width: 52px; height: 52px; font-size: 38px; }
.icon-face-lg img { width: 46px; height: 46px; }

/* ── 高亮预览：<pre class="mini-code hl"><code v-html> ── */
.mini-code code {
  display: block;
  padding: 0;
  background: none;
  color: inherit;
  font: inherit;
  white-space: inherit;
  word-break: inherit;
}
.mini-code.hl { line-height: 1.65; }

/* ── 基础配置 / DNS：双卡视觉分层 ── */
.cfg-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.cfg-card {
  --cfg-color: var(--accent);
  position: relative;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--cfg-color) 28%, var(--line));
  border-radius: 15px;
  background: var(--panel);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--cfg-color) 7%, transparent);
}
.cfg-card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: linear-gradient(90deg, var(--cfg-color), color-mix(in srgb, var(--cfg-color) 22%, transparent));
}
.cfg-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 13px 13px 11px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--cfg-color) 10%, var(--panel)), var(--panel));
}
.cfg-title {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.cfg-title b { display: block; font-size: 13.5px; line-height: 1.5; color: var(--text); }
.cfg-title .hint { margin-top: 1px; font-size: 11px; }
.cfg-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 23px;
  height: 23px;
  margin-top: 1px;
  border: 1px solid color-mix(in srgb, var(--cfg-color) 32%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--cfg-color) 14%, transparent);
  color: var(--cfg-color);
  font: 700 12px/1 var(--mono);
}
.cfg-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px 7px 8px;
}
.cfg-item {
  border: 1px solid transparent;
  border-radius: 10px;
  transition: border-color .12s, background .12s;
}
.cfg-item:hover {
  border-color: var(--line-soft);
  background: var(--panel-strong);
}
.cfg-item-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 36px;
  padding: 6px 5px 6px 9px;
}
.cfg-item-head b { font-size: 12.5px; color: var(--text); }
.cfg-item-head .hint { font-size: 11px; }
.cfg-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 16px 12px;
  border: 1px dashed var(--line);
  border-radius: 11px;
  color: var(--text-dim);
  font-size: 12px;
}
.cfg-preview {
  padding: 0 5px 6px;
}
.cfg-preview-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 2px 0;
}
html[data-theme='light'] .cfg-card {
  background: #fff;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--cfg-color) 8%, transparent);
}

/* ── 分类管理：头、空态、行内删除确认 ── */
.cat-manage-head { align-items: center; flex-wrap: wrap; gap: 6px; }
.cat-empty {
  padding: 22px 12px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  color: var(--text-dim);
  font-size: 12.5px;
  text-align: center;
}
.cat-del-inline {
  flex: 1 1 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 9px;
  border: 1px solid color-mix(in srgb, #ef4444 34%, var(--line));
  border-radius: 9px;
  background: color-mix(in srgb, #ef4444 7%, var(--panel));
}

/* ── 加入规则集：目标预览 ── */
.add-target {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 9px 11px;
  border: 1px solid var(--accent-line, var(--line));
  border-radius: 10px;
  background: var(--accent-soft, var(--panel-strong));
  font-size: 12px;
  color: var(--text-dim);
}
.add-target b { color: var(--text); font-weight: 600; }
.add-target .cat-dot { margin-right: 1px; }

/* ── 图标库：上传区与空状态操作 ── */
.icon-upload-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 11px 13px;
  border: 1px dashed color-mix(in srgb, var(--accent) 32%, var(--line));
  border-radius: 13px;
  background: color-mix(in srgb, var(--accent) 4%, var(--panel));
}
.icon-upload-copy { display: flex; flex-direction: column; gap: 2px; min-width: 200px; }
.icon-upload-copy b { font-size: 12.5px; }
.icon-upload-copy .hint { font-size: 11px; }
.icon-upload-fields { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.icon-empty-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 4px; }

/* ── 规则集格式徽章 / 检查状态 ── */
.tag.tag-fmt {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: .02em;
  color: var(--fmt-color, var(--text-dim));
  border: 1px solid color-mix(in srgb, var(--fmt-color, var(--line-strong)) 45%, var(--line));
  background: color-mix(in srgb, var(--fmt-color, var(--text-dim)) 10%, transparent);
}
.fmt-mrs { --fmt-color: #fb923c; }
.fmt-srs { --fmt-color: #a78bfa; }
.fmt-yaml { --fmt-color: #38bdf8; }
.fmt-text { --fmt-color: #4ade80; }
.fmt-inline { --fmt-color: #94a3b8; }
.tag.tag-bad {
  color: #f87171;
  border: 1px solid color-mix(in srgb, #f87171 40%, var(--line));
  background: color-mix(in srgb, #f87171 10%, transparent);
}

/* ── 编辑器：左编辑右预览/对比 ── */
.editor-toolbar { align-items: center; gap: 8px; padding: 0 2px; }
.editor-toolbar .hint { font-size: 11px; }
.editor-mode-switch { margin-right: 2px; }
.editor-mode-switch button { font-size: 11.5px; padding: 3px 10px; }
.editor-fmt-row { align-items: center; gap: 6px; }
.editor-fmt-row .hint { font-size: 11px; }
.editor-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
  align-items: stretch;
}
.editor-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--panel);
}
.editor-pane-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--panel-strong);
}
.editor-pane-head b { font-size: 12.5px; }
.editor-pane-head .hint { font-size: 11px; }
.editor-pane :deep(.code-editor) { border: 0; border-radius: 0; }
.editor-pane :deep(.diff-view) { border: 0; border-radius: 0; }

/* ── 模板编辑器 ── */
.tpl-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 268px;
  gap: 14px;
  align-items: start;
}
.tpl-main { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.tpl-toolbar { align-items: center; gap: 8px; flex-wrap: wrap; }
.tpl-toolbar .hint { font-size: 11px; }
.tpl-mode-switch {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel-strong);
}
.tpl-mode-switch button {
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 7px;
  cursor: pointer;
}
.tpl-mode-switch button.active {
  color: var(--text);
  background: var(--accent-soft, rgba(255, 255, 255, .08));
  box-shadow: inset 0 0 0 1px var(--accent-line, var(--line));
}
.tpl-mode-switch button:disabled { opacity: .5; cursor: default; }
.tpl-raw { display: flex; flex-direction: column; gap: 6px; }
.tpl-visual { display: flex; flex-direction: column; gap: 12px; max-height: 62vh; overflow: auto; padding-right: 2px; }
.tpl-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: 11px;
  background: var(--panel);
}
.tpl-section-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.tpl-section-head b { font-size: 12.5px; }
.tpl-section-head .hint { font-size: 11px; }
.tpl-row { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px dashed var(--line-soft); border-radius: 9px; }
.tpl-grid-3 { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 6px; }
.tpl-rule-row { display: grid; grid-template-columns: 1fr 1fr 92px 1.6fr 1fr auto; gap: 6px; align-items: center; }
.tpl-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--panel);
  min-height: 100%;
}
.tpl-side > .row b { font-size: 12.5px; }
.tpl-status {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--text-dim);
}
.tpl-status.ok { color: #4ade80; border-color: rgba(74, 222, 128, .35); background: rgba(74, 222, 128, .08); }
.tpl-status.bad { color: #f87171; border-color: rgba(248, 113, 113, .35); background: rgba(248, 113, 113, .08); }
.tpl-issues { display: flex; flex-direction: column; gap: 5px; max-height: min(48vh, 470px); overflow: auto; }
.tpl-issue {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: var(--panel-strong);
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.tpl-issue:hover { border-color: var(--line); color: var(--text); }
.tpl-issue.warn { border-left: 3px solid #f5b57a; }
.tpl-issue.error { border-left: 3px solid #f87171; }
.tpl-issue-kind { font-size: 10px; opacity: .8; }
.tpl-issue-text { line-height: 1.45; word-break: break-word; }
.tpl-side-foot { margin-top: auto; font-size: 11px; }

/* ── 格式说明弹窗 ── */
.fmt-help-list { display: flex; flex-direction: column; gap: 9px; }
.fmt-help-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 9px 10px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  background: var(--panel);
}
.fmt-help-row .tag-fmt { flex: none; margin-top: 1px; }
.fmt-help-row .hint { font-size: 11.5px; line-height: 1.55; }

@media (max-width: 760px) {
  .icon-grid { grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); }
  .icon-search { max-width: none; }
  .cat-manage-row { align-items: flex-start; }
  .cat-row-actions { flex-wrap: wrap; }
}
@media (max-width: 900px) {
  .cfg-grid,
  .editor-split,
  .tpl-body { grid-template-columns: minmax(0, 1fr); }
  .tpl-rule-row { grid-template-columns: 1fr 1fr; }
  .tpl-grid-3 { grid-template-columns: minmax(0, 1fr); }
  .tpl-side { min-height: 0; }
}
@media (max-width: 760px) {
  .cfg-head { flex-direction: column; align-items: stretch; }
  .cfg-head > .row { justify-content: flex-start; }
  .icon-upload-box { flex-direction: column; align-items: stretch; }
  .icon-upload-fields { width: 100%; }
}

/* 规则集批量与更新设置 */
.bulk-bar { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px dashed var(--line); border-radius: 10px; margin: 2px 0 12px; color: var(--text-dim); }
.bulk-bar.active { border-style: solid; border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.lib-card.picked { outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
.settings-form { display: grid; gap: 12px; }
.set-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 10px 12px; border: 1px solid var(--line-soft); border-radius: 10px; }
.set-row b { font-size: 13px; }
.set-row p { margin: 3px 0 0; font-size: 11px; line-height: 1.6; }
html[data-theme='light'] .set-row { background: #fafbfc; }
.tag-behavior[data-b='domain'] { color: #2563eb; border-color: #93c5fd; background: #dbeafe; }
.tag-behavior[data-b='ipcidr'] { color: #7c3aed; border-color: #c4b5fd; background: #ede9fe; }
.tag-behavior[data-b='classical'] { color: #b45309; border-color: #fcd34d; background: #fef3c7; }
.tag-builtin { color: #047857; border-color: #6ee7b7; background: #d1fae5; }
:global(html[data-theme='dark']) .tag-behavior[data-b='domain'] { color: #93c5fd; background: #1e3a8a55; border-color: #3b82f655; }
:global(html[data-theme='dark']) .tag-behavior[data-b='ipcidr'] { color: #c4b5fd; background: #4c1d9555; border-color: #8b5cf655; }
:global(html[data-theme='dark']) .tag-behavior[data-b='classical'] { color: #fcd34d; background: #78350f55; border-color: #f59e0b55; }
:global(html[data-theme='dark']) .tag-builtin { color: #6ee7b7; background: #064e3b55; border-color: #10b98155; }
.tag.tag-time {
  --tag-color: #38bdf8;
  padding: 1px 7px; border-radius: 999px; font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--tag-color) 78%, var(--text));
  border: 1px solid color-mix(in srgb, var(--tag-color) 32%, transparent);
  background: color-mix(in srgb, var(--tag-color) 14%, transparent);
}
.tag.tag-time.is-idle { --tag-color: #94a3b8; }
html[data-theme='light'] .tag.tag-time { color: color-mix(in srgb, var(--tag-color) 70%, #0f172a); background: color-mix(in srgb, var(--tag-color) 16%, #fff); }
/* 卡片操作固定在右下角 */
.lib-card { position: relative; padding-bottom: 40px; }
.lib-actions { position: absolute; right: 12px; bottom: 10px; gap: 2px; opacity: .78; transition: opacity .15s ease; }
.lib-card:hover .lib-actions { opacity: 1; }

/* 列表视图：压缩为横向信息行 */
.lib-grid.list { display: grid; grid-template-columns: 1fr; gap: 8px; }
.lib-grid.list .lib-card {
  display: grid; grid-template-columns: minmax(0, 1fr) 84px;
  gap: 4px 16px; padding: 12px 14px; min-height: 0; align-items: start;
}
.lib-grid.list .lib-card > * { grid-column: 1; }
.lib-grid.list .lib-card > .lib-actions {
  grid-column: 2; grid-row: 1 / span 8; position: static;
  align-self: center; flex-direction: column; align-items: stretch; opacity: 1;
}
.lib-grid.list .rule-desc, .lib-grid.list .hint.rule-desc {
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
}
.lib-grid.list .lib-card > .hint { display: none; }
.lib-grid.list .lib-card .tag-row { gap: 4px; margin: 0; }

/* 快捷模式模板 / 基础 / DNS */
.quick-selects { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 8px; margin: 0 0 14px; }
@media (max-width: 900px) { .quick-selects { grid-template-columns: 1fr; } }
</style>






