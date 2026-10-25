<script setup>
import { computed, ref, watch } from 'vue';
import { NButton, NModal, NSelect, NSpin, useMessage } from 'naive-ui';
import { state } from '../state.js';

const props = defineProps({
  body: { type: String, default: '' },
  target: { type: String, default: '' },
  nodes: { type: Number, default: 0 },
  bytes: { type: Number, default: 0 },
  ms: { type: Number, default: 0 },
  warnings: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  targetLabel: { type: String, default: '' },
  userinfo: { type: String, default: '' },
  targets: { type: Array, default: () => [] },
  groupRules: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['refresh', 'pick-target', 'reorder']);
const message = useMessage();
const dragName = ref('');
const dragOver = ref('');

const view = ref(localStorage.getItem('subhub.previewView') === 'visual' ? 'visual' : 'yaml');
watch(view, (v) => { try { localStorage.setItem('subhub.previewView', v); } catch { /* 无痕模式 */ } });

/* ── 代码配色（明暗各一套，随站点主题自动匹配） ── */
const THEMES = [
  { id: 'midnight', label: 'Midnight', mode: 'dark', dot: '#8ab4ff', bg: '#0f1420' },
  { id: 'aurora', label: 'Aurora', mode: 'dark', dot: '#7dd3fc', bg: '#0d1626' },
  { id: 'nord', label: 'Nord', mode: 'dark', dot: '#88c0d0', bg: '#2e3440' },
  { id: 'dracula', label: 'Dracula', mode: 'dark', dot: '#ff79c6', bg: '#282a36' },
  { id: 'monokai', label: 'Monokai', mode: 'dark', dot: '#a6e22e', bg: '#272822' },
  { id: 'ocean', label: 'Ocean', mode: 'dark', dot: '#22d3ee', bg: '#072a3d' },
  { id: 'github', label: 'GitHub Light', mode: 'light', dot: '#0969da', bg: '#f6f8fa' },
  { id: 'solarized', label: 'Solarized Light', mode: 'light', dot: '#b58900', bg: '#fdf6e3' },
  { id: 'paper', label: 'Paper', mode: 'light', dot: '#0f766e', bg: '#f7f4ec' },
  { id: 'onedark', label: 'One Dark Pro', mode: 'dark', dot: '#61afef', bg: '#282c34' },
];
const themeOpen = ref(false);
const themeDraft = ref('');
const savedTheme = ref('');
const themeMode = computed(() => (state.theme === 'dark' ? 'dark' : 'light'));
function defaultTheme() {
  return themeMode.value === 'dark' ? 'midnight' : 'github';
}
const themeId = ref(localStorage.getItem(`subhub.codeTheme.${themeMode.value}`) || defaultTheme());
function applyTheme(id, persist = true) {
  themeId.value = id;
  if (persist) {
    try { localStorage.setItem(`subhub.codeTheme.${themeMode.value}`, id); } catch { /* 无痕模式 */ }
  }
}
function openThemePicker() {
  savedTheme.value = themeId.value;
  themeDraft.value = themeId.value;
  themeOpen.value = true;
}
function previewTheme(id) {
  themeDraft.value = id;
  themeId.value = id;
}
function confirmTheme() {
  applyTheme(themeDraft.value);
  themeOpen.value = false;
}
function cancelTheme() {
  themeId.value = savedTheme.value;
  themeOpen.value = false;
}
const currentTheme = computed(() => THEMES.find((t) => t.id === themeId.value && t.mode === themeMode.value)
  || THEMES.find((t) => t.mode === themeMode.value)
  || THEMES[0]);
watch(themeMode, () => {
  const saved = localStorage.getItem(`subhub.codeTheme.${themeMode.value}`);
  const candidate = THEMES.find((t) => t.id === saved && t.mode === themeMode.value);
  applyTheme(candidate ? candidate.id : defaultTheme(), false);
}, { immediate: true });
const targetOptions = computed(() => (state.targets || []).map((t) => ({ label: t.label || t.id, value: t.id })));

const MAX_LINES = 1500;
const displayBody = computed(() => {
  const raw = String(props.body || '');
  if (!raw.trim().startsWith('{')) return raw;
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
});
const lines = computed(() => {
  const all = displayBody.value.split('\n');
  return { shown: all.slice(0, MAX_LINES), rest: Math.max(0, all.length - MAX_LINES) };
});

/* 查看逻辑：搜索高亮 + 换行 + 仅看命中 */
const q = ref('');
const wrap = ref(false);
const onlyHit = ref(false);
const hitLines = computed(() => {
  const needle = q.value.trim().toLowerCase();
  if (!needle) return [];
  return lines.value.shown.map((l, i) => (l.toLowerCase().includes(needle) ? i : -1)).filter((i) => i >= 0);
});
const hitSet = computed(() => new Set(hitLines.value));
const hitCursor = ref(0);
watch(q, () => { hitCursor.value = 0; });
function stepHit(d) {
  const n = hitLines.value.length;
  if (!n) return;
  hitCursor.value = (hitCursor.value + d + n) % n;
  const el = document.querySelector(`[data-line="${hitLines.value[hitCursor.value]}"]`);
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
const shownLines = computed(() => {
  if (!q.value.trim() || !onlyHit.value) return lines.value.shown.map((l, i) => ({ l, i }));
  return hitLines.value.map((i) => ({ l: lines.value.shown[i], i }));
});

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function highlight(line) {
  let out = '';
  const re = /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(^[ \t]*-)|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?)|([A-Za-z0-9_.-]+)(?=\s*:)/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    if (m[1]) out += `<span class="syn-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="syn-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="syn-dash">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="syn-bool">${esc(m[4])}</span>`;
    else if (m[5]) out += `<span class="syn-num">${esc(m[5])}</span>`;
    else if (m[6]) out += `<span class="syn-key">${esc(m[6])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(line.slice(last));
  return out || '&nbsp;';
}

/* ── 可视化预览：分类 ── */
const CATS = [
  { id: 'core', label: '核心', color: '#6366f1', re: /节点选择|手动选择|自动选择|故障转移|负载均衡|兜底|DIRECT|REJECT|落地/i },
  { id: 'common', label: '常用', color: '#10b981', re: /谷歌|Google|苹果|Apple|微软|Microsoft|服务|直连|国内|局域网/i },
  { id: 'social', label: '社交', color: '#a855f7', re: /电报|Telegram|推特|社交|Discord|X\b/i },
  { id: 'media', label: '媒体', color: '#f59e0b', re: /奈飞|Netflix|YouTube|油管|流媒体|视频|Spotify|音乐|TikTok/i },
  { id: 'game', label: '游戏', color: '#06b6d4', re: /游戏|Steam|下载|Game/i },
  { id: 'tech', label: '技术', color: '#8b5cf6', re: /AI|OpenAI|Claude|GitHub|技术|开发|编程/i },
  { id: 'pay', label: '支付', color: '#14b8a6', re: /支付|银行|Pay|金融/i },
  { id: 'other', label: '其它', color: '#94a3b8', re: /[\s\S]*/ },
];
function catOf(name) {
  return CATS.find((c) => c.re.test(String(name || ''))) || CATS[CATS.length - 1];
}
function toneOf(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 997;
  return h % 6;
}
const activeCats = ref(CATS.map((c) => c.id));
function toggleCat(id) {
  const set = new Set(activeCats.value);
  if (set.has(id)) set.delete(id); else set.add(id);
  activeCats.value = [...set];
}
const palette = ref(localStorage.getItem('subhub.catPalette') || 'soft');
function togglePalette() {
  palette.value = palette.value === 'soft' ? 'vivid' : 'soft';
  try { localStorage.setItem('subhub.catPalette', palette.value); } catch { /* 无痕模式 */ }
}

const structure = computed(() => {
  const body = String(props.body || '');
  const groups = [];
  const proxies = [];
  const rules = [];
  if (!body.trim()) return { groups, proxies, rules };
  if (props.target === 'singbox' || body.trim().startsWith('{')) {
    try {
      const conf = JSON.parse(body);
      for (const ob of conf.outbounds || []) {
        if (ob.type === 'selector' || ob.type === 'urltest' || /select|urltest|fallback|loadbalance/i.test(ob.type)) {
          groups.push({ name: ob.tag, type: ob.type, members: (ob.outbounds || []).concat(ob.proxies || []) });
        } else if (ob.type && !['direct', 'block', 'dns'].includes(ob.type)) {
          proxies.push({ name: ob.tag, type: ob.type });
        }
      }
      for (const r of (conf.route && conf.route.rules) || []) rules.push(JSON.stringify(r));
    } catch { /* ignore */ }
    return { groups, proxies, rules };
  }
  let section = '';
  let cur = null;
  for (const line of body.split('\n')) {
    if (/^proxy-groups:/.test(line)) { section = 'groups'; cur = null; continue; }
    if (/^proxies:/.test(line)) { section = 'proxies'; cur = null; continue; }
    if (/^rules:/.test(line)) { section = 'rules'; continue; }
    if (/^[A-Za-z]/.test(line)) section = '';
    if (section === 'groups') {
      const m = line.match(/^\s*-\s*name:\s*(.+)$/);
      if (m) { cur = { name: m[1].replace(/^["']|["']$/g, ''), type: '', members: [] }; groups.push(cur); continue; }
      if (!cur) continue;
      const t = line.match(/^\s*type:\s*(.+)$/);
      if (t) cur.type = t[1].trim();
      const mm = line.match(/^\s*-\s*(.+)$/);
      if (mm && !/name:|type:/.test(line)) cur.members.push(mm[1].replace(/^["']|["']$/g, '').trim());
    } else if (section === 'proxies') {
      const m = line.match(/^\s*-\s*\{?\s*name:\s*([^,}]+)/);
      if (m) proxies.push({ name: m[1].replace(/^["']|["']$/g, '').trim(), type: '' });
    } else if (section === 'rules') {
      const m = line.match(/^\s*-\s*(.+)$/);
      if (m) rules.push(m[1]);
    }
  }
  groups.forEach((g) => { if (!g.type) g.type = 'select'; });
  return { groups, proxies, rules };
});

const catCount = computed(() => {
  const map = new Map();
  for (const g of structure.value.groups) {
    const c = catOf(g.name);
    map.set(c.id, (map.get(c.id) || 0) + 1);
  }
  return map;
});

const shownGroups = computed(() => structure.value.groups.filter((g) => activeCats.value.includes(catOf(g.name).id)));
const expanded = ref(new Set());
function toggleGroup(name) {
  const set = new Set(expanded.value);
  if (set.has(name)) set.delete(name); else set.add(name);
  expanded.value = set;
}
function typeLabel(t) {
  return ({ select: '手动选择', 'url-test': '自动测速', fallback: '故障转移', 'load-balance': '负载均衡', relay: '中转链', selector: '手动选择', urltest: '自动测速' })[t] || t || '手动选择';
}
function rulesOf(name) {
  const v = props.groupRules && props.groupRules[name];
  return Array.isArray(v) ? v : [];
}
function startDrag(name, e) {
  dragName.value = name;
  if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', name); } catch { /* ignore */ } }
}
function overDrag(name) { dragOver.value = name; }
function dropDrag(name) {
  const from = dragName.value;
  dragOver.value = '';
  dragName.value = '';
  if (from && from !== name) emit('reorder', { from, to: name });
}
function groupSummary(g) {  const first = g.members[0] || '自动';
  if (/拦截|广告|Block|Reject/i.test(g.name)) return { icon: '⛔', label: '拦截', value: '拒绝' };
  if (g.type === 'relay') return { icon: '🔗', label: '中转链', value: g.members.slice(0, 2).join(' → ') || '—' };
  if (g.type === 'url-test' || g.type === 'urltest') return { icon: '⚡', label: '自动测速', value: first };
  if (g.type === 'fallback') return { icon: '🛟', label: '故障转移', value: first };
  if (g.type === 'load-balance' || g.type === 'loadbalance') return { icon: '⚖️', label: '负载均衡', value: first };
  return { icon: '🎯', label: '手动选择', value: first };
}

const nodeCount = computed(() => props.nodes || structure.value.proxies.length || 0);
const groupCount = computed(() => structure.value.groups.length);
const ruleCount = computed(() => structure.value.rules.length);
const compact = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n >= 1000 ? `${(n / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}k` : String(n));

async function copyAll() {
  try { await navigator.clipboard.writeText(props.body); message.success('已复制配置'); }
  catch { message.error('复制失败，请手动选择'); }
}

const fileName = computed(() => {
  const ext = props.target === 'singbox' ? 'json' : props.target === 'v2ray' || props.target === 'daed' ? 'txt' : 'yaml';
  return `subhub-${props.target || 'config'}.${ext}`;
});
const lineCount = computed(() => displayBody.value.split('\n').length);

function download() {
  const blob = new Blob([props.body], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName.value;
  a.click();
  URL.revokeObjectURL(a.href);
}

const traffic = computed(() => {
  const raw = props.userinfo || '';
  if (!raw) return '';
  const get = (k) => { const m = raw.match(new RegExp(`${k}=(\\d+)`)); return m ? Number(m[1]) : 0; };
  const total = get('total');
  const up = get('upload');
  const down = get('download');
  const expire = get('expire');
  const fmt = (n) => {
    if (!n) return '0';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 10 ? 0 : 1)}${u[i]}`;
  };
  const left = total ? Math.max(0, total - up - down) : 0;
  const date = expire ? new Date(expire * 1000).toLocaleDateString('zh-CN') : '';
  return total ? `剩余 ${fmt(left)} / ${fmt(total)}${date ? ` · ${date} 到期` : ''}` : '';
});
</script>

<template>
  <section class="work-panel preview-panel" :style="{ background: currentTheme.bg }">
    <header class="work-head">
      <span class="panel-dot accent" />
      <b>预览</b>
      <n-select
        v-if="targetOptions.length" class="preview-client" size="tiny" :value="target"
        :options="targetOptions" :consistent-menu-width="false"
        @update:value="(v) => emit('pick-target', v)"
      />
      <span v-else-if="targetLabel" class="tag tag-accent">{{ targetLabel }}</span>
      <span style="margin-left: auto" />
      <div class="seg seg-xs">
        <button type="button" class="seg-btn" :class="{ active: view === 'yaml' }" @click="view = 'yaml'">YAML</button>
        <button type="button" class="seg-btn" :class="{ active: view === 'visual' }" @click="view = 'visual'">可视化</button>
      </div>
      <button v-if="view === 'yaml'" type="button" class="code-theme-btn" title="代码主题与背景" @click="openThemePicker">
        <span class="code-theme-dot" :style="{ background: currentTheme.dot }" />
        {{ currentTheme.label }}
      </button>
      <n-button size="tiny" quaternary @click="emit('refresh')">刷新</n-button>
    </header>

    <div class="work-body preview-body">
      <n-spin :show="loading" style="flex: 1; min-height: 0; width: 100%">
        <div v-if="error" class="preview-empty">{{ error }}</div>
        <div v-else-if="!body" class="preview-empty">
          填写订阅或导入节点后点「转换预览」。<br>
          开了自动预览时，改模板 / 基础 / DNS / 规则集也会自动刷新。
        </div>

        <div v-else-if="view === 'yaml'" class="code-block" :data-code-theme="currentTheme.id" :style="{ background: currentTheme.bg }">
          <div class="code-tools">
            <input v-model="q" class="code-search" placeholder="在配置中搜索：port / proxy-groups / 节点名…" spellcheck="false">
            <span class="code-hits">{{ q.trim() ? `${hitLines.length} 处` : '搜索' }}</span>
            <button type="button" class="code-act" :disabled="!hitLines.length" @click="stepHit(-1)">↑</button>
            <button type="button" class="code-act" :disabled="!hitLines.length" @click="stepHit(1)">↓</button>
            <label class="code-opt"><input v-model="onlyHit" type="checkbox" :disabled="!q.trim()"> 仅看命中</label>
            <label class="code-opt"><input v-model="wrap" type="checkbox"> 自动换行</label>
          </div>
          <pre class="code-body" :class="{ wrap }"><div v-for="row in shownLines" :key="row.i" :data-line="row.i" class="code-line" :class="{ hit: q.trim() && hitSet.has(row.i) }"><span class="ln">{{ row.i + 1 }}</span><span class="lc" v-html="highlight(row.l)"></span></div><div v-if="lines.rest" class="code-line"><span class="ln">…</span><span class="lc">还有 {{ lines.rest }} 行未展开</span></div></pre>
        </div>

        <div v-else class="visual-view" :class="`pal-${palette}`">
          <div class="visual-legend">
            <button
              v-for="cat in CATS" :key="cat.id" type="button" class="legend-chip"
              :class="{ off: !activeCats.includes(cat.id) }" :style="{ '--cat': cat.color }"
              @click="toggleCat(cat.id)"
            >
              <span class="legend-dot" />{{ cat.label }}
              <span class="legend-num">{{ catCount.get(cat.id) || 0 }}</span>
            </button>
            <button type="button" class="legend-mode" title="切换分类配色深浅" @click="togglePalette">
              {{ palette === 'soft' ? '柔和' : '鲜明' }}
            </button>
          </div>

          <div class="visual-stats">
            <div class="vstat"><b>{{ nodeCount }}</b><span>节点</span></div>
            <div class="vstat"><b>{{ groupCount }}</b><span>代理组</span></div>
            <div class="vstat"><b>{{ compact(ruleCount) }}</b><span>规则</span></div>
          </div>

          <div class="visual-list">
            <div
              v-for="g in shownGroups" :key="g.name" class="vgroup"
              :class="{ open: expanded.has(g.name), dragging: dragName === g.name, over: dragOver === g.name }"
              :style="{ '--cat': catOf(g.name).color }"
              draggable="true"
              @dragstart="startDrag(g.name, $event)"
              @dragover.prevent="overDrag(g.name)"
              @dragleave="dragOver === g.name && (dragOver = '')"
              @drop.prevent="dropDrag(g.name)"
              @dragend="dragName = ''; dragOver = ''"
              @click="toggleGroup(g.name)"
            >
              <div class="vgroup-head">
                <span class="vgroup-drag" title="拖拽调整策略组顺序">⠿</span>
                <span class="vgroup-chev">{{ expanded.has(g.name) ? '▾' : '▸' }}</span>
                <span class="vgroup-icon">{{ groupSummary(g).icon }}</span>
                <b class="vgroup-name">{{ g.name }}</b>
                <span class="vgroup-type">{{ typeLabel(g.type) }}</span>
                <span class="vgroup-sum"><em>{{ groupSummary(g).label }}</em> 默认: {{ groupSummary(g).value }}</span>
              </div>
              <div v-if="expanded.has(g.name)" class="vgroup-detail" @click.stop>
                <div class="vd-col">
                  <b>成员 · {{ g.members.length }}</b>
                  <div class="vd-tags">
                    <span v-for="m in g.members" :key="m" class="vmember" :class="'tone-' + toneOf(m)">{{ m }}</span>
                    <span v-if="!g.members.length" class="hint">没有成员</span>
                  </div>
                </div>
                <div class="vd-col">
                  <b>规则集 · {{ rulesOf(g.name).length }}</b>
                  <div class="vd-tags">
                    <span v-for="r in rulesOf(g.name)" :key="r.name" class="vruleset" :class="'tone-' + toneOf(r.name)">{{ r.name }}<em v-if="r.tag">{{ r.tag }}</em></span>
                    <span v-if="!rulesOf(g.name).length" class="hint">没有规则集</span>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="!shownGroups.length" class="preview-empty">没有匹配的分类，点上面的分类标签恢复显示。</div>
          </div>
        </div>
      </n-spin>
    </div>

    <div v-if="$slots.format" class="preview-format compact">
      <slot name="format" />
    </div>

    <footer class="work-foot preview-foot">
      <slot name="actions" />
      <span style="margin-left: auto" />
      <span class="hint">{{ nodes }} 节点 · {{ bytes }} B · {{ ms }} ms</span>
      <span v-if="traffic" class="tag tag-ok">{{ traffic }}</span>
    </footer>

    <div v-if="warnings && warnings.length" class="preview-warn">
      <div v-for="(w, i) in warnings" :key="i">⚠ {{ w }}</div>
    </div>

    <n-modal v-model:show="themeOpen" preset="card" title="预览主题" style="width: 720px; max-width: 94vw">
      <p class="theme-tip">
        背景与语法配色合并为一套。当前站点主题：{{ themeMode === 'dark' ? '暗色' : '亮色' }}；切换后仅影响预览，不影响订阅输出。
      </p>
      <div class="theme-grid">
        <button
          v-for="t in THEMES" :key="t.id" type="button" class="theme-card"
          :class="{ active: themeDraft === t.id, light: t.mode === 'light' }"
          @click="previewTheme(t.id)"
        >
          <span class="theme-swatch" :style="{ background: t.bg, borderColor: t.mode === 'dark' ? '#27324a' : '#dbe2ea' }">
            <i :style="{ background: t.dot }" />
            <em :style="{ background: t.mode === 'dark' ? '#7ee0b8' : '#0a7d33' }" />
            <b :style="{ background: t.mode === 'dark' ? '#f5b57a' : '#953800' }" />
          </span>
          <span class="theme-name">{{ t.label }}</span>
          <span class="theme-mode">{{ t.mode === 'dark' ? '暗' : '亮' }}</span>
        </button>
      </div>
      <template #footer>
        <div class="theme-foot">
          <span class="hint">点击卡片可即时预览</span>
          <span style="margin-left: auto" />
          <n-button size="small" @click="cancelTheme">取消</n-button>
          <n-button size="small" type="primary" @click="confirmTheme">确认主题</n-button>
        </div>
      </template>
    </n-modal>
  </section>
</template>

<style scoped>
.code-tools {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; border-bottom: 1px solid var(--c-head, rgba(255,255,255,.06));
  background: var(--c-head, rgba(255,255,255,.03)); color: var(--c-text, #cbd5e1);
  font-size: 11px; flex: 0 0 auto;
}
.code-search {
  flex: 1; min-width: 0; height: 22px; padding: 0 8px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--c-text, #cbd5e1) 22%, transparent);
  background: color-mix(in srgb, var(--c-text, #cbd5e1) 8%, transparent);
  color: var(--c-text, #cbd5e1); font: inherit; outline: none;
}
.code-search::placeholder { color: color-mix(in srgb, var(--c-text, #cbd5e1) 55%, transparent); }
.code-hits { font-variant-numeric: tabular-nums; opacity: .7; white-space: nowrap; }
.code-opt { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; opacity: .8; cursor: pointer; }
.code-opt input { accent-color: var(--accent, #6366f1); }
.code-body.wrap .code-line { white-space: pre-wrap; word-break: break-all; }
.code-line.hit { background: color-mix(in srgb, #fbbf24 14%, transparent); }
.code-act:disabled { opacity: .35; cursor: default; }

.vgroup { cursor: pointer; }
.vgroup-chev { color: var(--text-dim, #94a3b8); font-size: 11px; width: 10px; }
.vgroup-icon { font-size: 12px; line-height: 1; }
.vgroup-name { font-size: 12.5px; }
.vgroup-sum { margin-left: auto; font-size: 11px; color: var(--text-dim, #64748b); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vgroup-sum em { font-style: normal; opacity: .65; }
.vgroup.open { background: color-mix(in srgb, var(--cat) 11%, var(--panel, #fff)); }
.vgroup.dragging { opacity: .45; }
.vgroup.over { outline: 2px dashed var(--cat); outline-offset: -2px; }
.vgroup-detail { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 8px 10px 10px 34px; min-height: 84px; }
.vd-col { min-width: 0; }
.vd-col > b { display: block; font-size: 10.5px; font-weight: 600; color: var(--text-dim, #64748b); margin-bottom: 6px; }
.vd-tags { display: flex; flex-wrap: wrap; gap: 5px; align-content: flex-start; }
.vmember { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; background: var(--panel, #fff); border: 1px solid var(--line, rgba(15,23,42,.14)); }
.vruleset { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--cat) 16%, var(--panel, #fff)); border: 1px solid color-mix(in srgb, var(--cat) 40%, transparent); display: inline-flex; gap: 4px; align-items: center; }
.vruleset em { font-style: normal; font-size: 9px; opacity: .7; }
.pal-vivid .vgroup { background: color-mix(in srgb, var(--cat) 16%, var(--panel, #fff)); }
.pal-vivid .legend-chip { background: color-mix(in srgb, var(--cat) 22%, var(--panel, #fff)); }
.legend-mode {
  margin-left: auto; height: 24px; padding: 0 9px; border-radius: 999px;
  border: 1px dashed var(--line, rgba(15,23,42,.18)); background: transparent;
  color: var(--text-dim, #64748b); font: inherit; font-size: 11px; cursor: pointer;
}
.legend-mode:hover { color: var(--text, #0f172a); }
.preview-foot { gap: 8px; }
.theme-tip { margin: 0 0 12px; font-size: 12px; color: var(--text-dim, #64748b); line-height: 1.7; }
.theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 10px; }
.theme-card { display: grid; grid-template-columns: 46px 1fr auto; align-items: center; gap: 9px; padding: 9px 10px; border-radius: 10px; border: 1px solid var(--line, rgba(15,23,42,.14)); background: var(--panel, #fff); cursor: pointer; text-align: left; }
.theme-card:hover { border-color: color-mix(in srgb, var(--brand, #6d7dff) 45%, transparent); }
.theme-card.active { border-color: var(--brand, #6d7dff); box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand, #6d7dff) 20%, transparent); }
.theme-swatch { width: 46px; height: 34px; border-radius: 7px; border: 1px solid; display: flex; align-items: center; gap: 4px; padding: 0 6px; }
.theme-swatch i, .theme-swatch em, .theme-swatch b { display: block; height: 5px; border-radius: 3px; }
.theme-swatch i { width: 16px; }
.theme-swatch em { width: 12px; }
.theme-swatch b { width: 8px; }
.theme-name { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.theme-mode { font-size: 10px; color: var(--text-dim, #64748b); border: 1px solid var(--line, rgba(15,23,42,.14)); border-radius: 999px; padding: 1px 6px; }
.theme-foot { display: flex; align-items: center; gap: 8px; }
.vmember.tone-0, .vruleset.tone-0 { background: rgba(99,102,241,.16); border-color: rgba(99,102,241,.42); color: #a5b4fc; }
.vmember.tone-1, .vruleset.tone-1 { background: rgba(16,185,129,.15); border-color: rgba(16,185,129,.4); color: #6ee7b7; }
.vmember.tone-2, .vruleset.tone-2 { background: rgba(168,85,247,.16); border-color: rgba(168,85,247,.42); color: #d8b4fe; }
.vmember.tone-3, .vruleset.tone-3 { background: rgba(245,158,11,.15); border-color: rgba(245,158,11,.4); color: #fcd34d; }
.vmember.tone-4, .vruleset.tone-4 { background: rgba(6,182,212,.15); border-color: rgba(6,182,212,.4); color: #67e8f9; }
.vmember.tone-5, .vruleset.tone-5 { background: rgba(20,184,166,.15); border-color: rgba(20,184,166,.4); color: #5eead4; }
html[data-theme='light'] .vmember.tone-0, html[data-theme='light'] .vruleset.tone-0 { background: #eef2ff; border-color: #c7d2fe; color: #4338ca; }
html[data-theme='light'] .vmember.tone-1, html[data-theme='light'] .vruleset.tone-1 { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
html[data-theme='light'] .vmember.tone-2, html[data-theme='light'] .vruleset.tone-2 { background: #faf5ff; border-color: #e9d5ff; color: #7e22ce; }
html[data-theme='light'] .vmember.tone-3, html[data-theme='light'] .vruleset.tone-3 { background: #fffbeb; border-color: #fde68a; color: #b45309; }
html[data-theme='light'] .vmember.tone-4, html[data-theme='light'] .vruleset.tone-4 { background: #ecfeff; border-color: #a5f3fc; color: #0e7490; }
html[data-theme='light'] .vmember.tone-5, html[data-theme='light'] .vruleset.tone-5 { background: #f0fdfa; border-color: #99f6e4; color: #0f766e; }
</style>



