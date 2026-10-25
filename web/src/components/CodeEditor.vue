<script setup>
/**
 * 轻量代码编辑器：透明 textarea 叠在高亮 <pre> 上，左侧自带行号。
 * 不引入任何新依赖；支持 YAML / INI / JSON 高亮、行号标记与跳转、滚动同步。
 */
import { computed, nextTick, ref, watch } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  /** yaml | ini | json */
  language: { type: String, default: 'yaml' },
  /** default（蓝青）| alt（紫橙），用于左右分栏时区分配色 */
  palette: { type: String, default: 'default' },
  readonly: { type: Boolean, default: false },
  height: { type: String, default: '420px' },
  /** [{ line: 1, kind: 'warn' | 'error', text: '…' }] */
  marks: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'line-click', 'save']);

const LINE_H = 20;
const PAD_T = 10;

const taEl = ref(null);
const preEl = ref(null);
const gutterEl = ref(null);
const scrollTop = ref(0);
const activeLine = ref(0);

const source = computed(() => String(props.modelValue == null ? '' : props.modelValue));
const lines = computed(() => source.value.split('\n'));
const lineCount = computed(() => Math.max(1, lines.value.length));

/* ── 高亮：逐行转义后再包 span，保证 v-html 安全 ── */
const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => HTML_ESCAPE[c]);

const YAML_RE = /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(^[ \t]*-)(?=[ \t]|$)|(\btrue\b|\bfalse\b|\bnull\b|\byes\b|\bno\b|\bon\b|\boff\b)|(-?\b\d+(?:\.\d+)?\b)|([A-Za-z0-9_.$-]+)(?=[ \t]*:(?!\/\/))/g;
const JSON_RE = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g;

function hlYaml(line) {
  let out = '';
  let last = 0;
  let m;
  YAML_RE.lastIndex = 0;
  while ((m = YAML_RE.exec(line))) {
    if (!m[0]) { YAML_RE.lastIndex += 1; continue; }
    out += esc(line.slice(last, m.index));
    if (m[1]) out += `<span class="syn-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="syn-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="syn-dash">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="syn-bool">${esc(m[4])}</span>`;
    else if (m[5]) out += `<span class="syn-num">${esc(m[5])}</span>`;
    else if (m[6]) out += `<span class="syn-key">${esc(m[6])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(line.slice(last));
}

function hlJson(line) {
  let out = '';
  let last = 0;
  let m;
  JSON_RE.lastIndex = 0;
  while ((m = JSON_RE.exec(line))) {
    if (!m[0]) { JSON_RE.lastIndex += 1; continue; }
    out += esc(line.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="syn-key">${esc(m[1])}</span><span class="syn-dash">${esc(m[2])}</span>` : `<span class="syn-str">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="syn-num">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="syn-bool">${esc(m[4])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(line.slice(last));
}

/** 模板是 SubHub 的 INI 子集：[custom]、key=value、; 注释、[]TYPE 指令 */
function hlIni(line) {
  const s = String(line);
  if (!s.trim()) return '';
  const trimmed = s.trimStart();
  if (trimmed.startsWith(';') || trimmed.startsWith('#')) return `<span class="syn-com">${esc(s)}</span>`;
  if (/^\[[^\]\n]*\]$/.test(trimmed)) {
    const gap = s.length - trimmed.length;
    return `${esc(s.slice(0, gap))}<span class="syn-key">${esc(trimmed)}</span>`;
  }
  const m = /^([ \t]*)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)([\s\S]*)$/.exec(s);
  if (m) {
    const value = m[4];
    let body = `<span class="syn-str">${esc(value)}</span>`;
    const comma = value.indexOf(',');
    if (comma > 0) {
      body = `<span class="syn-dash">${esc(value.slice(0, comma))}</span><span class="syn-str">${esc(value.slice(comma))}</span>`;
    } else if (/^(true|false)$/i.test(value.trim())) {
      body = `<span class="syn-bool">${esc(value)}</span>`;
    } else if (/^-?\d+$/.test(value.trim())) {
      body = `<span class="syn-num">${esc(value)}</span>`;
    }
    return `${esc(m[1])}<span class="syn-key">${esc(m[2])}</span>${esc(m[3])}${body}`;
  }
  return esc(s);
}

function highlightLine(line, language) {
  if (language === 'ini') return hlIni(line);
  if (language === 'json') return hlJson(line);
  return hlYaml(line);
}

const highlighted = computed(() => lines.value.map((line) => highlightLine(line, props.language)).join('\n'));

const markMap = computed(() => {
  const map = new Map();
  for (const mark of props.marks || []) {
    const line = Number(mark && mark.line);
    if (!line || line < 1) continue;
    const prev = map.get(line);
    // 同一行同时有错误与警告时，保留错误
    if (!prev || mark.kind === 'error') map.set(line, { kind: mark.kind === 'error' ? 'error' : 'warn', text: String(mark.text || '') });
  }
  return map;
});

const activeStyle = computed(() => ({ top: `${PAD_T + (activeLine.value - 1) * LINE_H - scrollTop.value}px`, height: `${LINE_H}px` }));

function markClass(line) {
  const mark = markMap.value.get(line);
  return {
    'mk-error': !!mark && mark.kind === 'error',
    'mk-warn': !!mark && mark.kind === 'warn',
    'mk-active': activeLine.value === line,
  };
}

function markTitle(line) {
  const mark = markMap.value.get(line);
  if (!mark) return `第 ${line} 行`;
  return mark.text || (mark.kind === 'error' ? '该行存在错误' : '该行存在提醒');
}

function syncScroll() {
  const ta = taEl.value;
  if (!ta) return;
  scrollTop.value = ta.scrollTop;
  if (preEl.value) {
    preEl.value.scrollTop = ta.scrollTop;
    preEl.value.scrollLeft = ta.scrollLeft;
  }
  if (gutterEl.value) gutterEl.value.scrollTop = ta.scrollTop;
}

function onInput(e) {
  emit('update:modelValue', e.target.value);
  nextTick(syncScroll);
}

function insertText(text) {
  const ta = taEl.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value.slice(0, start) + text + ta.value.slice(end);
  const caret = start + text.length;
  ta.value = value;
  ta.selectionStart = caret;
  ta.selectionEnd = caret;
  emit('update:modelValue', value);
  nextTick(syncScroll);
}

function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 's') {
    e.preventDefault();
    emit('save');
    return;
  }
  if (e.key === 'Tab' && !props.readonly) {
    e.preventDefault();
    insertText('  ');
  }
}

function focusLine(line) {
  const ta = taEl.value;
  if (!ta) return;
  const idx = Math.max(0, Math.min(Number(line) - 1, lines.value.length - 1));
  const target = lines.value[idx] || '';
  let pos = 0;
  for (let i = 0; i < idx; i += 1) pos += lines.value[i].length + 1;
  activeLine.value = idx + 1;
  try {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(pos, pos + target.length);
  } catch { ta.focus(); }
  ta.scrollTop = Math.max(0, (idx - 2) * LINE_H);
  syncScroll();
}

function focus() {
  if (taEl.value) taEl.value.focus({ preventScroll: true });
}

function onGutterClick(line) {
  activeLine.value = line;
  if (!props.readonly) focusLine(line);
  emit('line-click', line);
}

/** 外部整体替换内容（切换模板、格式化）时才回到顶部；输入回写不会触发滚动重置 */
watch(source, (value) => {
  const ta = taEl.value;
  if (!ta) return;
  if (value !== ta.value) {
    scrollTop.value = 0;
    activeLine.value = 0;
    nextTick(() => {
      ta.scrollTop = 0;
      if (preEl.value) { preEl.value.scrollTop = 0; preEl.value.scrollLeft = 0; }
      if (gutterEl.value) gutterEl.value.scrollTop = 0;
    });
  }
});

defineExpose({ focusLine, focus });
</script>

<template>
  <div
    class="code-editor" :class="[`ed-${palette}`, `lang-${language}`, { 'is-readonly': readonly }]"
    :style="{ height }"
  >
    <div ref="gutterEl" class="ce-gutter">
      <div class="ce-gutter-inner">
        <button
          v-for="n in lineCount" :key="n" type="button" class="ce-ln" :class="markClass(n)"
          :title="markTitle(n)" @click="onGutterClick(n)"
        >{{ n }}</button>
      </div>
    </div>
    <div class="ce-stage">
      <pre ref="preEl" class="ce-pre" aria-hidden="true"><code v-html="highlighted"></code></pre>
      <div v-if="activeLine" class="ce-active" :style="activeStyle" />
      <textarea
        ref="taEl" class="ce-input" :value="modelValue" :readonly="readonly" :placeholder="placeholder"
        spellcheck="false" wrap="off" autocomplete="off" autocapitalize="off"
        @input="onInput" @scroll="syncScroll" @keydown="onKeydown"
      />
    </div>
  </div>
</template>

<style scoped>
.code-editor {
  --ce-bg: #0a0b10;
  --ce-gutter-bg: #0c0e14;
  --ce-ln: #4b5563;
  --ce-text: #d6deeb;
  --ce-key: #8ab4ff;
  --ce-str: #7ee0b8;
  --ce-num: #f5b57a;
  --ce-bool: #c792ea;
  --ce-com: #5c677d;
  --ce-dash: #f78fb3;
  position: relative;
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--ce-bg);
  font: 12.5px/20px var(--mono);
}
/* 右侧只读预览：换成紫橙配色，和左侧蓝青区分 */
.code-editor.ed-alt {
  --ce-bg: #0d0912;
  --ce-gutter-bg: #120c18;
  --ce-ln: #7c6f8f;
  --ce-text: #e7d9f7;
  --ce-key: #c084fc;
  --ce-str: #fbbf24;
  --ce-num: #fb923c;
  --ce-bool: #f0abfc;
  --ce-com: #7c6f64;
  --ce-dash: #fb7185;
}

.ce-gutter {
  z-index: 2;
  overflow: hidden;
  border-right: 1px solid var(--line-soft);
  background: var(--ce-gutter-bg);
  user-select: none;
}
.ce-gutter-inner {
  display: flex;
  flex-direction: column;
  padding: 10px 0;
}
.ce-ln {
  display: block;
  width: 100%;
  height: 20px;
  padding: 0 9px 0 4px;
  border: 0;
  background: transparent;
  color: var(--ce-ln);
  font: inherit;
  line-height: 20px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.ce-ln:hover { color: var(--ce-text); background: rgba(255, 255, 255, .05); }
.ce-ln.mk-warn { color: #fb7185; background: rgba(251, 113, 133, .14); box-shadow: inset 2px 0 0 #fb7185; }
.ce-ln.mk-error { color: #f87171; background: rgba(248, 113, 113, .16); box-shadow: inset 2px 0 0 #f87171; font-weight: 700; }
.ce-ln.mk-active { color: var(--ce-text); background: rgba(148, 163, 184, .16); }

.ce-stage { position: relative; min-width: 0; }
.ce-pre,
.ce-input {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 10px 14px;
  border: 0;
  font: inherit;
  line-height: 20px;
  tab-size: 2;
  white-space: pre;
  overflow-wrap: normal;
}
.ce-pre {
  z-index: 0;
  overflow: auto;
  color: var(--ce-text);
  scrollbar-width: none;
  pointer-events: none;
}
.ce-pre::-webkit-scrollbar { width: 0; height: 0; }
.ce-pre code { font: inherit; color: inherit; white-space: inherit; }
.ce-input {
  z-index: 2;
  overflow: auto;
  resize: none;
  background: transparent;
  color: transparent;
  caret-color: var(--ce-text);
  outline: none;
}
.ce-input::selection { background: rgba(99, 102, 241, .35); color: transparent; }
.ce-input::placeholder { color: var(--ce-ln); }
.ce-active {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 1;
  background: rgba(148, 163, 184, .10);
  pointer-events: none;
}

/* v-html 生成的 span 不带 scoped 属性，需要 :deep */
:deep(.syn-key) { color: var(--ce-key); }
:deep(.syn-str) { color: var(--ce-str); }
:deep(.syn-num) { color: var(--ce-num); }
:deep(.syn-bool) { color: var(--ce-bool); }
:deep(.syn-com) { color: var(--ce-com); font-style: italic; }
:deep(.syn-dash) { color: var(--ce-dash); }

.is-readonly .ce-input { caret-color: transparent; cursor: default; }
.is-readonly .ce-ln { cursor: default; }

html[data-theme='light'] .code-editor {
  --ce-bg: #ffffff;
  --ce-gutter-bg: #f8fafc;
  --ce-ln: #94a3b8;
  --ce-text: #334155;
  --ce-key: #1d4ed8;
  --ce-str: #047857;
  --ce-num: #b45309;
  --ce-bool: #7c3aed;
  --ce-com: #94a3b8;
  --ce-dash: #be123c;
}
html[data-theme='light'] .code-editor.ed-alt {
  --ce-bg: #fdf9ff;
  --ce-gutter-bg: #f6eefc;
  --ce-ln: #a08bb5;
  --ce-text: #3b2c4a;
  --ce-key: #7e22ce;
  --ce-str: #b45309;
  --ce-num: #c2410c;
  --ce-bool: #a21caf;
  --ce-dash: #be123c;
}
html[data-theme='light'] .ce-ln:hover { background: rgba(15, 23, 42, .05); }
</style>
