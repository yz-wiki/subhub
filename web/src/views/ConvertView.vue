<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  NCard, NInput, NButton, NSelect, NSwitch, NTag, NModal, NCheckbox, NCheckboxGroup,
  NTabs, NTabPane, NSpin, NEmpty, NDivider, NAlert, NAutoComplete, NTooltip, NPopover, NDropdown, NInputNumber, NColorPicker, useMessage, useDialog,
} from 'naive-ui';
import PreviewPane from '../components/PreviewPane.vue';
import GroupRow from '../components/GroupRow.vue';
import { state, loadState, buildPayload, canConvert, makeLocalId, targetById, iconOf, can } from '../state.js';
import { api } from '../api.js';
import IconPicker from '../components/IconPicker.vue';
import rulesetMeta from '../data/rulesetMeta.json';

const message = useMessage();
const dialog = useDialog();

const c = computed(() => state.convert);
const auth = computed(() => state.auth);

const parseBusy = ref(false);
const fileInput = ref(null);
function pickFile() { if (fileInput.value) fileInput.value.click(); }
const convertBusy = ref(false);
const nodeQ = ref('');
const batch = ref({ on: false, sel: [] });

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 4) return (v / 1024 ** 4).toFixed(2) + ' TB';
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + ' GB';
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(v / 1024) + ' KB';
}
const traffic = computed(() => {
  const raw = state.preview.userinfo || '';
  if (!raw) return '';
  const get = (k) => { const m = raw.match(new RegExp(k + '=(\\d+)')); return m ? Number(m[1]) : 0; };
  const upload = get('upload'); const download = get('download'); const total = get('total'); const expire = get('expire');
  if (!total) return '';
  const left = Math.max(0, total - upload - download);
  const when = expire ? ' · ' + new Date(expire * 1000).toISOString().slice(0, 10) + ' 到期' : '';
  return `剩余 ${fmtBytes(left)} / ${fmtBytes(total)}${when}`;
});

// 功能卡片折叠状态（记住用户习惯）
const open = reactive({ import: true, template: true, nodes: true, relay: true, groups: true });
try {
  const saved = JSON.parse(localStorage.getItem('subhub.cards') || '{}');
  for (const k of Object.keys(open)) if (typeof saved[k] === 'boolean') open[k] = saved[k];
} catch { /* 忽略损坏的本地缓存 */ }
watch(open, (v) => {
  try { localStorage.setItem('subhub.cards', JSON.stringify(v)); } catch { /* 无痕模式 */ }
}, { deep: true });
function toggleCard(key) { open[key] = !open[key]; }
const importTab = ref('url');
const includeText = ref('');

/* ── 侧边栏功能区 ── */
const activePane = ref(localStorage.getItem('subhub.pane') || 'import');
watch(activePane, (v) => { try { localStorage.setItem('subhub.pane', v); } catch { /* ignore */ } });
const panes = computed(() => [
  { id: 'import', icon: '⇣', label: '节点导入', desc: '订阅 / 节点 / 配置文件', badge: sourceRows.value.filter((r) => String(r.value || '').trim()).length || '' },
  { id: 'template', icon: '▤', label: '模板选择', desc: '模板 / 基础 / DNS', badge: state.templates.length ? `${state.templates.length}` : '' },
  { id: 'nodes', icon: '☰', label: '节点管理', desc: '搜索 / 标签 / 批量', badge: c.value.nodes.length || '' },
  { id: 'relay', icon: '⇄', label: '中转代理组', desc: '前置 → 落地链式代理', badge: relayGroups.value.length || '' },
  { id: 'groups', icon: '◈', label: '策略组', desc: '分组 / 规则集 / 启停', badge: groupTotal.value || '' },
  { id: 'rules', icon: '≣', label: '规则管理', desc: '顺序 / 添加 / 持久化', badge: ruleCount.value || '' },
]);
function goPane(id) {
  if (mode.value === 'quick' && !['import', 'template'].includes(id)) mode.value = 'advanced';
  activePane.value = id;
  const body = document.querySelector('.cfg-pane-body');
  if (body) body.scrollTop = 0;
}

/* ── 导入源：多行、可持久化 ── */
const SRC_KEY = 'subhub.sources.v2';
const NODE_KEY = 'subhub.nodes.v2';
const sourceRows = ref([]);
let srcSeq = 1;
function blankSource(type = 'url') {
  return { id: `s${Date.now().toString(36)}${srcSeq++}`, type, name: '', value: '', status: '', count: 0 };
}
function restoreLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(SRC_KEY) || 'null');
    if (Array.isArray(raw) && raw.length) {
      sourceRows.value = raw.map((r) => ({ ...blankSource(r.type), ...r, status: '' }));
    }
    const nodes = JSON.parse(localStorage.getItem(NODE_KEY) || 'null');
    if (Array.isArray(nodes) && nodes.length && !c.value.nodes.length) c.value.nodes = nodes;
  } catch { /* 缓存损坏时忽略 */ }
  if (!sourceRows.value.length) sourceRows.value = [blankSource('url')];
  syncLegacy();
}
function persistLocal() {
  try {
    localStorage.setItem(SRC_KEY, JSON.stringify(sourceRows.value));
    localStorage.setItem(NODE_KEY, JSON.stringify(c.value.nodes || []));
  } catch { /* 无痕模式 */ }
}
function sourceText(row) {
  return String(row.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
function syncLegacy() {
  c.value.sources = sourceRows.value.filter((r) => r.type === 'url').flatMap(sourceText)
    .filter((u) => /^https?:\/\//i.test(String(u).trim())).join('\n');
  c.value.nodeText = sourceRows.value.filter((r) => r.type === 'links').flatMap(sourceText).join('\n');
  c.value.configText = sourceRows.value.filter((r) => r.type === 'config').map((r) => r.value).filter(Boolean).join('\n');
}
watch(sourceRows, syncLegacy, { deep: true });
watch([sourceRows, () => c.value.nodes], persistLocal, { deep: true });
function addSource(type = 'url') {
  sourceRows.value.push(blankSource(type));
}
function removeSource(row) {
  const tag = row.name || '';
  sourceRows.value = sourceRows.value.filter((r) => r.id !== row.id);
  if (!sourceRows.value.length) sourceRows.value = [blankSource('url')];
  if (tag) {
    const before = (c.value.nodes || []).length;
    c.value.nodes = (c.value.nodes || []).filter((n) => n._src !== tag);
    if (before !== c.value.nodes.length) message.info(`已同时移除来源「${tag}」的 ${before - c.value.nodes.length} 个节点`);
  }
  syncLegacy();
  persistLocal();
}
async function parseSource(row) {
  const lines = sourceText(row);
  if (!lines.length) { message.warning('请先填写内容'); return; }
  let payload;
  if (row.type === 'url') {
    const urls = lines.filter((u) => /^https?:\/\//i.test(String(u).trim()));
    if (!urls.length) { row.status = 'err'; message.warning('订阅源行只支持 http:// 或 https:// 链接，节点链接请用「节点链接」行'); return; }
    payload = { mode: 'url', sources: urls };
  } else payload = { mode: 'text', text: row.value, filename: row.name || 'config.yaml' };
  row.status = 'loading';
  try {
    const data = await api('/api/nodes/preview', { method: 'POST', body: payload });
    row.count = data.count || 0;
    row.status = 'ok';
    const tag = row.name || (row.type === 'url' ? '订阅' : row.type === 'config' ? '配置' : '节点') + (sourceRows.value.indexOf(row) + 1);
    row.name = tag;
    const incoming = (data.nodes || []).map((n) => ({ ...n, _src: tag }));
    const others = (c.value.nodes || []).filter((n) => n._src !== tag);
    const seen = new Set();
    c.value.nodes = [...others, ...incoming].filter((n) => {
      const k = `${n.type}|${n.server}|${n.port}|${n.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (data.count) message.success(`「${tag}」解析到 ${data.count} 个节点`);
    else message.warning(`「${tag}」没有解析到节点`);
    schedulePreview(300);
  } catch (e) {
    row.status = 'err';
    message.error(e.message || '解析失败');
  }
}
async function parseAllSources() {
  for (const row of sourceRows.value) if (sourceText(row).length) await parseSource(row);
}


const mode = ref(localStorage.getItem('subhub.mode') || 'advanced');
watch(mode, (v) => {
  try { localStorage.setItem('subhub.mode', v); } catch { /* 无痕模式 */ }
  if (v === 'quick') activePane.value = 'import';
});
const strategyOpen = ref(false);
function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (!canConvert()) return;
    e.preventDefault();
    convert(false);
  }
}

const groupQ = ref('');
const filteredGroups = computed(() => {
  const model = c.value.draft && c.value.draft.model;
  if (!model) return [];
  const q = groupQ.value.trim().toLowerCase();
  const list = model.groups || [];
  return q ? list.filter((g) => String(g.name).toLowerCase().includes(q)) : list;
});
const protoFilter = ref('');
const srcFilter = ref('');
const srcOptions = computed(() => {
  const set = [...new Set((c.value.nodes || []).map((n) => n._src).filter(Boolean))];
  return set.map((s) => ({ label: s, value: s }));
});
const filteredNodes = computed(() => {
  const q = nodeQ.value.trim().toLowerCase();
  let rows = c.value.nodes.map((n, i) => ({ n, i }));
  if (protoFilter.value) rows = rows.filter(({ n }) => String(n.type || 'other').toLowerCase() === protoFilter.value);
  if (srcFilter.value) rows = rows.filter(({ n }) => (n._src || '') === srcFilter.value);
  if (q) rows = rows.filter(({ n }) => `${n.name} ${n.server} ${n.type}`.toLowerCase().includes(q));
  return rows;
});
const SRC_TYPES = [
  { label: '订阅源', value: 'url' },
  { label: '节点链接', value: 'links' },
  { label: '配置文件', value: 'config' },
];
const parseAllBusy = ref(false);
async function parseAllRows() {
  if (!sourceRows.value.some((r) => String(r.value || '').trim())) { message.warning('请先填写导入内容'); return; }
  parseAllBusy.value = true;
  try { await parseAllSources(); } finally { parseAllBusy.value = false; }
}
const fileRowId = ref('');
function importFile() {
  const row = blankSource('config');
  sourceRows.value.push(row);
  fileRowId.value = row.id;
  if (fileInput.value) fileInput.value.click();
}
async function onSourceFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { message.warning('文件超过 8MB，请拆分后再导入'); return; }
  const row = sourceRows.value.find((r) => r.id === fileRowId.value);
  if (!row) return;
  row.value = await file.text();
  row.type = 'config';
  row.name = file.name;
  message.success(`已读取 ${file.name}（${(file.size / 1024).toFixed(1)} KB）`);
  await parseSource(row);
}
const protoStats = computed(() => {
  const m = new Map();
  for (const n of c.value.nodes) {
    const t = String(n.type || 'other').toLowerCase();
    m.set(t, (m.get(t) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
});

const protoColors = { vmess: 'blue', vless: 'cyan', trojan: 'purple', hysteria2: 'magenta', tuic: 'geekblue', ss: 'green', ssr: 'green', anytls: 'orange' };

function protoType(t) { return protoColors[String(t || '').toLowerCase()] || 'default'; }

async function parseNodes(mode) {
  let payload;
  if (mode === 'url') payload = { mode: 'url', sources: String(c.value.sources || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };
  else if (mode === 'config') payload = { mode: 'text', text: c.value.configText, filename: 'config.yaml' };
  else payload = { mode: 'text', text: c.value.nodeText };
  if (mode === 'url' && !payload.sources.length) { message.warning('请先填写订阅链接'); return; }
  if (mode !== 'url' && !payload.text.trim()) { message.warning('请先粘贴内容或选择文件'); return; }
  parseBusy.value = true;
  try {
    const data = await api('/api/nodes/preview', { method: 'POST', body: payload });
    if (!data.count) message.warning('没有解析到节点，检查链接或文件内容');
    else message.success(`解析到 ${data.count} 个节点`);
    c.value.nodes = data.nodes || [];
    batch.value.sel = [];
    schedulePreview(200);
  } catch (e) {
    message.error(e.message || '解析失败');
  } finally {
    parseBusy.value = false;
  }
}

async function onFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { message.warning('文件超过 8MB，请拆分后再导入'); return; }
  const text = await file.text();
  c.value.configText = text;
  message.success(`已读取 ${file.name}（${(file.size / 1024).toFixed(1)} KB）`);
  await parseNodes('config');
}

function clearSources() { c.value.sources = ''; }
function clearLinks() { c.value.nodeText = ''; }

/* ── 批量编辑 ── */
const batchOpen = ref(false);
const bx = ref({ op: 'rename', include: '', exclude: '', find: '', to: '', affix: '', trim: true, space: true });
const batchPlan = computed(() => {
  const safe = (p) => { try { return new RegExp(p, 'i'); } catch { return new RegExp(String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } };
  const inc = bx.value.include ? safe(bx.value.include) : null;
  const exc = bx.value.exclude ? safe(bx.value.exclude) : null;
  const find = bx.value.find ? safe(bx.value.find) : null;
  const plan = [];
  batch.value.sel.forEach((i) => {
    const n = c.value.nodes[i];
    if (!n) return;
    if (inc && !inc.test(n.name)) return;
    if (exc && exc.test(n.name)) return;
    let next = n.name;
    if (bx.value.op === 'prefix') next = `${bx.value.affix || ''}${next}`;
    else if (bx.value.op === 'suffix') next = `${next}${bx.value.affix || ''}`;
    else if (bx.value.op === 'protocol') next = `[${String(n.type || '').toUpperCase()}] ${next}`;
    else {
      if (find) next = next.replace(find, bx.value.to || '');
      if (bx.value.trim) next = next.trim();
      if (bx.value.space) next = next.replace(/\s{2,}/g, ' ');
    }
    plan.push({ i, old: n.name, next });
  });
  return plan;
});
function openBatch() {
  if (!batch.value.sel.length) { message.warning('请先选择要批量编辑的节点'); return; }
  bx.value = { op: 'rename', include: '', exclude: '', find: '', to: '', affix: '', trim: true, space: true };
  batchOpen.value = true;
}
function applyBatch() {
  let changed = 0;
  batchPlan.value.forEach((p) => {
    if (p.next && p.next !== p.old) { c.value.nodes[p.i].name = p.next; changed += 1; }
  });
  batchOpen.value = false;
  persistLocal();
  message.success(`已修改 ${changed} 个节点名称`);
  schedulePreview(200);
}
function toggleBatch() {
  batch.value.on = !batch.value.on;
  if (!batch.value.on) batch.value.sel = [];
}
function batchAll() {
  const ids = filteredNodes.value.map((row) => row.i);
  const all = ids.length > 0 && ids.every((i) => batch.value.sel.includes(i));
  batch.value.sel = all ? [] : ids;
}
function toggleNodeSel(i) {
  const s = batch.value.sel;
  const idx = s.indexOf(i);
  if (idx >= 0) s.splice(idx, 1); else s.push(i);
}
function batchDelete() {
  if (!batch.value.sel.length) return;
  dialog.warning({
    title: '删除所选节点',
    content: `确定删除 ${batch.value.sel.length} 个节点？`,
    positiveText: '删除', negativeText: '取消',
    onPositiveClick: () => {
      const keep = c.value.nodes.filter((_, i) => !batch.value.sel.includes(i));
      c.value.nodes = keep;
      batch.value.sel = [];
      schedulePreview(200);
    },
  });
}
function adoptNodes() { message.info('节点已经是自定义节点，可直接编辑'); }

/* ── 节点编辑 ── */
const PROTOCOLS = ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'ssr', 'anytls', 'socks5', 'http'];
const nodeOpen = ref(false);
const nodeMode = ref('manual');
const nodeLink = ref('');
const nodeLinkBusy = ref(false);
const nodeForm = ref({ index: -1, name: '', type: 'vmess', server: '', port: 443, icon: '', password: '', uuid: '', cipher: 'aes-128-gcm', sni: '', tls: false });
const iconPickerOpen = ref(false);
function editNode(i) {
  const n = c.value.nodes[i];
  nodeForm.value = {
    index: i, name: n.name, type: n.type, server: n.server, port: n.port, icon: n.icon || '',
    password: n.password || '', uuid: n.uuid || '', cipher: n.cipher || 'aes-128-gcm', sni: n.sni || '', tls: !!n.tls,
  };
  nodeMode.value = 'manual';
  nodeOpen.value = true;
}
function addNode() {
  nodeForm.value = { index: -1, name: '', type: 'ss', server: '', port: 443, icon: '', password: '', uuid: '', cipher: 'aes-128-gcm', sni: '', tls: false };
  nodeLink.value = '';
  nodeMode.value = 'manual';
  nodeOpen.value = true;
}
async function parseNodeLink() {
  const link = String(nodeLink.value || '').trim();
  if (!link) { message.warning('请粘贴节点链接'); return; }
  nodeLinkBusy.value = true;
  try {
    const data = await api('/api/nodes/preview', { method: 'POST', body: { mode: 'text', text: link } });
    const n = (data.nodes || [])[0];
    if (!n) { message.warning('没有识别出节点，请检查链接'); return; }
    nodeForm.value = {
      ...nodeForm.value,
      name: n.name || nodeForm.value.name, type: n.type || nodeForm.value.type,
      server: n.server || '', port: n.port || 443,
      password: n.password || nodeForm.value.password, uuid: n.uuid || nodeForm.value.uuid,
      cipher: n.cipher || nodeForm.value.cipher, sni: n.sni || nodeForm.value.sni, tls: !!(n.tls || n.sni),
    };
    nodeMode.value = 'manual';
    message.success('已识别并填入下方字段，确认后保存');
  } catch (e) { message.error(e.message || '解析失败'); }
  finally { nodeLinkBusy.value = false; }
}
function saveNode() {
  const f = nodeForm.value;
  if (!f.server) { message.warning('请填写服务器地址'); return; }
  if (!f.port) { message.warning('请填写端口'); return; }
  const patch = {
    name: f.name || `${f.server}:${f.port}`, type: f.type, server: f.server, port: Number(f.port), icon: f.icon || '',
    password: f.password || '', uuid: f.uuid || '', cipher: f.cipher || '', sni: f.sni || '', tls: !!f.tls,
  };
  if (f.index >= 0) Object.assign(c.value.nodes[f.index], patch);
  else c.value.nodes.push({ ...patch });
  nodeOpen.value = false;
  persistLocal();
  schedulePreview(200);
}
function delNode(i) { c.value.nodes.splice(i, 1); schedulePreview(200); }

function moveNode(i, d) {
  const list = c.value.nodes;
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  batch.value.sel = [];
  schedulePreview(200);
}
function sortNodes(by) {
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true });
  if (by === 'name') c.value.nodes.sort((a, b) => collator.compare(String(a.name || ''), String(b.name || '')));
  if (by === 'type') c.value.nodes.sort((a, b) => String(a.type || '').localeCompare(String(b.type || '')) || collator.compare(String(a.name || ''), String(b.name || '')));
  if (by === 'server') c.value.nodes.sort((a, b) => String(a.server || '').localeCompare(String(b.server || '')));
  batch.value.sel = [];
  message.success('已重新排序');
  schedulePreview(200);
}
function batchSort(by) { sortNodes(by); }

/* ── 策略组草稿 ── */
const draft = computed(() => c.value.draft);
const draftDirty = computed(() => !!(draft.value && draft.value.dirty));

// 模板内容缓存：切换模板时不重复请求，保存/刷新时清空
const tplCache = new Map();
const DRAFT_BACKUP = 'subhub.draftBackup.';
const draftBackup = ref(null);
function readDraftBackup(name) {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_BACKUP + name) || 'null');
    if (!raw || !raw.model || !raw.at) return null;
    return raw;
  } catch { return null; }
}
function persistDraftBackup() {
  if (!draft.value) return;
  try {
    localStorage.setItem(DRAFT_BACKUP + draft.value.name, JSON.stringify({
      model: draft.value.model, at: Date.now(),
    }));
  } catch { /* 无痕模式 */ }
}
function clearDraftBackup(name) {
  try { localStorage.removeItem(DRAFT_BACKUP + (name || (draft.value && draft.value.name) || '')); } catch { /* ignore */ }
  draftBackup.value = null;
}
function restoreDraftBackup() {
  if (!draft.value || !draftBackup.value) return;
  draft.value.model = JSON.parse(JSON.stringify(draftBackup.value.model));
  draft.value.dirty = true;
  draftBackup.value = null;
  buildDraftSoon();
  message.success('已恢复本机草稿，记得点「保存模板」写入服务端');
}

async function loadDraft(force = false) {
  if (!can('templates:write')) return;
  const name = c.value.template;
  if (!name) return;
  if (!force && draft.value && draft.value.name === name) return;
  const cached = !force && tplCache.get(name);
  try {
    const info = cached || await api(`/api/templates/${encodeURIComponent(name)}`);
    if (!cached) tplCache.set(name, info);
    c.value.draft = { name, model: JSON.parse(JSON.stringify(info.model || { groups: [], rules: [] })), dirty: false, ini: info.content || '' };
    const backup = readDraftBackup(name);
    draftBackup.value = backup && JSON.stringify(backup.model) !== JSON.stringify(c.value.draft.model) ? backup : null;
  } catch (e) {
    c.value.draft = null;
    message.error(`加载模板失败：${e.message}`);
  }
}

function touchDraft() {
  if (!draft.value) return;
  draft.value.dirty = true;
  persistDraftBackup();
  buildDraftSoon();
}

let buildTimer = 0;
let buildSeq = 0;
function buildDraftSoon() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(async () => {
    if (!draft.value || !draft.value.dirty) return;
    const seq = ++buildSeq;
    const model = JSON.parse(JSON.stringify(draft.value.model));
    try {
      const data = await api('/api/templates/build', { method: 'POST', body: { model } });
      if (seq !== buildSeq || !draft.value) return;
      draft.value.ini = data.content;
      draft.value.dirty = true;
      schedulePreview(300);
    } catch (e) {
      if (seq === buildSeq) message.error(`模板生成失败：${e.message}`);
    }
  }, 400);
}

async function saveDraft() {
  if (!draft.value) return;
  try {
    await api(`/api/templates/${encodeURIComponent(draft.value.name)}`, { method: 'PUT', body: { model: draft.value.model } });
    message.success('模板已保存');
    draft.value.dirty = false;
    clearDraftBackup(draft.value.name);
    tplCache.delete(draft.value.name);
    await loadDraft(true);
  } catch (e) {
    message.error(e.message || '保存失败');
  }
}

function resetDraft() { if (draft.value) tplCache.delete(draft.value.name); loadDraft(true); }

/* ── 新建 / 编辑分组弹窗 ── */
const groupDlgOpen = ref(false);
const groupEditIndex = ref(-1);
const groupForm = reactive({ name: '', type: 'select', enabled: true, members: [], ruleUrl: '', cat: '' });
const groupMemberOptions = computed(() => {
  const groups = ((draft.value && draft.value.model.groups) || [])
    .filter((g, i) => i !== groupEditIndex.value)
    .map((g) => ({ label: `组 · ${g.name}`, value: g.name }));
  const nodes = (c.value.nodes || []).map((n) => ({ label: `节点 · ${n.name}`, value: n.name }));
  return [{ label: '内置', options: [{ label: 'DIRECT', value: 'DIRECT' }, { label: 'REJECT', value: 'REJECT' }] },
    { label: '策略组', options: groups }, { label: '节点', options: nodes }].filter((x) => x.options.length);
});
function openGroupDialog(index = -1) {
  if (!draft.value) { message.warning('模板尚未加载'); return; }
  groupEditIndex.value = index;
  if (index >= 0) {
    const g = draft.value.model.groups[index];
    groupForm.name = g.name;
    groupForm.type = g.type;
    groupForm.enabled = g.enabled !== false;
    groupForm.members = [...groupMembers(g)];
    groupForm.ruleUrl = '';
    groupForm.cat = g.cat || '';
  } else {
    groupForm.name = '';
    groupForm.type = 'select';
    groupForm.enabled = true;
    const first = (c.value.nodes || [])[0];
    groupForm.members = first ? [first.name] : [];
    groupForm.ruleUrl = '';
    groupForm.cat = '';
  }
  groupDlgOpen.value = true;
}
function confirmGroupDialog() {
  const name = String(groupForm.name || '').trim();
  if (!name) { message.warning('请填写分组名称'); return; }
  const gs = (draft.value && draft.value.model.groups) || [];
  if (gs.some((g, i) => i !== groupEditIndex.value && g.name === name)) { message.warning('分组名称已存在'); return; }
  if (!groupForm.members.length) { message.warning('请至少添加 1 个成员'); return; }
  if (groupForm.type === 'relay' && groupForm.members.length < 2) { message.warning('中转链至少需要 2 个成员'); return; }
  const isRef = groupForm.type === 'select' || groupForm.type === 'relay';
  if (groupEditIndex.value >= 0) {
    const g = gs[groupEditIndex.value];
    const oldName = g.name;
    g.name = name;
    g.type = groupForm.type;
    g.enabled = groupForm.enabled;
    if (groupForm.cat) g.cat = groupForm.cat; else delete g.cat;
    if (isRef) { g.refs = [...groupForm.members]; g.patterns = []; } else { g.patterns = [...groupForm.members]; g.refs = []; }
    if (oldName !== name) {
      ((draft.value && draft.value.model.rules) || []).forEach((r) => { if (r.target === oldName) r.target = name; });
      gs.forEach((x) => { if (Array.isArray(x.refs)) x.refs = x.refs.map((m) => (m === oldName ? name : m)); });
      (c.value.rules || []).forEach((r) => { if (r.group === oldName) r.group = name; });
    }
    message.success(`分组「${name}」已更新`);
  } else {
    gs.push({
      name, type: groupForm.type, enabled: groupForm.enabled,
      refs: isRef ? [...groupForm.members] : [], patterns: isRef ? [] : [...groupForm.members],
      ...(groupForm.cat ? { cat: groupForm.cat } : {}),
    });
    message.success(`已创建分组「${name}」`);
  }
  if (groupForm.ruleUrl && /^https?:\/\//i.test(groupForm.ruleUrl.trim())) {
    draft.value.model.rules.push({ target: name, kind: 'url', value: groupForm.ruleUrl.trim() });
  }
  groupDlgOpen.value = false;
  touchDraft();
  activePane.value = 'groups';
}
function addGroup() { openGroupDialog(-1); }
function moveGroup(i, d) {
  const gs = draft.value.model.groups;
  const j = i + d;
  if (j < 0 || j >= gs.length) return;
  [gs[i], gs[j]] = [gs[j], gs[i]];
  touchDraft();
}
function delGroup(i) { draft.value.model.groups.splice(i, 1); touchDraft(); }
const groupDrag = ref(-1);
const newPickOpen = ref(false);
function groupDragStart(i, e) {
  groupDrag.value = i;
  if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* ignore */ } }
}
function groupDrop(i) {
  const from = groupDrag.value;
  groupDrag.value = -1;
  if (from < 0 || from === i) return;
  const gs = draft.value.model.groups;
  const [row] = gs.splice(from, 1);
  gs.splice(i, 0, row);
  touchDraft();
  message.success('策略组顺序已更新');
}
function openNewPicker() {
  if (!draft.value) { message.warning('模板尚未加载'); return; }
  newPickOpen.value = true;
}
function pickNewCategory() {
  newPickOpen.value = false;
  catMgrOpen.value = true;
}
function pickNewGroup() {
  newPickOpen.value = false;
  openGroupDialog(-1);
}
function clearPresetGroups() {
  const model = draft.value && draft.value.model;
  if (!model) return;
  const relays = (model.groups || []).filter((g) => g.type === 'relay');
  const keep = new Set(relays.map((g) => g.name));
  const removedGroups = (model.groups || []).length - relays.length;
  const removedRules = (model.rules || []).filter((r) => !keep.has(r.target)).length;
  dialog.warning({
    title: '清空预设分组',
    content: `将移除 ${removedGroups} 个非中转分组，并把这些分组的 ${removedRules} 条规则统一指向新的「我的分组」（中转组保留）。之后可自由改名、拆分或新增分组。此操作只改当前模板草稿，可用「恢复」还原。`,
    positiveText: '清空', negativeText: '取消',
    onPositiveClick: () => {
      const nodeRefs = (c.value.nodes || []).map((n) => n.name).filter(Boolean).slice(0, 80);
      const starter = {
        name: '我的分组', type: 'select', enabled: true,
        refs: [...relays.map((g) => g.name), ...nodeRefs, 'DIRECT'],
      };
      model.groups = [...relays, starter];
      model.rules = (model.rules || []).map((r) => (keep.has(r.target) ? r : { ...r, target: starter.name }));
      c.value.rules = (c.value.rules || []).map((r) => (keep.has(r.group) ? r : { ...r, group: starter.name }));
      touchDraft();
      message.success('已清空预设分组，规则已统一指向「我的分组」');
    },
  });
}
const previewGroupRules = computed(() => {
  const map = {};
  const push = (target, name, tag) => {
    if (!target || !name) return;
    if (!map[target]) map[target] = [];
    if (!map[target].some((x) => x.name === name)) map[target].push({ name, tag: tag || '' });
  };
  ((draft.value && draft.value.model && draft.value.model.rules) || []).forEach((r) => {
    if (r.kind === 'pick') return;
    push(r.target, ruleLabel(r), (ruleTags(r) || [])[0] || '');
  });
  (c.value.rules || []).forEach((r) => push(r.group, r.name || r.id || '规则集', '规则集'));
  return map;
});
function onPreviewReorder({ from, to }) {
  const gs = draft.value && draft.value.model && draft.value.model.groups;
  if (!Array.isArray(gs)) return;
  const i = gs.findIndex((g) => g.name === from);
  const j = gs.findIndex((g) => g.name === to);
  if (i < 0 || j < 0 || i === j) return;
  const [moved] = gs.splice(i, 1);
  gs.splice(j, 0, moved);
  touchDraft();
  message.success('策略组顺序已更新');
}
function groupMembers(g) { return (g.type === 'select' || g.type === 'relay') ? (g.refs || []) : (g.patterns || []); }function removeMember(g, m) {
  if (g.type === 'select' || g.type === 'relay') g.refs = (g.refs || []).filter((x) => x !== m);
  else g.patterns = (g.patterns || []).filter((x) => x !== m);
  touchDraft();
}
function setGroupType(g, type) { g.type = type; touchDraft(); }

/* ── 分组分类（与预览面板同一套配色逻辑） ── */
const BASE_CATS = [
  { id: 'core', title: '核心组', label: '核心', color: '#6366f1', re: /节点选择|手动选择|自动选择|故障转移|负载均衡|兜底|DIRECT|REJECT|落地/i },
  { id: 'common', title: '常用服务', label: '常用', color: '#10b981', re: /谷歌|Google|苹果|Apple|微软|Microsoft|服务|直连|国内|局域网/i },
  { id: 'social', title: '社交通讯', label: '社交', color: '#a855f7', re: /电报|Telegram|推特|社交|Discord|X\b/i },
  { id: 'media', title: '媒体娱乐', label: '媒体', color: '#f59e0b', re: /奈飞|Netflix|YouTube|油管|流媒体|视频|Spotify|音乐|TikTok/i },
  { id: 'game', title: '游戏下载', label: '游戏', color: '#06b6d4', re: /游戏|Steam|下载|Game/i },
  { id: 'tech', title: '技术服务', label: '技术', color: '#8b5cf6', re: /AI|OpenAI|Claude|GitHub|技术|开发|编程/i },
  { id: 'pay', title: '支付金融', label: '支付', color: '#14b8a6', re: /支付|银行|Pay|金融/i },
  { id: 'other', title: '其它分组', label: '其它', color: '#94a3b8', re: /[\s\S]*/ },
];
const CAT_KEY = 'subhub.groupCats.v1';
const customCats = ref([]);
try {
  const saved = JSON.parse(localStorage.getItem(CAT_KEY) || '[]');
  if (Array.isArray(saved)) customCats.value = saved.filter((c) => c && c.id && c.title);
} catch { /* ignore */ }
function persistCats() { try { localStorage.setItem(CAT_KEY, JSON.stringify(customCats.value)); } catch { /* ignore */ } }
const CATS = computed(() => [...BASE_CATS.slice(0, -1), ...customCats.value.map((c) => ({ ...c, re: null })), BASE_CATS[BASE_CATS.length - 1]]);
function catOf(name, explicit) {
  const list = CATS.value;
  if (explicit) {
    const hit = list.find((c) => c.id === explicit);
    if (hit) return hit;
  }
  return list.find((c) => c.re && c.re.test(String(name || ''))) || list[list.length - 1];
}
const catMgrOpen = ref(false);
const catNew = reactive({ title: '', color: '#ec4899' });
function addCategory() {
  const title = String(catNew.title || '').trim();
  if (!title) { message.warning('请填写分类名称'); return; }
  if (CATS.value.some((c) => c.title === title)) { message.warning('分类已存在'); return; }
  customCats.value.push({ id: 'c' + Date.now().toString(36), title, label: title.slice(0, 4), color: catNew.color });
  persistCats();
  catNew.title = '';
  message.success('分类已创建');
}
function removeCategory(id) {
  customCats.value = customCats.value.filter((c) => c.id !== id);
  ((draft.value && draft.value.model.groups) || []).forEach((g) => { if (g.cat === id) delete g.cat; });
  persistCats();
  touchDraft();
}

const expandedGroups = ref(new Set());
function toggleGroup(name) {
  const set = new Set(expandedGroups.value);
  if (set.has(name)) set.delete(name); else set.add(name);
  expandedGroups.value = set;
}
const catOpen = reactive({ core: true, common: true, social: false, media: false, game: false, tech: false, pay: false, other: false });
function toggleCatSection(id) { catOpen[id] = !catOpen[id]; }

const relayGroups = computed(() => ((draft.value && draft.value.model.groups) || [])
  .map((g, i) => ({ g, i })).filter((row) => row.g.type === 'relay'));
const groupCats = computed(() => {
  const list = ((draft.value && draft.value.model.groups) || []).map((g, i) => ({ g, i }));
  return CATS.value.map((cat) => {
    const groups = list.filter((row) => row.g.type !== 'relay' && catOf(row.g.name, row.g.cat).id === cat.id);
    return {
      ...cat,
      groups,
      total: groups.length,
      enabled: groups.filter((row) => row.g.enabled !== false).length,
    };
  }).filter((cat) => cat.total);
});
const TEST_URL_PRESETS = [
  { label: '通用 204（Google）', value: 'http://www.gstatic.com/generate_204' },
  { label: 'Cloudflare 204', value: 'http://cp.cloudflare.com/generate_204' },
  { label: 'OpenAI / ChatGPT', value: 'https://chatgpt.com' },
  { label: 'Netflix', value: 'https://www.netflix.com' },
  { label: 'YouTube', value: 'https://www.youtube.com' },
  { label: 'GitHub', value: 'https://github.com' },
  { label: 'Telegram', value: 'https://telegram.org' },
];
const testUrl = ref(localStorage.getItem('subhub.testUrl') || TEST_URL_PRESETS[0].value);
const testUrlPreset = computed({
  get: () => TEST_URL_PRESETS.find((p) => p.value === testUrl.value)?.value || 'custom',
  set: (v) => { if (v !== 'custom') testUrl.value = v; },
});
function applyTestUrl() {
  const url = String(testUrl.value || '').trim();
  if (!/^https?:\/\//i.test(url)) { message.warning('测速地址需要以 http(s):// 开头'); return; }
  const gs = (draft.value && draft.value.model.groups) || [];
  const targets = gs.filter((g) => ['url-test', 'fallback', 'load-balance'].includes(g.type));
  if (!targets.length) { message.warning('当前模板没有自动测速/故障转移/负载均衡分组'); return; }
  targets.forEach((g) => { g.url = url; });
  try { localStorage.setItem('subhub.testUrl', url); } catch { /* ignore */ }
  touchDraft();
  message.success(`已更新 ${targets.length} 个分组的测速地址`);
}
const groupTotal = computed(() => ((draft.value && draft.value.model.groups) || []).length);
const groupEnabled = computed(() => ((draft.value && draft.value.model.groups) || []).filter((g) => g.enabled !== false).length);
const sourceCount = computed(() => sourceRows.value.filter((r) => String(r.value || '').trim()).length);
const parsedSourceCount = computed(() => sourceRows.value.filter((r) => r.count > 0).length);
function setNodeOrder(i, v) {
  const to = Math.max(0, Math.min(c.value.nodes.length - 1, Number(v) - 1));
  if (!Number.isFinite(to) || to === i) return;
  const [n] = c.value.nodes.splice(i, 1);
  c.value.nodes.splice(to, 0, n);
  schedulePreview(200);
}
const REGION_RULES = [
  { re: /香港|HK|Hong ?Kong/i, flag: '🇭🇰', name: '香港' },
  { re: /台湾|台灣|TW|Taiwan/i, flag: '🇹🇼', name: '台湾' },
  { re: /日本|JP|Japan|东京|大阪/i, flag: '🇯🇵', name: '日本' },
  { re: /新加坡|狮城|SG|Singapore/i, flag: '🇸🇬', name: '新加坡' },
  { re: /美国|US|United States|洛杉矶|圣何塞|西雅图/i, flag: '🇺🇸', name: '美国' },
  { re: /韩国|KR|Korea|首尔/i, flag: '🇰🇷', name: '韩国' },
  { re: /英国|UK|GB|London/i, flag: '🇬🇧', name: '英国' },
  { re: /德国|DE|Germany/i, flag: '🇩🇪', name: '德国' },
  { re: /法国|FR|France/i, flag: '🇫🇷', name: '法国' },
  { re: /加拿大|CA|Canada/i, flag: '🇨🇦', name: '加拿大' },
  { re: /澳大利亚|澳洲|AU|Sydney/i, flag: '🇦🇺', name: '澳大利亚' },
  { re: /荷兰|NL|Netherlands/i, flag: '🇳🇱', name: '荷兰' },
  { re: /俄罗斯|RU|Russia/i, flag: '🇷🇺', name: '俄罗斯' },
  { re: /印度|IN|India/i, flag: '🇮🇳', name: '印度' },
  { re: /土耳其|TR|Turkey/i, flag: '🇹🇷', name: '土耳其' },
  { re: /巴西|BR|Brazil/i, flag: '🇧🇷', name: '巴西' },
];
function regionOf(text) {
  const s = String(text || '');
  const hit = REGION_RULES.find((r) => r.re.test(s));
  return hit || null;
}
function cleanNodeName(raw) {
  let s = String(raw || '');
  s = s.replace(/【[^】]*】|\[[^\]]*\]/g, ' ');
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  s = s.replace(/官网|訂閱|订阅|剩余|到期|过期|流量|倍率|重置|更新|群组|Telegram|t\.me/gi, ' ');
  s = s.replace(/\b\d+(\.\d+)?\s*[xX×]\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
const REGION_CODE = { 香港: 'HK', 台湾: 'TW', 日本: 'JP', 新加坡: 'SG', 美国: 'US', 韩国: 'KR', 英国: 'UK', 德国: 'DE', 法国: 'FR', 加拿大: 'CA', 澳大利亚: 'AU', 荷兰: 'NL', 俄罗斯: 'RU', 印度: 'IN', 土耳其: 'TR', 巴西: 'BR' };
function regionName(raw) {
  const cleaned = cleanNodeName(raw);
  const hit = regionOf(cleaned);
  if (!hit) return cleaned;
  const code = REGION_CODE[hit.name] || hit.name;
  if (cleaned.startsWith(`${code} ${hit.name}`)) return cleaned;
  const stripped = cleaned
    .replace(new RegExp(`^\\s*(${code}|${hit.name})\\s*`, 'i'), '')
    .replace(hit.re, '')
    .replace(/^[\s·\-_|]+/, '')
    .trim();
  return `${code} ${hit.name}${stripped ? ' · ' + stripped : ''}`;
}
function applyAutoOps(list, ops) {
  let rows = list.map((n) => ({ ...n }));
  if (ops.includes('clean')) rows.forEach((n) => { n.name = cleanNodeName(n.name) || n.name; });
  if (ops.includes('region')) rows.forEach((n) => { n.name = regionName(n.name); });
  if (ops.includes('dedupe')) {
    const seen = new Set();
    rows = rows.filter((n) => {
      const k = `${n.type}|${n.server}|${n.port}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true });
  if (ops.includes('sort-region')) rows.sort((a, b) => String(regionOf(a.name)?.name || 'zz').localeCompare(String(regionOf(b.name)?.name || 'zz')) || collator.compare(a.name, b.name));
  if (ops.includes('name')) rows.sort((a, b) => collator.compare(String(a.name || ''), String(b.name || '')));
  if (ops.includes('type')) rows.sort((a, b) => String(a.type || '').localeCompare(String(b.type || '')));
  if (ops.includes('server')) rows.sort((a, b) => String(a.server || '').localeCompare(String(b.server || '')));
  return rows;
}
const autoProcessOptions = [
  { label: '清理名称（广告、剩余流量、到期、倍率）', key: 'clean' },
  { label: '识别地区并加国旗 + 中文地区名', key: 'region' },
  { label: '去重（协议 + 服务器 + 端口，保留第一个）', key: 'dedupe' },
  { label: '按地区排序', key: 'sort-region' },
  { label: '按名称排序', key: 'name' },
  { label: '按协议排序', key: 'type' },
  { label: '按服务器排序', key: 'server' },
];
const autoOpen = ref(false);
const autoPicks = ref(['clean', 'region']);
const autoPreview = computed(() => {
  const before = c.value.nodes || [];
  if (!autoPicks.value.length) return [];
  const after = applyAutoOps(before, autoPicks.value);
  if (autoPicks.value.some((k) => k.startsWith('sort-') || ['name', 'type', 'server'].includes(k))) {
    return after.map((n, i) => ({ name: before[i] ? before[i].name : '—', next: `${i + 1}. ${n.name}` })).slice(0, 80);
  }
  return after.map((n, i) => ({ name: (before[i] && before[i].name) || n.name, next: n.name })).filter((p) => p.name !== p.next).slice(0, 80);
});
function openAuto() { autoOpen.value = true; autoPicks.value = ['clean', 'region']; }
function applyAuto() {
  if (!autoPicks.value.length) { message.warning('请至少选择一种处理方式'); return; }
  const before = c.value.nodes.length;
  c.value.nodes = applyAutoOps(c.value.nodes, autoPicks.value);
  persistLocal();
  message.success(`已处理 ${before} 个节点（${autoPicks.value.length} 种方式）`);
  autoOpen.value = false;
  schedulePreview(200);
}
function autoProcess(key) {
  if (key === 'dedupe') {
    const seen = new Set();
    const before = c.value.nodes.length;
    c.value.nodes = c.value.nodes.filter((n) => {
      const k = `${n.type}|${n.server}|${n.port}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    message.success(`已去重 ${before - c.value.nodes.length} 个节点`);
  } else if (key === 'clean') {
    c.value.nodes.forEach((n) => { n.name = String(n.name || '').replace(/\s*(剩余|到期|过期|官网|流量).*$/i, '').trim(); });
    message.success('已清理节点名称');
  } else {
    sortNodes(key);
  }
  schedulePreview(200);
}
const quickRulesetUrl = ref('');
const quickTarget = ref('');
function addQuickRuleset() {
  const url = String(quickRulesetUrl.value || '').trim();
  if (!/^https?:\/\//i.test(url)) { message.warning('请填写 http(s) 规则集地址'); return; }
  if (!draft.value) { message.warning('模板尚未加载'); return; }
  const target = quickTarget.value || ((draft.value.model.groups || [])[0] || {}).name;
  if (!target) { message.warning('请先创建或选择一个分组'); return; }
  draft.value.model.rules.push({ target, kind: 'url', value: url });
  touchDraft();
  quickRulesetUrl.value = '';
  message.success(`规则集已加入「${target}」`);
}
function goLibraryRulesets() { location.hash = '#/library'; }
function addRelayGroup() {
  if (!draft.value) return;
  const nodes = (c.value.nodes || []).filter((n) => n && n.name);
  if (nodes.length < 2) { message.warning('中转组至少需要 2 个节点，请先解析节点'); return; }
  const n = draft.value.model.groups.filter((g) => g.type === 'relay').length + 1;
  draft.value.model.groups.push({
    name: `🔗 中转组${n > 1 ? ` ${n}` : ''}`,
    type: 'relay',
    refs: nodes.slice(0, 2).map((x) => x.name),
    patterns: [],
  });
  touchDraft();
}

/* ── 模板上传 / 输出下载 ── */
const tplInput = ref(null);
function pickTemplateFile() { if (tplInput.value) tplInput.value.click(); }
async function uploadTemplate(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 512 * 1024) { message.warning('模板超过 512KB'); return; }
  const content = await file.text();
  const name = (file.name.replace(/\.[^.]+$/, '') || 'uploaded').replace(/[^\w.-]/g, '-').slice(0, 64);
  try {
    await api('/api/templates', { method: 'POST', body: { name, content } });
    await loadState();
    c.value.template = name;
    tplCache.delete(name);
    await loadDraft(true);
    message.success(`模板「${name}」已上传并应用`);
  } catch (err) { message.error(err.message || '上传失败'); }
}
function downloadOutput() {
  const body = state.preview.body;
  if (!body) { message.warning('还没有可下载的配置'); return; }
  const ext = c.value.target === 'singbox' ? 'json' : ['v2ray', 'daed'].includes(c.value.target) ? 'txt' : 'yaml';
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `subhub-${c.value.target || 'config'}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const usedRules = (name) => ((draft.value && draft.value.model.rules) || []).filter((r) => r.target === name);

/* ── 成员选择 ── */
const memberOpen = ref(false);
const memberIndex = ref(-1);
const memberSel = ref([]);
const memberQ = ref('');
const memberOptions = computed(() => {
  const groups = ((draft.value && draft.value.model.groups) || []).map((g) => g.name).filter((n) => n !== currentGroupName());
  const nodes = c.value.nodes.map((n) => n.name);
  const q = memberQ.value.trim().toLowerCase();
  const f = (arr) => (q ? arr.filter((x) => x.toLowerCase().includes(q)) : arr);
  return [
    { key: 'groups', label: '策略组', options: f(groups).map((g) => ({ label: g, value: g })) },
    { key: 'nodes', label: '当前订阅节点', options: f(nodes).map((n) => ({ label: n, value: n })) },
    { key: 'builtin', label: '内置出站', options: f(['DIRECT', 'REJECT']).map((g) => ({ label: g, value: g })) },
  ].filter((g) => g.options.length);
});
function currentGroupName() {
  const g = draft.value && draft.value.model.groups[memberIndex.value];
  return g ? g.name : '';
}
function pickMembers(i) {
  memberIndex.value = i;
  const g = draft.value.model.groups[i];
  memberSel.value = [...groupMembers(g)];
  memberQ.value = '';
  memberOpen.value = true;
}
function applyMembers() {
  const g = draft.value.model.groups[memberIndex.value];
  if (g) {
    if (g.type === 'select' || g.type === 'relay') g.refs = [...memberSel.value];
    else g.patterns = [...memberSel.value];
    touchDraft();
  }
  memberOpen.value = false;
}

/* ── 规则 ── */
// 模板里的规则 → 规则集名称 + 标签（鼠标悬停显示）
const rulesetByUrl = computed(() => {
  const map = new Map();
  for (const r of state.library.rulesets || []) {
    for (const u of Object.values(r.urls || {})) if (u) map.set(u, r);
  }
  return map;
});
function ruleInfo(r) {
  if (!r) return { name: '—', tags: [], desc: '' };
  // parseIni 的远程规则用 { kind:'url', value:'https://…' }，手写规则用 { kind:'inline', value:'DOMAIN,…' }
  const url = r.kind === 'url' ? (r.value || '') : (r.url || '');
  if (url) {
    const hit = rulesetByUrl.value.get(url);
    if (hit) return { name: hit.name || hit.id, tags: hit.tags || [], desc: hit.desc || '', url, group: hit.group };
    const m = /([^/?#]+?)(?:\.(?:list|ya?ml|mrs|srs))?(?:[?#].*)?$/.exec(url);
    return { name: m ? m[1] : '远程规则集', tags: [], desc: '', url };
  }
  const inline = r.value || [r.type, r.value].filter(Boolean).join(',') || '内联规则';
  const short = inline.length > 30 ? `${inline.slice(0, 28)}…` : inline;
  return { name: short, tags: ['内联'], desc: '', rule: inline };
}
function groupRules(g) {
  const rows = [];
  const modelRules = (draft.value && draft.value.model.rules) || [];
  modelRules.forEach((r, i) => {
    if (r.target !== g.name) return;
    const meta = metaForRule(r) || {};
    const base = ruleInfo(r);
    rows.push({
      ...base, kind: 'tpl', tplIndex: i,
      tags: (base.tags && base.tags.length ? base.tags : meta.tags) || [],
      desc: base.desc || meta.desc || '',
      source: meta.source || '',
    });
  });
  (c.value.rules || []).forEach((r, i) => {
    if (r.group !== g.name) return;
    rows.push({
      name: r.name || r.id, tags: r.tags || [], desc: r.desc || '', url: r.id, kind: 'pick', pickIndex: i,
    });
  });
  const seen = new Set();
  return rows.filter((x) => {
    const k = x.kind + '|' + x.name + '|' + (x.url || '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function removeGroupRule(row) {
  if (row.kind === 'tpl') {
    if (!draft.value) return;
    draft.value.model.rules.splice(row.tplIndex, 1);
    touchDraft();
  } else {
    c.value.rules.splice(row.pickIndex, 1);
    schedulePreview(250);
  }
  message.success('已移除');
}

/* ── 分组内添加规则（规则集 / 手写 / 远程 URL） ── */
const groupRuleOpen = ref(false);
const groupRuleGroup = ref('');
const groupRuleMode = ref('catalog');
const groupRuleQ = ref('');
const groupRuleItems = ref([]);
const groupRuleLoading = ref(false);
const groupInline = ref({ type: 'DOMAIN-SUFFIX', value: '', noResolve: false });
const groupUrl = ref('');
let groupRuleTimer = 0;

function openGroupRules(g) {
  groupRuleGroup.value = g.name;
  groupRuleMode.value = 'catalog';
  groupRuleQ.value = '';
  groupRuleItems.value = [];
  groupInline.value = { type: 'DOMAIN-SUFFIX', value: '', noResolve: false };
  groupUrl.value = '';
  groupRuleOpen.value = true;
}

function searchGroupRules(q) {
  groupRuleQ.value = q;
  clearTimeout(groupRuleTimer);
  if (!String(q || '').trim()) { groupRuleItems.value = []; return; }
  groupRuleTimer = setTimeout(async () => {
    groupRuleLoading.value = true;
    try {
      const data = await api(`/api/rules?limit=20&q=${encodeURIComponent(q)}`);
      groupRuleItems.value = data.items || [];
    } catch { groupRuleItems.value = []; }
    groupRuleLoading.value = false;
  }, 220);
}

function addCatalogRule(it) {
  if (!it) return;
  if (c.value.rules.some((r) => r.id === it.id)) { message.info('已经添加过这个规则集'); return; }
  c.value.rules.push({
    id: it.id,
    name: it.zh || it.label || it.name,
    group: groupRuleGroup.value,
    noResolve: !!it.noResolve,
    tags: it.tags || [],
    desc: it.desc || '',
  });
  message.success(`已加入「${groupRuleGroup.value}」`);
  schedulePreview(250);
}

function addInlineRuleToGroup() {
  const f = groupInline.value;
  if (!String(f.value || '').trim()) { message.warning('请填写规则值'); return; }
  if (!draft.value) { message.warning('模板尚未加载'); return; }
  draft.value.model.rules.push({
    target: groupRuleGroup.value,
    kind: 'inline',
    type: f.type,
    value: f.value.trim(),
    options: f.noResolve ? ['no-resolve'] : [],
  });
  touchDraft();
  groupInline.value = { type: f.type, value: '', noResolve: f.noResolve };
  message.success('已写入模板规则');
}

function addUrlRuleToGroup() {
  const url = String(groupUrl.value || '').trim();
  if (!/^https?:\/\//i.test(url)) { message.warning('请填写 http(s) 规则集地址'); return; }
  if (!draft.value) { message.warning('模板尚未加载'); return; }
  draft.value.model.rules.push({ target: groupRuleGroup.value, kind: 'url', value: url });
  touchDraft();
  groupUrl.value = '';
  message.success('已写入模板规则');
}

const ruleQ = ref('');
const ruleItems = ref([]);
const ruleTotal = ref(0);
const ruleLoading = ref(false);
let ruleTimer = 0;

async function searchRules(q) {
  ruleQ.value = q;
  clearTimeout(ruleTimer);
  if (!String(q || '').trim()) { ruleItems.value = []; ruleTotal.value = 0; return; }
  ruleTimer = setTimeout(async () => {
    ruleLoading.value = true;
    try {
      const data = await api(`/api/rules?limit=12&q=${encodeURIComponent(q)}`);
      ruleItems.value = data.items || [];
      ruleTotal.value = data.total || 0;
    } catch { ruleItems.value = []; }
    ruleLoading.value = false;
  }, 220);
}

const ruleOptions = computed(() => ruleItems.value.map((it) => ({
  label: `${it.zh || it.label || it.name}（${it.id}）`,
  value: it.id,
  item: it,
})));

function addRule(it) {
  if (!it) return;
  if (c.value.rules.some((r) => r.id === it.id)) { message.info('已经添加过这个规则集'); return; }
  c.value.rules.push({ id: it.id, name: it.zh || it.label || it.name, group: it.group || '🚀 节点选择', noResolve: !!it.noResolve });
  ruleQ.value = '';
  ruleItems.value = [];
  schedulePreview(300);
}
function delRule(i) { c.value.rules.splice(i, 1); schedulePreview(300); }
function moveRule(i, d) {
  const j = i + d;
  if (j < 0 || j >= c.value.rules.length) return;
  [c.value.rules[i], c.value.rules[j]] = [c.value.rules[j], c.value.rules[i]];
  schedulePreview(200);
}

const dragIdx = ref(-1);
function onDragStart(e, i) {
  dragIdx.value = i;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* ignore */ }
}
function onDrop(i) {
  const from = dragIdx.value;
  dragIdx.value = -1;
  if (from < 0 || from === i) return;
  const list = c.value.rules;
  const [moved] = list.splice(from, 1);
  list.splice(i, 0, moved);
  schedulePreview(200);
}

const customOpen = ref(false);
const customForm = ref({ type: 'DOMAIN-SUFFIX', value: '', group: '🚀 节点选择', noResolve: false });
const RULE_TYPES = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'PROCESS-NAME'];
function addCustomRule() {
  const f = customForm.value;
  if (!f.value.trim()) { message.warning('请填写规则值'); return; }
  const rule = `${f.type},${f.value.trim()}${f.noResolve ? ',no-resolve' : ''}`;
  c.value.rules.push({ id: makeLocalId('inline'), name: rule, group: f.group, inline: [rule], noResolve: !!f.noResolve });
  customOpen.value = false;
  customForm.value = { type: 'DOMAIN-SUFFIX', value: '', group: f.group, noResolve: false };
  schedulePreview(300);
}

const groupOptions = computed(() => {
  const all = ((draft.value && draft.value.model.groups) || []);
  const names = all.filter((g) => g.type !== 'relay').map((g) => g.name);
  const base = names.length ? names : ['🚀 节点选择', '♻️ 自动选择', '🎯 全球直连', '🛑 广告拦截', '🐟 漏网之鱼'];
  return base.map((n) => ({ label: n, value: n }));
});

/* ── 规则管理 ── */
const RULE_TYPE_OPTIONS = [
  { label: 'DOMAIN · 精确域名', value: 'DOMAIN' },
  { label: 'DOMAIN-SUFFIX · 域名后缀', value: 'DOMAIN-SUFFIX' },
  { label: 'DOMAIN-KEYWORD · 域名关键词', value: 'DOMAIN-KEYWORD' },
  { label: 'IP-CIDR · IPv4 网段', value: 'IP-CIDR' },
  { label: 'IP-CIDR6 · IPv6 网段', value: 'IP-CIDR6' },
  { label: 'GEOIP · IP 归属地', value: 'GEOIP' },
  { label: 'PROCESS-NAME · 进程名', value: 'PROCESS-NAME' },
];
const ruleDlgOpen = ref(false);
const ruleDrag = ref(-1);
const ruleDlg = reactive({ mode: 'url', url: '', type: 'DOMAIN-SUFFIX', value: '', target: '', persist: false, name: '' });
const ruleOpen = reactive({});
const ruleCount = computed(() => ((draft.value && draft.value.model.rules) || []).length + (c.value.rules || []).length);
const draftRules = computed(() => ((draft.value && draft.value.model.rules) || []).map((r, i) => ({ r, i })));

function libRuleFor(r) {
  if (!r || r.kind !== 'url') return null;
  const u = String(r.value || '').split('?')[0];
  const file = (u.split('/').pop() || '').replace(/\.(mrs|srs|yaml|yml|list|txt|conf|json)$/i, '');
  return (state.library.rulesets || []).find((it) => {
    const urls = it.urls || {};
    return Object.values(urls).some((x) => String(x || '').split('?')[0] === u) || it.id === file || it.name === file;
  }) || null;
}
function ruleMeta(r) {
  if (!r) return null;
  if (r.kind !== 'url') return null;
  const raw = String(r.value || '').split('?')[0].split('#')[0];
  const base = raw.split('/').pop() || '';
  const id = base.replace(/\.(mrs|srs|yaml|yml|list|txt|conf|json)$/i, '');
  return rulesetMeta[id] || rulesetMeta[String(id).replace(/^geosite-/, '')] || null;
}
function ruleFileName(r) {
  if (r.kind !== 'url') return '';
  const u = String(r.value || '').split('?')[0];
  return decodeURIComponent(u.split('/').pop() || '');
}
function ruleLabel(r) {
  if (r.kind === 'url') {
    const meta = ruleMeta(r);
    const lib = libRuleFor(r);
    return (meta && meta.name) || (lib && lib.name) || ruleFileName(r) || '远程规则集';
  }
  return `${r.type || 'RULE'} · ${r.value || ''}`;
}
function ruleTags(r) {
  const meta = ruleMeta(r);
  const lib = libRuleFor(r);
  const tags = meta && Array.isArray(meta.tags) ? meta.tags.slice(0, 3)
    : lib && Array.isArray(lib.tags) ? lib.tags.slice(0, 3) : [];
  if (r.kind !== 'url') tags.unshift('内联');
  if (r.options && r.options.includes('no-resolve')) tags.push('no-resolve');
  return [...new Set(tags)].filter(Boolean).slice(0, 4);
}
function metaForRule(r) {
  const meta = ruleMeta(r);
  if (meta) return { ...meta, source: '官方目录' };
  const lib = libRuleFor(r);
  if (lib) return { desc: lib.desc || lib.name, tags: lib.tags || [], source: '资源库' };
  if (r.kind === 'url') return { desc: '远程规则集，转换时由引擎拉取；可加入资源库以便复用与标注。', tags: ['远程'], source: '' };
  return { desc: '当前配置内联规则，只影响这份配置，不会写入规则库。', tags: ['内联'], source: '' };
}

const catalogHits = ref([]);
const libSearching = ref(false);
let libSearchTimer = 0;
async function searchRuleCatalog(q) {
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(async () => {
    libSearching.value = true;
    try {
      const r = await api(`/api/rules?limit=40&q=${encodeURIComponent(String(q || '').trim())}`);
      catalogHits.value = Array.isArray(r.items) ? r.items : [];
    } catch (e) { catalogHits.value = []; } finally { libSearching.value = false; }
  }, 180);
}
const ruleLibOptions = computed(() => {
  const seen = new Set();
  const rows = [];
  for (const it of state.library.rulesets || []) {
    const url = it.urls && (it.urls.mihomo || it.urls.clash || it.urls.singbox);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push({ label: `${it.name}${it.cat ? ` · ${it.cat}` : ''}`, value: url, source: '库' });
  }
  for (const it of catalogHits.value) {
    const url = it.urls && (it.urls.mihomo || it.urls.singbox || it.urls.raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push({ label: `${it.zh || it.name} · ${it.id}`, value: url, source: '官方' });
  }
  return rows;
});

async function addRuleToLibrary(r) {
  if (!r || r.kind !== 'url') return;
  const url = String(r.value || '').trim();
  const file = ruleFileName(r).replace(/\.(mrs|srs|yaml|yml|list|txt|conf|json)$/i, '') || `ruleset-${Date.now()}`;
  const id = file.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `ruleset-${Date.now()}`;
  try {
    await api('/api/library/rulesets', {
      method: 'POST',
      body: {
        id, name: ruleLabel(r), cat: '未分类', group: r.target || '', behavior: 'classical',
        desc: '', tags: ruleTags(r).filter((t) => t !== '内联'),
        urls: /\.srs(\?|#|$)/i.test(url) ? { singbox: url } : { mihomo: url },
      },
    });
    message.success('已加入资源库，可在资源库中补充分类与说明');
    await loadState();
  } catch (e) { message.error(e.payload?.error || e.message || '加入资源库失败'); }
}
function moveDraftRule(i, delta) {
  const list = draft.value && draft.value.model.rules;
  if (!list) return;
  const to = i + delta;
  if (to < 0 || to >= list.length) return;
  const [row] = list.splice(i, 1);
  list.splice(to, 0, row);
  touchDraft();
}
function dropDraftRule(to) {
  const list = draft.value && draft.value.model.rules;
  const from = ruleDrag.value;
  ruleDrag.value = -1;
  if (!list || from < 0 || from === to || to < 0 || to >= list.length) return;
  const [row] = list.splice(from, 1);
  list.splice(to, 0, row);
  touchDraft();
}
function removeDraftRule(i) {
  const list = draft.value && draft.value.model.rules;
  if (!list) return;
  list.splice(i, 1);
  touchDraft();
}
function setDraftRuleTarget(i, v) {
  const list = draft.value && draft.value.model.rules;
  if (!list || !list[i]) return;
  list[i].target = v;
  touchDraft();
}
function openRuleDialog(mode) {
  ruleDlg.mode = mode;
  ruleDlg.url = '';
  ruleDlg.type = 'DOMAIN-SUFFIX';
  ruleDlg.value = '';
  ruleDlg.target = (groupOptions.value[0] || {}).value || '';
  ruleDlg.persist = false;
  ruleDlg.name = '';
  ruleDlgOpen.value = true;
  searchRuleCatalog('');
}
async function confirmRuleDialog() {
  if (!draft.value) return;
  if (!ruleDlg.target) { message.warning('请选择目标策略组'); return; }
  const list = draft.value.model.rules || (draft.value.model.rules = []);
  if (ruleDlg.mode === 'url' || ruleDlg.mode === 'lib') {
    const url = String(ruleDlg.url || '').trim();
    if (!/^https?:\/\//i.test(url)) { message.warning(ruleDlg.mode === 'lib' ? '请从资源库选择规则集' : '请填写 http(s) 规则集地址'); return; }
    list.push({ target: ruleDlg.target, kind: 'url', type: 'URL', value: url, options: [] });
  } else {
    const value = String(ruleDlg.value || '').trim();
    if (!value) { message.warning('请填写规则值'); return; }
    list.push({ target: ruleDlg.target, kind: 'inline', type: ruleDlg.type, value, options: [] });
  }
  touchDraft();
  ruleDlgOpen.value = false;
  message.success('已加入当前配置，可在列表中拖拽或上下移动调整优先级');
  if (ruleDlg.persist) await saveDraft();
}


/* ── 转换 ── */
const ruleFileInput = ref(null);
function onRuleFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !draft.value || !ruleDlg.target) return;
  const reader = new FileReader();
  reader.onload = () => {
    const lines = String(reader.result || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && !s.startsWith(';'));
    if (!lines.length) { message.warning('规则文件为空'); return; }
    const list = draft.value.model.rules || (draft.value.model.rules = []);
    let added = 0;
    lines.forEach((line) => {
      const comma = line.indexOf(',');
      let type = ruleDlg.type;
      let value = line;
      if (comma > 0) {
        const head = line.slice(0, comma).trim().toUpperCase();
        const hit = RULE_TYPE_OPTIONS.find((o) => o.value === head);
        if (hit) { type = hit.value; value = line.slice(comma + 1).trim(); }
      }
      if (!value) return;
      list.push({ target: ruleDlg.target, kind: 'inline', type, value, options: [] });
      added += 1;
    });
    touchDraft();
    ruleDlgOpen.value = false;
    message.success(`已从 ${file.name} 导入 ${added} 条规则`);
    if (ruleDlg.persist) saveDraft();
  };
  reader.readAsText(file);
}

function setPreview(data) {
  state.preview = {
    body: data.body || '',
    nodes: data.nodes || 0,
    bytes: data.bytes || 0,
    ms: data.ms || 0,
    warnings: data.warnings || [],
    loading: false,
    error: '',
    at: Date.now(),
    userinfo: data.userinfo || '',
  };
  state.link = '';
}

async function convert(silent = false) {
  if (!canConvert()) { if (!silent) message.warning('请先填写订阅链接或导入节点'); return; }
  if (draftDirty.value) c.value.useDraftOnce = true;
  convertBusy.value = true;
  state.preview.loading = true;
  try {
    const data = await api('/api/convert', { method: 'POST', body: buildPayload() });
    setPreview(data);
    if (!silent) message.success(`转换完成：${data.nodes} 个节点`);
  } catch (e) {
    state.preview = { ...state.preview, loading: false, error: e.message || '转换失败' };
    if (e.status === 401) message.warning('登录已失效，请重新登录后再转换');
    else if (!silent) message.error(e.message || '转换失败');
  } finally {
    convertBusy.value = false;
    state.preview.loading = false;
  }
}

let liveTimer = 0;
function pickPreviewTarget(v) {
  if (!v || v === c.value.target) return;
  c.value.target = v;
  schedulePreview(120);
}

function schedulePreview(delay = 800) {
  if (!c.value.live) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { if (canConvert()) convert(true); }, delay);
}

async function makeLink() {
  if (!canConvert()) { message.warning('请先填写订阅来源'); return; }
  try {
    const data = await api('/api/link', { method: 'POST', body: buildPayload() });
    state.link = data.url;
    message.success('临时链接已生成');
  } catch (e) { message.error(e.message || '生成失败'); }
}

const saveOpen = ref(false);
const editingProfile = ref('');
const saveForm = ref({ name: '', token: '', ttl: null, saveTemplate: false, templateName: '' });
function openSave() {
  if (!auth.value.admin) { message.warning('保存订阅需要管理员登录'); return; }
  saveForm.value = {
    name: editingProfile.value ? saveForm.value.name : '',
    token: editingProfile.value || '',
    ttl: null,
    saveTemplate: !!draft.value && draftDirty.value,
    templateName: draft.value ? `${draft.value.name} 副本` : '',
  };
  saveOpen.value = true;
}
async function saveProfile() {
  try {
    let templateName = buildPayload().template;
    if (saveForm.value.saveTemplate && draft.value) {
      const name = String(saveForm.value.templateName || '').trim().replace(/[^\w.-]/g, '-').slice(0, 64);
      if (!name) { message.warning('请填写新模板名称'); return; }
      if (state.templates.some((t) => t.name === name && name !== draft.value.name)) {
        message.warning(`模板「${name}」已存在，请换一个名称`); return;
      }
      await api('/api/templates', { method: 'POST', body: { name, content: draft.value.ini } });
      templateName = name;
      c.value.template = name;
      tplCache.delete(name);
      await loadState();
      message.success(`已另存为模板「${name}」`);
    }
    const payload = {
      name: saveForm.value.name || '未命名订阅',
      token: saveForm.value.token || undefined,
      template: templateName,
      target: c.value.target,
      sources: sourceRows.value.filter((r) => r.type === 'url').flatMap(sourceText),
      nodes: c.value.nodes,
      rulesets: buildPayload().rulesetIds || [],
      include: c.value.include,
      exclude: c.value.exclude,
      opts: c.value.opts,
      cacheTtl: saveForm.value.ttl,
    };
    const out = await api(editingProfile.value ? `/api/profiles/${encodeURIComponent(editingProfile.value)}` : '/api/profiles', {
      method: editingProfile.value ? 'PUT' : 'POST', body: payload,
    });
    if (out.profile && out.profile.token) editingProfile.value = out.profile.token;
    saveOpen.value = false;
    message.success(editingProfile.value ? '订阅已更新' : '订阅已保存，可在「订阅」页复制链接');
  } catch (e) { message.error(e.message || '保存失败'); }
}
async function loadProfileFromQuery() {
  const hashQuery = (location.hash.split('?')[1] || '');
  const token = new URLSearchParams(hashQuery).get('profile') || new URLSearchParams(location.search).get('profile');
  if (!token) return;
  try {
    const data = await api('/api/profiles');
    const p = (data.profiles || []).find((x) => x.token === token);
    if (!p) { message.warning('没有找到要编辑的订阅'); return; }
    editingProfile.value = token;
    c.value.sources = (p.sources || []).join('\n');
    c.value.nodes = p.nodes || [];
    c.value.include = p.include || '';
    c.value.exclude = p.exclude || '';
    c.value.opts = { ...c.value.opts, ...(p.opts || {}) };
    if (p.template) c.value.template = p.template;
    c.value.baseId = p.baseId || '';
    c.value.dnsId = p.dnsId || '';
    c.value.rules = (p.rulesets || []).map((r) => ({
      id: r.id, group: r.group, name: r.name || r.id, noResolve: !!r.noResolve, tags: r.tags || [],
    }));
    sourceRows.value = [{
      ...blankSource('url'), name: '订阅源', value: (p.sources || []).join('\n'),
      status: (p.nodes && p.nodes.length) ? 'ok' : '', count: (p.nodes || []).length,
    }];
    syncLegacy();
    saveForm.value = { ...saveForm.value, name: p.name || '' };
    activePane.value = 'import';
    mode.value = 'advanced';
    message.success(`正在编辑订阅「${p.name}」`);
    await loadDraft(true);
    schedulePreview(200);
  } catch (e) {
    message.error(e.message || '加载订阅失败');
  }
}

async function copyLink() {
  if (!state.link) return;
  try { await navigator.clipboard.writeText(state.link); message.success('链接已复制'); }
  catch { message.error('复制失败'); }
}

/* ── 生命周期 ── */
watch(() => c.value.template, async (name) => {
  c.value.draft = null;
  await loadDraft();
  schedulePreview(300);
});
watch(() => [c.value.baseId, c.value.dnsId, c.value.target, c.value.include, c.value.exclude, c.value.opts.emoji, c.value.opts.udp], () => schedulePreview(400));
watch(() => [c.value.nodes.length, c.value.rules.length, c.value.rules.map((r) => r.group).join('|')], () => schedulePreview(400));
onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  restoreLocal();
  const params = new URLSearchParams(location.search);
  if (params.get('t')) c.value.target = params.get('t');
  if (params.get('s')) { sourceRows.value = [{ ...blankSource('url'), name: '订阅源', value: params.get('s') }]; syncLegacy(); }
  if (params.get('template')) c.value.template = params.get('template');
  const hp = new URLSearchParams((location.hash.split('?')[1] || ''));
  if (hp.get('pane')) activePane.value = hp.get('pane');
  await loadDraft();
  await loadProfileFromQuery();
  if (hp.get('new') === 'rule') setTimeout(() => openRuleDialog('inline'), 400);
  if (params.get('s') && params.get('auto') !== '0') setTimeout(() => convert(true), 300);
});
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

const templateOptions = computed(() => state.templates.map((t) => ({ label: `${t.title || t.name}（${t.name}）`, value: t.name })));
const baseOptions = computed(() => [{ label: '基础：模板自带', value: '' }].concat(state.library.bases.map((b) => ({ label: `${b.name} · ${b.format}`, value: b.id }))));
const dnsOptions = computed(() => [{ label: 'DNS：模板自带', value: '' }].concat(state.library.dns.map((d) => ({ label: `${d.name} · ${d.format}`, value: d.id }))));
const targetLabel = computed(() => (targetById(c.value.target) || {}).label || c.value.target);
const tplInfo = computed(() => (state.templates || []).find((t) => t.name === c.value.template) || null);
const todayLabel = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const tplMeta = computed(() => {
  const model = draft.value && draft.value.model;
  return {
    groups: model ? (model.groups || []).length : null,
    rules: model ? (model.rules || []).length : null,
    total: (state.templates || []).length,
  };
});
const targetGroups = computed(() => {
  const list = state.targets || [];
  return [
    { id: 'popular', label: '常用', items: list.filter((t) => ['mihomo', 'singbox', 'stash', 'surge', 'loon'].includes(t.id)) },
    { id: 'other', label: '其它', items: list.filter((t) => !['mihomo', 'singbox', 'stash', 'surge', 'loon'].includes(t.id)) },
  ].filter((g) => g.items.length);
});
</script>

<template>
  <div class="page convert-page">
    <div class="convert-shell">
      <!-- ═══ 左：配置生成器 ═══ -->
      <section class="work-panel config-panel">
        <header class="work-head cfg-head">
          <span class="cfg-ico">⚙</span>
          <b>配置生成器</b>
          <span class="cfg-badge">
            编辑中 · {{ (tplInfo && (tplInfo.title || tplInfo.name)) || c.template || '未选择' }}
            <i>{{ todayLabel }}</i>
          </span>
          <span v-if="editingProfile" class="cfg-badge edit">订阅编辑模式</span>
          <span style="margin-left: auto" />
          <div class="seg seg-xs">
            <button type="button" class="seg-btn" :class="{ active: mode === 'quick' }" @click="mode = 'quick'">快捷模式</button>
            <button type="button" class="seg-btn" :class="{ active: mode === 'advanced' }" @click="mode = 'advanced'">高级模式</button>
          </div>
        </header>

        <div class="cfg-main">
          <!-- 侧边栏 -->
          <nav v-if="mode !== 'quick'" class="cfg-nav">
            <button
              v-for="p in panes" :key="p.id" type="button" class="cfg-nav-item"
              :class="{ active: activePane === p.id }" @click="goPane(p.id)"
            >
              <span class="cfg-nav-ico">{{ p.icon }}</span>
              <span class="cfg-nav-txt"><b>{{ p.label }}</b><i>{{ p.desc }}</i></span>
              <em v-if="p.badge">{{ p.badge }}</em>
            </button>
          </nav>

          <!-- 内容区 -->
          <div class="cfg-pane">
            <div class="cfg-pane-head">
              <b>{{ (panes.find((p) => p.id === activePane) || {}).label }}</b>
              <span>{{ (panes.find((p) => p.id === activePane) || {}).desc }}</span>
              <span style="margin-left: auto" />
              <span v-if="activePane === 'template' && tplMeta.groups !== null" class="hint">{{ tplMeta.groups }} 组 · {{ tplMeta.rules }} 规则</span>
              <span v-if="activePane === 'nodes' && c.nodes.length" class="hint">已解析 {{ c.nodes.length }} 个</span>
            </div>

            <div class="cfg-pane-body">
              <!-- ① 节点导入 -->
              <div v-show="activePane === 'import'" class="pane-sec">
                <div class="src-list">
                  <div v-for="row in sourceRows" :key="row.id" class="src-row">
                    <div class="src-head">
                      <n-select v-model:value="row.type" size="tiny" :options="SRC_TYPES" style="width: 100px" />
                      <n-input v-model:value="row.name" size="tiny" placeholder="来源名称（可选）" style="width: 156px" />
                      <n-tag v-if="row.status === 'ok'" size="tiny" type="success" :bordered="false">{{ row.count }} 节点</n-tag>
                      <n-tag v-else-if="row.status === 'loading'" size="tiny" :bordered="false">解析中…</n-tag>
                      <n-tag v-else-if="row.status === 'err'" size="tiny" type="error" :bordered="false">失败</n-tag>
                      <span style="margin-left: auto" />
                      <n-button size="tiny" :loading="row.status === 'loading'" @click="parseSource(row)">解析</n-button>
                      <n-button size="tiny" quaternary type="error" @click="removeSource(row)">删除</n-button>
                    </div>
                    <n-input
                      v-model:value="row.value" type="textarea" :rows="3"
                      :placeholder="row.type === 'url' ? '每行一个订阅链接（明文 / Base64 / Clash YAML / sing-box JSON）' : row.type === 'links' ? 'ss:// / vmess:// / trojan:// / vless:// / hysteria2:// / tuic:// …' : '粘贴 Clash / mihomo YAML 或 sing-box JSON 配置内容'"
                    />
                  </div>
                </div>
                <div class="add-src-row">
                  <button type="button" class="add-src" @click="addSource('url')">＋ 订阅链接</button>
                  <button type="button" class="add-src" @click="addSource('links')">＋ 节点链接</button>
                  <button type="button" class="add-src" @click="addSource('config')">＋ 配置文件</button>
                  <button type="button" class="add-src" @click="importFile()">⇪ 导入文件</button>
                </div>
                <input ref="fileInput" type="file" accept=".yaml,.yml,.json,.txt,.js,.conf,.list" style="display: none" @change="onSourceFile">
                <div class="row">
                  <n-button size="small" type="primary" ghost :loading="parseAllBusy" @click="parseAllRows">解析全部</n-button>
                  <span class="hint">导入内容与已解析节点会保存在本机，刷新页面不会丢失；支持多行导入源逐条解析。</span>
                </div>
              </div>

              <!-- ② 模板选择 -->
              <div v-show="mode !== 'quick' && activePane === 'template'" class="pane-sec">
                <n-select v-model:value="c.template" :options="templateOptions" placeholder="选择转换模板" />
                <div class="row"><span class="hint">共 {{ tplMeta.total }} 个模板 · 模板决定策略组与分流规则，可在资源库中管理。</span></div>
                <div class="grid-2">
                  <n-select v-model:value="c.baseId" :options="baseOptions" placeholder="基础配置" />
                  <n-select v-model:value="c.dnsId" :options="dnsOptions" placeholder="DNS 配置" />
                </div>
                <div class="tpl-state">
                  <span v-if="draftDirty" class="cfg-pill warn">模板有未保存改动</span>
                  <span v-else class="cfg-pill muted">模板与服务器一致</span>
                  <n-button size="tiny" quaternary :disabled="!draftDirty" @click="saveDraft">保存模板</n-button>
                  <n-button size="tiny" quaternary :disabled="!draft" @click="resetDraft">恢复</n-button>
                </div>
                <div v-if="draftBackup" class="draft-backup">
                  <span>本机有未保存草稿（{{ new Date(draftBackup.at).toLocaleString('zh-CN') }}）</span>
                  <n-button size="tiny" type="primary" secondary @click="restoreDraftBackup">恢复草稿</n-button>
                  <n-button size="tiny" quaternary @click="clearDraftBackup()">忽略</n-button>
                </div>
                <div class="hint" style="line-height: 1.7">
                  修改策略组后，可直接「生成配置」预览；如需写入模板，点「保存模板」。修改模板后保存订阅会询问是否另存为新模板。
                </div>
              </div>

              <!-- ③ 节点管理 -->
              <div v-show="mode !== 'quick' && activePane === 'nodes'" class="pane-sec">
                <div class="node-toolbar">
                  <n-input v-model:value="nodeQ" size="small" clearable placeholder="搜索节点…" style="max-width: 190px">
                    <template #prefix><span class="hint">⌕</span></template>
                  </n-input>
                  <n-select v-model:value="protoFilter" size="small" clearable placeholder="全部协议" style="width: 118px" :options="protoStats.map(([t, num]) => ({ label: `${String(t).toUpperCase()} ${num}`, value: t }))" />
                  <n-select v-model:value="srcFilter" size="small" clearable placeholder="全部来源" style="width: 132px" :options="srcOptions" />
                  <span style="margin-left: auto" />
                  <n-button size="tiny" quaternary @click="openAuto">自动处理 ▾</n-button>
                  <n-button size="tiny" :disabled="!c.nodes.length" @click="toggleBatch">{{ batch.on ? '退出批量' : '批量编辑' }}</n-button>
                  <n-button size="tiny" quaternary @click="addNode">＋ 添加</n-button>
                </div>

                <div v-if="batch.on" class="batch-bar">
                  <n-checkbox
                    :checked="batch.sel.length === filteredNodes.length && filteredNodes.length > 0"
                    :indeterminate="batch.sel.length > 0 && batch.sel.length < filteredNodes.length"
                    @update:checked="batchAll"
                  >全选</n-checkbox>
                  <span class="hint">已选 {{ batch.sel.length }} / {{ filteredNodes.length }}</span>
                  <n-button size="tiny" :disabled="!batch.sel.length" @click="openBatch">批量改名</n-button>
                  <n-button size="tiny" type="error" ghost :disabled="!batch.sel.length" @click="batchDelete">删除所选</n-button>
                </div>

                <div v-if="!c.nodes.length" class="cfg-empty">解析导入源后，节点会出现在这里。也可以直接点「＋ 添加」手动创建。</div>
                <div v-else class="node-list">
                  <div v-for="{ n, i } in filteredNodes" :key="i" class="nrow" :data-proto="String(n.type || '').toLowerCase()" :class="{ sel: batch.on && batch.sel.includes(i) }">
                    <n-checkbox v-if="batch.on" :checked="batch.sel.includes(i)" @update:checked="toggleNodeSel(i)" />
                    <span class="nbadge" :data-proto="String(n.type || '').toLowerCase()">{{ String(n.type || '').toUpperCase() }}</span>
                    <span v-if="n.icon" class="node-icon">
                      <img v-if="String(iconOf(n.icon)).startsWith('data:')" :src="iconOf(n.icon)" alt="">
                      <template v-else>{{ iconOf(n.icon) }}</template>
                    </span>
                    <b class="nname">{{ n.name }}</b>
                    <span v-if="n._src" class="nsrc">{{ n._src }}</span>
                    <span class="naddr mono">{{ n.server }}:{{ n.port }}</span>
                    <span style="margin-left: auto" />
                    <span class="norder-wrap">
                      <span class="hint">顺序</span>
                      <n-input-number :value="i + 1" size="tiny" :min="1" :max="c.nodes.length" style="width: 92px" @update:value="(v) => setNodeOrder(i, v)" />
                    </span>
                    <n-button size="tiny" quaternary @click="editNode(i)">编辑</n-button>
                    <n-button size="tiny" quaternary type="error" @click="delNode(i)">删除</n-button>
                  </div>
                  <div v-if="!filteredNodes.length" class="hint" style="padding: 8px">没有匹配的节点。</div>
                </div>

                <div class="grid-2">
                  <n-input v-model:value="c.include" size="small" placeholder="仅保留：香港,日本" />
                  <n-input v-model:value="c.exclude" size="small" placeholder="排除：过期,剩余" />
                </div>
                <div class="node-opts">
                  <n-checkbox v-model:checked="c.opts.emoji">节点名 Emoji</n-checkbox>
                  <n-checkbox v-model:checked="c.opts.udp">开启 UDP</n-checkbox>
                  <n-checkbox v-model:checked="c.opts.tfo">TCP Fast Open</n-checkbox>
                  <n-checkbox v-model:checked="c.opts.scv">跳过证书校验</n-checkbox>
                  <n-checkbox v-model:checked="c.opts.sort">按名称排序</n-checkbox>
                </div>
              </div>

              <!-- ④ 中转代理组 -->
              <div v-show="mode !== 'quick' && activePane === 'relay'" class="pane-sec">
                <div class="row">
                  <span class="hint">中转组用于「前置 → 落地」的链式代理；按成员顺序串联，至少 2 个成员。</span>
                  <span style="margin-left: auto" />
                  <n-button v-if="can('templates:write')" size="tiny" quaternary @click="addRelayGroup">＋ 添加中转组</n-button>
                </div>
                <div v-if="!relayGroups.length" class="cfg-empty">还没有中转组。点「添加中转组」创建，随后选择节点顺序即可。</div>
                <GroupRow
                  v-for="row in relayGroups" :key="row.g.name"
                  :group="row.g" :index="row.i" :total="groupTotal" :rules="groupRules(row.g)"
                  :can-write="can('templates:write')" :expanded="expandedGroups.has(row.g.name)" color="#0ea5e9"
                  @toggle="toggleGroup(row.g.name)"
                  @edit="openGroupDialog(row.i)"
            @dragstart="groupDragStart(row.i, $event)"
            @drop="groupDrop(row.i)"
                  @type="(v) => setGroupType(row.g, v)"
                  @enabled="(v) => { row.g.enabled = v; touchDraft(); }"
                  @move="(d) => moveGroup(row.i, d)"
                  @remove="delGroup(row.i)"
                  @pick-members="pickMembers(row.i)"
                  @remove-member="(m) => removeMember(row.g, m)"
                  @add-rule="openGroupRules(row.g)"
                  @remove-rule="removeGroupRule"
                />
              </div>

              <!-- ⑤ 分流代理组 -->
              <div v-show="mode !== 'quick' && activePane === 'groups'" class="pane-sec">
                <div class="ruleset-row">
                  <n-input v-model:value="quickRulesetUrl" size="small" placeholder="规则集 URL，例如 https://…/meta/geo" />
                  <n-select v-model:value="quickTarget" size="small" :options="groupOptions" placeholder="加入分组" style="width: 138px" />
                  <n-button size="small" :disabled="!quickRulesetUrl.trim()" @click="addQuickRuleset">加入</n-button>
                  <button type="button" class="adv-link" @click="goLibraryRulesets">管理规则集 ↗</button>
                </div>
                <div class="group-tools">
                  <n-button v-if="can('templates:write')" size="tiny" quaternary :disabled="!draft" @click="openNewPicker">＋ 新建</n-button>
                  <n-button v-if="can('templates:write')" size="tiny" quaternary type="warning" :disabled="!draft" @click="clearPresetGroups">清空预设分组</n-button>
                  <n-button v-if="can('templates:write')" size="tiny" quaternary :disabled="!draftDirty" @click="saveDraft">保存模板</n-button>
                  <n-button size="tiny" quaternary :disabled="!draft" @click="resetDraft">恢复</n-button>
                  <span v-if="draftDirty" class="hint">改动写回当前模板，右侧预览会自动刷新</span>
                </div>
                <div class="test-url-row">
                  <span class="test-url-label">测速地址</span>
                  <n-select
                    v-model:value="testUrlPreset" size="tiny" style="width: 168px"
                    :options="[...TEST_URL_PRESETS, { label: '自定义…', value: 'custom' }]"
                  />
                  <n-input v-model:value="testUrl" size="tiny" placeholder="https://…/generate_204" style="flex: 1; min-width: 200px" />
                  <n-button size="tiny" :disabled="!can('templates:write')" @click="applyTestUrl">应用到自动测速组</n-button>
                </div>
                <div v-if="!can('templates:write')" class="cfg-empty">登录有「模板编辑」权限的账号后，可在这里调整策略组。</div>
                <n-spin :show="!draft && can('templates:write')">
                  <div v-if="!draft" class="cfg-empty">{{ can('templates:write') ? '正在加载模板…' : '策略组只读：右侧可视化预览可查看分组结构。' }}</div>
                  <div v-else class="gcat-list">
                    <div v-for="cat in groupCats" :key="cat.id" class="gcat">
                      <button type="button" class="gcat-head" @click="toggleCatSection(cat.id)">
                        <span class="gcat-chev">{{ catOpen[cat.id] ? '▾' : '▸' }}</span>
                        <span class="gcat-dot" :style="{ background: cat.color }" />
                        <b>{{ cat.title }}</b>
                        <span class="gcat-count">{{ cat.enabled }}/{{ cat.total }}</span>
                      </button>
                      <div v-show="catOpen[cat.id]" class="gcat-body">
                        <GroupRow
                          v-for="row in cat.groups" :key="row.g.name"
                          :group="row.g" :index="row.i" :total="groupTotal" :rules="groupRules(row.g)"
                          :can-write="can('templates:write')" :expanded="expandedGroups.has(row.g.name)" :color="cat.color"
                          @toggle="toggleGroup(row.g.name)"
                          @edit="openGroupDialog(row.i)"
            @dragstart="groupDragStart(row.i, $event)"
            @drop="groupDrop(row.i)"
                          @type="(v) => setGroupType(row.g, v)"
                          @enabled="(v) => { row.g.enabled = v; touchDraft(); }"
                          @move="(d) => moveGroup(row.i, d)"
                          @remove="delGroup(row.i)"
                          @pick-members="pickMembers(row.i)"
                          @remove-member="(m) => removeMember(row.g, m)"
                          @add-rule="openGroupRules(row.g)"
                          @remove-rule="removeGroupRule"
                        />
                      </div>
                    </div>
                  </div>
                </n-spin>
              </div>

              <!-- ⑥ 规则管理 -->
              <div v-show="mode !== 'quick' && activePane === 'rules'" class="pane-sec">
                <div class="rule-sticky">
                  <div class="group-tools">
                    <n-button v-if="can('templates:write')" size="tiny" type="primary" ghost :disabled="!draft" @click="openRuleDialog('lib')">＋ 添加规则集</n-button>
                    <n-button v-if="can('templates:write')" size="tiny" quaternary :disabled="!draft" @click="openRuleDialog('inline')">＋ 添加规则</n-button>
                    <n-button v-if="can('templates:write')" size="tiny" quaternary :disabled="!draftDirty" @click="saveDraft">保存模板</n-button>
                    <n-button size="tiny" quaternary :disabled="!draft" @click="resetDraft">恢复</n-button>
                  </div>
                  <p class="hint">规则按从上到下的顺序匹配，越靠前优先级越高。拖动行或使用上下箭头调整；「保存模板」写入当前模板，仅预览不会影响其它订阅。</p>
                </div>
                <n-spin :show="!draft && can('templates:write')">
                  <div v-if="!draft" class="cfg-empty">{{ can('templates:write') ? '正在加载模板…' : '规则只读：登录有模板编辑权限的账号后可调整。' }}</div>
                  <div v-else class="rule-list">
                    <div
                      v-for="row in draftRules" :key="row.i + '-' + (row.r.type || '') + '-' + (row.r.value || '')"
                      class="rule-item" draggable="true"
                      @dragstart="ruleDrag = row.i" @dragover.prevent @drop="dropDraftRule(row.i)"
                    >
                      <span class="rule-grip">⠿</span>
                      <span class="rule-no">{{ row.i + 1 }}</span>
                      <n-popover trigger="hover" placement="top-start" :show-arrow="false" raw :delay="180" style="padding:0;background:transparent;box-shadow:none;border:none">
                        <template #trigger>
                          <div class="rule-main">
                            <b>{{ ruleLabel(row.r) }}</b>
                            <span v-if="ruleFileName(row.r)" class="rule-file">{{ ruleFileName(row.r) }}</span>
                            <span class="rule-tags">
                              <em v-for="(t, ti) in ruleTags(row.r)" :key="t" class="rtag" :class="'rtag-' + ((ti + row.i) % 6)">{{ t }}</em>
                            </span>
                          </div>
                        </template>
                        <div class="rule-pop">
                          <div class="rule-pop-head">
                            <b>{{ ruleLabel(row.r) }}</b>
                            <span v-if="metaForRule(row.r).source" class="rule-pop-src">{{ metaForRule(row.r).source }}</span>
                          </div>
                          <p v-if="metaForRule(row.r).desc">{{ metaForRule(row.r).desc }}</p>
                          <div v-if="(metaForRule(row.r).tags || []).length" class="rule-pop-tags">
                            <em v-for="(t, ti) in metaForRule(row.r).tags" :key="t" class="rtag" :class="'rtag-' + (ti % 6)">{{ t }}</em>
                          </div>
                        </div>
                      </n-popover>
                      <n-button
                        v-if="row.r.kind === 'url' && !libRuleFor(row.r) && can('library:write')"
                        size="tiny" quaternary class="rule-add-lib" title="加入资源库" @click.stop="addRuleToLibrary(row.r)"
                      >＋库</n-button>
                      <n-select
                        :value="row.r.target" size="tiny" :options="groupOptions" style="width: 132px"
                        @update:value="(v) => setDraftRuleTarget(row.i, v)"
                      />
                      <button type="button" class="rule-op" title="上移" @click="moveDraftRule(row.i, -1)">↑</button>
                      <button type="button" class="rule-op" title="下移" @click="moveDraftRule(row.i, 1)">↓</button>
                      <button type="button" class="rule-op danger" title="删除" @click="removeDraftRule(row.i)">✕</button>
                    </div>
                    <div v-if="!draftRules.length" class="cfg-empty">还没有规则。点上方「添加规则集」引用远程规则，或「添加规则」写一条内联规则。</div>
                  </div>
                </n-spin>
                <div v-if="c.rules && c.rules.length" class="rule-lib">
                  <b>来自规则库的引用（{{ c.rules.length }}）</b>
                  <div class="rule-lib-list">
                    <span v-for="r in c.rules" :key="r.id" class="rule-lib-chip" :title="r.name || r.id">{{ r.name || r.id }} → {{ r.group }}</span>
                  </div>
                  <p class="hint">规则库引用在模板规则之后追加；可在「资源库 → 规则集管理」调整说明与分类。</p>
                </div>
              </div>

              <!-- 快捷模式摘要 -->
              <section v-if="mode === 'quick'" class="quick-sec">
                <div class="quick-head">
                  <span class="quick-ico">⚡</span>
                  <div>
                    <b>一键生成</b>
                    <p class="hint">粘贴订阅后选择客户端即可生成；节点顺序、策略组等细项在高级模式调整。</p>
                  </div>
                </div>
                <div class="quick-stats">
                  <div><b>{{ sourceCount }}</b><span>导入源</span></div>
                  <div><b>{{ c.nodes.length }}</b><span>已解析节点</span></div>
                  <div><b>{{ tplInfo ? (tplInfo.title || tplInfo.name) : '—' }}</b><span>当前模板</span></div>
                  <div><b>{{ targetLabel }}</b><span>输出格式</span></div>
                </div>
                <div class="quick-selects">
            <n-select v-model:value="c.template" size="small" :options="templateOptions" placeholder="转换模板" />
            <n-select v-model:value="c.baseId" size="small" :options="baseOptions" placeholder="基础配置" />
            <n-select v-model:value="c.dnsId" size="small" :options="dnsOptions" placeholder="DNS 配置" />
          </div>
          <div class="quick-actions">
                  <n-button type="primary" :loading="convertBusy" :disabled="!canConvert()" @click="convert()">生成配置</n-button>
                  <n-button quaternary @click="mode = 'advanced'">进入高级模式 →</n-button>
                </div>
              </section>
            </div>
          </div>
        </div>

        <footer class="work-foot cfg-foot">
          <n-button type="primary" :loading="convertBusy" @click="convert(false)">
            <span class="btn-ico">⚡</span> 生成配置
          </n-button>
          <n-button ghost :disabled="!can('templates:write')" @click="pickTemplateFile">
            <span class="btn-ico">⇪</span> 上传模板
          </n-button>
          <input ref="tplInput" type="file" accept=".ini,.txt,.conf" style="display: none" @change="uploadTemplate">
          <n-button class="temp-link-btn" :disabled="!canConvert()" @click="makeLink">临时链接</n-button>
          <span style="margin-left: auto" />
          <n-checkbox v-model:checked="c.live">自动预览</n-checkbox>
        </footer>
      </section>

      <!-- ═══ 右：预览 ═══ -->
      <PreviewPane
        :body="state.preview.body" :target="c.target" :target-label="targetLabel"
        :nodes="state.preview.nodes" :bytes="state.preview.bytes" :ms="state.preview.ms"
        :warnings="state.preview.warnings" :loading="state.preview.loading" :error="state.preview.error"
        :userinfo="state.preview.userinfo || ''"
        :targets="state.targets"
        :group-rules="previewGroupRules"
        @pick-target="pickPreviewTarget"
        @reorder="onPreviewReorder"
        @refresh="convert(false)"
      >
        <template #format>
          <div class="format-row">
            <span class="format-label">输出格式</span>
            <b class="format-target">{{ targetLabel }}</b>
            <span class="format-count">客户端预览、复制与下载均使用此格式</span>
            <span v-if="state.link" class="format-link">
              <span class="mono">{{ state.link }}</span>
              <n-button size="tiny" @click="copyLink">复制</n-button>
            </span>
          </div>
        </template>
        <template #actions>
          <n-button class="act-btn act-download" size="small" @click="downloadOutput">
            <span class="btn-ico">⤓</span> 下载配置
          </n-button>
          <n-button class="act-btn act-save" size="small" @click="openSave">
            保存订阅 <span class="act-arrow">↗</span>
          </n-button>
          <n-button class="act-btn act-exit" size="small" @click="mode = 'quick'">
            退出编辑
          </n-button>
        </template>
      </PreviewPane>
    </div>

    <!-- 批量编辑 -->
    <n-modal v-model:show="batchOpen" preset="card" title="批量编辑节点" style="width: 640px; max-width: 94vw">
      <div class="stack">
        <n-select v-model:value="bx.op" size="small" :options="[
          { label: '查找替换 / 清理名称', value: 'rename' },
          { label: '添加前缀', value: 'prefix' },
          { label: '添加后缀', value: 'suffix' },
          { label: '按协议加前缀', value: 'protocol' },
        ]" />
        <div class="grid-2">
          <n-input v-model:value="bx.include" size="small" placeholder="筛选：包含正则（可选）" />
          <n-input v-model:value="bx.exclude" size="small" placeholder="筛选：排除正则（可选）" />
        </div>
        <template v-if="bx.op === 'rename'">
          <n-input v-model:value="bx.find" size="small" placeholder="查找正则，例如 \s+|\s+" />
          <n-input v-model:value="bx.to" size="small" placeholder="替换为，例如 -（支持 $1）" />
          <div class="row">
            <n-checkbox v-model:checked="bx.trim">去除首尾空格</n-checkbox>
            <n-checkbox v-model:checked="bx.space">空白归一</n-checkbox>
          </div>
        </template>
        <n-input v-else v-model:value="bx.affix" size="small" placeholder="前缀/后缀文本，例如 [HK] " />
        <span class="hint">匹配 {{ batchPlan.length }} · 将修改 {{ batchPlan.filter((p) => p.next !== p.old).length }}</span>
        <div class="mono preview-list">
          <div v-for="p in batchPlan.slice(0, 40)" :key="p.i" class="row" style="gap: 8px">
            <n-tag size="tiny" :type="protoType(c.nodes[p.i] && c.nodes[p.i].type)" :bordered="false">{{ String((c.nodes[p.i] && c.nodes[p.i].type) || '?').toUpperCase() }}</n-tag>
            <span>{{ p.old }} → {{ p.next }}</span>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="batchOpen = false">取消</n-button>
          <n-button type="primary" @click="applyBatch">应用</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 自动处理 -->
    <n-modal v-model:show="autoOpen" preset="card" title="自动处理节点" style="width: 560px; max-width: 94vw">
      <div class="stack">
        <n-checkbox-group v-model:value="autoPicks">
          <div class="stack" style="gap: 6px">
            <n-checkbox v-for="o in autoProcessOptions" :key="o.key" :value="o.key" :label="o.label" />
          </div>
        </n-checkbox-group>
        <span class="hint">按勾选顺序执行；预览最多展示 80 项，确认后写入本机节点。</span>
        <div class="mono preview-list">
          <div v-for="(p, i) in autoPreview" :key="i" class="row" style="gap: 8px">
            <span>{{ p.name }}</span>
            <span class="hint">{{ p.next }}</span>
          </div>
          <span v-if="!autoPreview.length" class="hint">当前选择没有可预览的变化。</span>
        </div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="autoOpen = false">取消</n-button>
          <n-button type="primary" @click="applyAuto">应用处理</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 节点添加/编辑 -->
    <n-modal v-model:show="nodeOpen" preset="card" :title="nodeForm.index >= 0 ? '编辑节点' : '添加节点'" style="width: 540px; max-width: 94vw">
      <div class="stack">
        <div v-if="nodeForm.index < 0" class="seg seg-xs" style="align-self: flex-start">
          <button type="button" class="seg-btn" :class="{ active: nodeMode === 'link' }" @click="nodeMode = 'link'">链接导入</button>
          <button type="button" class="seg-btn" :class="{ active: nodeMode === 'manual' }" @click="nodeMode = 'manual'">手动填写</button>
        </div>
        <div v-if="nodeMode === 'link'" class="stack">
          <n-input v-model:value="nodeLink" type="textarea" :rows="3" placeholder="ss:// / vmess:// / trojan:// / vless:// / hysteria2:// …" />
          <div class="row">
            <n-button size="small" type="primary" ghost :loading="nodeLinkBusy" @click="parseNodeLink">识别并填入</n-button>
            <span class="hint">识别后仍可修改服务器、端口和名称。</span>
          </div>
        </div>
        <template v-else>
          <n-input v-model:value="nodeForm.name" placeholder="节点名称（留空用服务器:端口）" />
          <div class="row">
            <span class="node-icon big">
              <img v-if="String(iconOf(nodeForm.icon)).startsWith('data:')" :src="iconOf(nodeForm.icon)" alt="">
              <template v-else>{{ iconOf(nodeForm.icon) || '·' }}</template>
            </span>
            <n-button size="small" @click="iconPickerOpen = true">选择图标</n-button>
            <n-button v-if="nodeForm.icon" size="small" quaternary @click="nodeForm.icon = ''">清除</n-button>
            <span class="hint">图标只用于界面展示，不会写入客户端配置。</span>
          </div>
          <div class="grid-2">
            <n-select v-model:value="nodeForm.type" :options="PROTOCOLS.map((p) => ({ label: p, value: p }))" filterable tag placeholder="协议" />
            <n-input v-model:value="nodeForm.port" placeholder="端口" />
          </div>
          <n-input v-model:value="nodeForm.server" placeholder="服务器地址 / 域名 / IP" />
          <div class="grid-2">
            <n-input v-model:value="nodeForm.password" placeholder="密码 / 认证口令" />
            <n-input v-model:value="nodeForm.uuid" placeholder="UUID（vmess / vless）" />
          </div>
          <div class="grid-2">
            <n-select v-model:value="nodeForm.cipher" :options="['aes-128-gcm','aes-256-gcm','chacha20-ietf-poly1305','2022-blake3-aes-128-gcm','2022-blake3-aes-256-gcm'].map((c) => ({ label: c, value: c }))" filterable tag placeholder="加密方式（ss）" />
            <n-input v-model:value="nodeForm.sni" placeholder="SNI / 伪装域名（可选）" />
          </div>
          <n-checkbox v-model:checked="nodeForm.tls">启用 TLS</n-checkbox>
          <span class="hint">手动填写的凭据会写入生成配置；如只填名称/服务器，客户端可能无法连接。</span>
        </template>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end"><n-button @click="nodeOpen = false">取消</n-button><n-button type="primary" @click="saveNode">保存</n-button></div>
      </template>
    </n-modal>

    <!-- 新建 / 编辑分组 -->
    <n-modal v-model:show="groupDlgOpen" preset="card" :title="groupEditIndex >= 0 ? '编辑分组' : '新建分组'" style="width: 580px; max-width: 94vw">
      <div class="stack">
        <n-input v-model:value="groupForm.name" placeholder="分组名称，例如「流媒体」「AI 服务」" />
        <div class="grid-2">
          <n-select v-model:value="groupForm.type" :options="[
            { label: '手动选择', value: 'select' },
            { label: '自动测速', value: 'url-test' },
            { label: '故障转移', value: 'fallback' },
            { label: '负载均衡', value: 'load-balance' },
            { label: '中转链（按顺序串联）', value: 'relay' },
          ]" />
          <div class="row"><n-checkbox v-model:checked="groupForm.enabled">启用该分组</n-checkbox></div>
        </div>
        <n-select
          v-model:value="groupForm.members" multiple filterable tag
          :options="groupMemberOptions" placeholder="添加成员：节点 / 其它策略组 / DIRECT / REJECT（至少 1 个）"
        />
        <div class="row">
          <n-select
            v-model:value="groupForm.cat" clearable style="flex: 1"
            :options="CATS.map((c) => ({ label: c.title, value: c.id }))"
            placeholder="分类（留空自动识别）"
          />
          <n-button size="small" quaternary @click="catMgrOpen = true">分类管理</n-button>
        </div>
        <n-input v-model:value="groupForm.ruleUrl" placeholder="可选：给该分组加一条远程规则集 URL" />
        <span class="hint">确认后写入当前模板；创建后仍可点分组名右侧 ✎ 修改名称、类型、成员与规则。</span>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end">
          <n-button @click="groupDlgOpen = false">取消</n-button>
          <n-button type="primary" @click="confirmGroupDialog">{{ groupEditIndex >= 0 ? '保存修改' : '确认加入' }}</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="newPickOpen" preset="card" title="新建" style="width: 480px; max-width: 94vw">
      <div class="new-pick">
        <button type="button" class="new-card" @click="pickNewCategory">
          <span class="new-ico">▦</span>
          <b>新建分类</b>
          <p>用于折叠与配色，例如「AI 服务」「流媒体」。分类下可放多个策略组。</p>
        </button>
        <button type="button" class="new-card" @click="pickNewGroup">
          <span class="new-ico">◎</span>
          <b>新建策略组</b>
          <p>命名、选择类型、添加成员与规则，确认后写入当前模板草稿。</p>
        </button>
      </div>
    </n-modal>

    <n-modal v-model:show="catMgrOpen" preset="card" title="策略组分类" style="width: 520px; max-width: 94vw">
      <div class="stack">
        <p class="hint">分类用于策略组面板折叠与预览配色；内置分类固定，自定义分类可删除。</p>
        <div class="cat-mgr-list">
          <div v-for="c in CATS" :key="c.id" class="cat-mgr-row">
            <span class="cat-mgr-dot" :style="{ background: c.color }" />
            <b>{{ c.title }}</b>
            <n-tag size="tiny" round :bordered="false">{{ c.id }}</n-tag>
            <span style="margin-left: auto" />
            <n-button v-if="customCats.some((x) => x.id === c.id)" size="tiny" quaternary type="error" @click="removeCategory(c.id)">删除</n-button>
          </div>
        </div>
        <div class="row">
          <n-input v-model:value="catNew.title" size="small" placeholder="新分类名称，如「AI 服务」" style="flex: 1" />
          <n-color-picker v-model:value="catNew.color" :show-alpha="false" :modes="['hex']" style="width: 46px" />
          <n-button size="small" type="primary" @click="addCategory">添加</n-button>
        </div>
      </div>
    </n-modal>

    <n-modal v-model:show="memberOpen" preset="card" :title="`选择成员 · ${currentGroupName() || '策略组'}`" style="width: 720px; max-width: 94vw">
      <div class="stack">
        <div class="row">
          <n-input v-model:value="memberQ" size="small" placeholder="搜索节点或分组…" style="max-width: 280px" clearable />
          <n-tag size="small" round :bordered="false" type="info">已选 {{ memberSel.length }}</n-tag>
          <span style="margin-left: auto" />
          <n-button size="tiny" quaternary @click="memberSel = []">清空</n-button>
        </div>
        <div v-if="memberSel.length" class="chip-wrap" style="min-height: 28px">
          <n-tag v-for="m in memberSel" :key="m" size="small" round closable @close="memberSel = memberSel.filter((x) => x !== m)">{{ m }}</n-tag>
        </div>
        <n-checkbox-group v-model:value="memberSel">
          <div class="pick-grid">
            <div v-for="grp in memberOptions" :key="grp.key" class="mini-card">
              <div class="mini-head"><b>{{ grp.label }}</b><n-tag size="tiny" :bordered="false">{{ grp.options.length }}</n-tag></div>
              <div class="pick-list">
                <n-checkbox v-for="o in grp.options" :key="o.value" :value="o.value" :label="o.label" />
              </div>
            </div>
          </div>
        </n-checkbox-group>
        <div v-if="!memberOptions.length" class="hint">没有可选的节点或分组：先解析节点，或新建策略组。</div>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end"><n-button @click="memberOpen = false">取消</n-button><n-button type="primary" @click="applyMembers">应用</n-button></div>
      </template>
    </n-modal>

    <n-modal v-model:show="ruleDlgOpen" preset="card" title="添加规则" style="width: 620px; max-width: 94vw">
      <div class="stack">
        <n-select v-model:value="ruleDlg.target" :options="groupOptions" filterable placeholder="目标策略组" />
        <n-tabs v-model:value="ruleDlg.mode" type="segment" size="small">
          <n-tab-pane name="lib" tab="资源库规则集">
            <n-select
              v-model:value="ruleDlg.url" :options="ruleLibOptions" filterable clearable remote
              :loading="libSearching" @search="searchRuleCatalog"
              placeholder="搜索全部规则集：资源库 + 官方目录（名称 / 分类 / 中文）"
            />
            <p class="hint" style="margin-top: 8px">输入关键词可搜索 2183 条官方目录与本地资源库；选中后按 URL 引用。</p>
          </n-tab-pane>
          <n-tab-pane name="inline" tab="手写规则">
            <div class="stack">
              <n-select v-model:value="ruleDlg.type" :options="RULE_TYPE_OPTIONS" />
              <n-input v-model:value="ruleDlg.value" placeholder="规则值，如 google.com 或 10.0.0.0/8" />
              <div class="row" style="gap: 8px; align-items: center">
                <input ref="ruleFileInput" type="file" accept=".list,.txt,.conf,.yaml,.yml" hidden @change="onRuleFile" />
                <n-button size="small" quaternary @click="ruleFileInput && ruleFileInput.click()">导入规则文件</n-button>
                <span class="hint">支持 DOMAIN-SUFFIX,google.com 这类每行一条的文本</span>
              </div>
            </div>
          </n-tab-pane>
          <n-tab-pane name="url" tab="远程地址">
            <n-input v-model:value="ruleDlg.url" placeholder="https://…/rules.mrs、.srs、.yaml、.list" />
            <p class="hint" style="margin-top: 8px">远程规则集不会写入资源库；需要长期管理可添加后再用「＋库」收录。</p>
          </n-tab-pane>
        </n-tabs>
        <n-checkbox v-model:checked="ruleDlg.persist">同时保存到当前模板（否则仅本次配置预览生效）</n-checkbox>
        <p class="hint">规则按列表顺序匹配；添加后可在「规则管理」中拖动排序或修改目标组。</p>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end"><n-button @click="ruleDlgOpen = false">取消</n-button><n-button type="primary" @click="confirmRuleDialog">加入</n-button></div>
      </template>
    </n-modal>

    <n-modal v-model:show="customOpen" preset="card" title="手动添加规则" style="width: 520px; max-width: 94vw">
      <div class="stack">
        <n-select v-model:value="customForm.type" :options="RULE_TYPE_OPTIONS" />
        <n-input v-model:value="customForm.value" placeholder="规则值，如 google.com 或 10.0.0.0/8" />
        <n-select v-model:value="customForm.group" :options="groupOptions" filterable tag />
        <n-checkbox v-model:checked="customForm.noResolve">no-resolve</n-checkbox>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end"><n-button @click="customOpen = false">取消</n-button><n-button type="primary" @click="addCustomRule">添加</n-button></div>
      </template>
    </n-modal>

    <n-modal v-model:show="groupRuleOpen" preset="card" :title="`添加规则 · ${groupRuleGroup}`" style="width: 780px; max-width: 94vw">
      <n-tabs v-model:value="groupRuleMode" type="segment" size="small">
        <n-tab-pane name="catalog" tab="官方规则集">
          <div class="row" style="gap: 8px; margin-bottom: 10px">
            <n-select
              v-model:value="groupUrl" :options="ruleLibOptions" filterable clearable remote style="flex: 1"
              :loading="libSearching" @search="searchRuleCatalog" @focus="searchRuleCatalog('')"
              placeholder="搜索资源库 / 官方目录中的规则集"
            />
            <n-button size="small" type="primary" ghost :disabled="!groupUrl" @click="addUrlRuleToGroup">加入</n-button>
          </div>
          <n-input
            :value="groupRuleQ"
            placeholder="搜索官方规则集，支持中文名（广告 / 谷歌 / 流媒体…）"
            clearable
            @update:value="searchGroupRules"
          />
          <div class="rule-results" style="margin-top: 10px; max-height: 300px; overflow: auto">
            <div v-for="it in groupRuleItems" :key="it.id" class="rule-result">
              <div class="rule-main">
                <b>{{ it.zh || it.label || it.name }}</b>
                <span class="hint">{{ it.group }} · {{ it.kind === 'geoip' ? 'IP' : '域名' }} · {{ it.cnt || 0 }} 条</span>
                <div v-if="it.tags && it.tags.length" class="chip-wrap" style="margin-top: 4px">
                  <n-tag v-for="t in it.tags" :key="t" size="tiny" :bordered="false">{{ t }}</n-tag>
                </div>
              </div>
              <n-button size="tiny" type="primary" ghost @click="addCatalogRule(it)">加入</n-button>
            </div>
            <span v-if="!groupRuleItems.length" class="hint">输入关键词搜索，选中后加入「{{ groupRuleGroup }}」。</span>
          </div>
        </n-tab-pane>
        <n-tab-pane name="inline" tab="手写规则">
          <div class="stack">
            <n-select v-model:value="groupInline.type" :options="RULE_TYPE_OPTIONS" />
            <n-input v-model:value="groupInline.value" placeholder="规则值，如 google.com 或 10.0.0.0/8" />
            <div class="row">
              <n-checkbox v-model:checked="groupInline.noResolve">no-resolve</n-checkbox>
              <span class="hint">写入当前模板，保存模板或直接转换时生效。</span>
            </div>
            <div class="row"><n-button type="primary" @click="addInlineRuleToGroup">加入规则</n-button></div>
          </div>
        </n-tab-pane>
        <n-tab-pane name="url" tab="远程地址">
          <div class="stack">
            <n-input v-model:value="groupUrl" placeholder="https://example.com/rules.list 或 .yaml / .mrs / .srs" />
            <span class="hint">远程规则集由转换引擎抓取；mihomo / sing-box 会作为原生 rule-provider / rule_set 输出。</span>
            <div class="row"><n-button type="primary" @click="addUrlRuleToGroup">加入规则</n-button></div>
          </div>
        </n-tab-pane>
      </n-tabs>
      <template #footer>
        <div class="row" style="justify-content: flex-end"><n-button @click="groupRuleOpen = false">完成</n-button></div>
      </template>
    </n-modal>

    <IconPicker v-model:show="iconPickerOpen" v-model:value="nodeForm.icon" title="选择节点图标" />

    <n-modal v-model:show="saveOpen" preset="card" :title="editingProfile ? '保存订阅修改' : '保存为订阅'" style="width: 480px; max-width: 94vw">
      <div class="stack">
        <n-input v-model:value="saveForm.name" placeholder="订阅名称" />
        <n-input v-model:value="saveForm.token" placeholder="自定义 token（可选，留空自动生成）" />
        <div v-if="draftDirty" class="save-tpl">
          <n-checkbox v-model:checked="saveForm.saveTemplate">模板有修改，另存为新模板</n-checkbox>
          <n-input v-if="saveForm.saveTemplate" v-model:value="saveForm.templateName" size="small" placeholder="新模板名称" />
          <span class="hint">不另存时，订阅仍引用当前模板；模板改动会随模板保存影响其它订阅。</span>
        </div>
        <span class="hint">保存后可在「订阅」页获取各客户端链接。</span>
      </div>
      <template #footer>
        <div class="row" style="justify-content: flex-end"><n-button @click="saveOpen = false">取消</n-button><n-button type="primary" @click="saveProfile">{{ editingProfile ? '保存修改' : '保存' }}</n-button></div>
      </template>
    </n-modal>
  </div>
</template>








