<script setup>
/**
 * 逐行 diff：自写 LCS（先裁掉公共前后缀，限制矩阵规模，超限降级为逐行对齐）。
 * 只做展示，不引入 diff 依赖。
 */
import { computed } from 'vue';

const props = defineProps({
  before: { type: String, default: '' },
  after: { type: String, default: '' },
  height: { type: String, default: '420px' },
  head: { type: Boolean, default: true },
});

function toLines(text) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!src) return [];
  const rows = src.split('\n');
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

function naiveDiff(a, b) {
  const rows = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] === b[i]) {
      rows.push({ type: 'same', text: a[i] == null ? '' : a[i], an: i + 1, bn: i + 1 });
    } else {
      if (a[i] != null) rows.push({ type: 'del', text: a[i], an: i + 1, bn: null });
      if (b[i] != null) rows.push({ type: 'add', text: b[i], an: null, bn: i + 1 });
    }
  }
  return rows;
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i += 1) dp[i] = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    const row = dp[i];
    const prev = dp[i - 1];
    const ai = a[i - 1];
    for (let j = 1; j <= m; j += 1) {
      row[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
  }
  const rows = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      rows.push({ type: 'same', text: a[i - 1], an: i, bn: j });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      rows.push({ type: 'del', text: a[i - 1], an: i, bn: null });
      i -= 1;
    } else {
      rows.push({ type: 'add', text: b[j - 1], an: null, bn: j });
      j -= 1;
    }
  }
  while (i > 0) {
    rows.push({ type: 'del', text: a[i - 1], an: i, bn: null });
    i -= 1;
  }
  while (j > 0) {
    rows.push({ type: 'add', text: b[j - 1], an: null, bn: j });
    j -= 1;
  }
  return rows.reverse();
}

function buildDiff(before, after) {
  const a = toLines(before);
  const b = toLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  // 超过 200 万格就降级，避免大文件把主线程卡住
  const middle = midA.length * midB.length > 2_000_000 ? naiveDiff(midA, midB) : lcsDiff(midA, midB);
  const rows = [];
  for (let i = 0; i < start; i += 1) rows.push({ type: 'same', text: a[i], an: i + 1, bn: i + 1 });
  for (const row of middle) {
    rows.push({
      ...row,
      an: row.an == null ? null : row.an + start,
      bn: row.bn == null ? null : row.bn + start,
    });
  }
  for (let i = 0; i < a.length - endA; i += 1) {
    rows.push({ type: 'same', text: a[endA + i], an: endA + i + 1, bn: endB + i + 1 });
  }
  return rows;
}

const rows = computed(() => buildDiff(props.before, props.after));
const added = computed(() => rows.value.filter((r) => r.type === 'add').length);
const removed = computed(() => rows.value.filter((r) => r.type === 'del').length);
const identical = computed(() => added.value === 0 && removed.value === 0);
</script>

<template>
  <div class="diff-view" :style="{ height }">
    <div v-if="head" class="dv-head">
      <span class="dv-chip add">+{{ added }}</span>
      <span class="dv-chip del">−{{ removed }}</span>
      <span v-if="identical" class="dv-same">两侧内容一致</span>
      <span v-else class="dv-hint">绿=新增 · 红=删除 · 灰=未变</span>
    </div>
    <div class="dv-body">
      <div v-if="identical" class="dv-empty">没有行级差异</div>
      <div
        v-for="(row, i) in rows" :key="i" class="dv-row"
        :class="{ add: row.type === 'add', del: row.type === 'del', same: row.type === 'same' }"
      >
        <span class="dv-sign">{{ row.type === 'add' ? '+' : row.type === 'del' ? '−' : '' }}</span>
        <span class="dv-ln">{{ row.an == null ? '' : row.an }}</span>
        <span class="dv-ln">{{ row.bn == null ? '' : row.bn }}</span>
        <code class="dv-code">{{ row.text === '' ? ' ' : row.text }}</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-view {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #0a0b10;
  color: #cbd5e1;
  font: 12px/20px var(--mono);
}
.dv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line-soft);
  background: rgba(255, 255, 255, .03);
  font-size: 11.5px;
}
.dv-chip {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  font: 600 11px/1 var(--mono);
}
.dv-chip.add { color: #4ade80; background: rgba(34, 197, 94, .14); }
.dv-chip.del { color: #f87171; background: rgba(248, 113, 113, .14); }
.dv-same { color: #4ade80; }
.dv-hint { color: var(--text-dim); }

.dv-body { flex: 1; overflow: auto; padding: 4px 0 8px; }
.dv-empty { padding: 18px 12px; color: var(--text-dim); text-align: center; font-size: 12px; }
.dv-row {
  display: flex;
  align-items: stretch;
  min-width: 100%;
  white-space: pre;
}
.dv-row:hover { background: rgba(255, 255, 255, .035); }
.dv-row.add { background: rgba(34, 197, 94, .11); }
.dv-row.add:hover { background: rgba(34, 197, 94, .17); }
.dv-row.del { background: rgba(248, 113, 113, .11); }
.dv-row.del:hover { background: rgba(248, 113, 113, .17); }
.dv-sign {
  flex: 0 0 16px;
  text-align: center;
  user-select: none;
  color: #64748b;
}
.dv-row.add .dv-sign { color: #4ade80; }
.dv-row.del .dv-sign { color: #f87171; }
.dv-ln {
  flex: 0 0 40px;
  padding: 0 6px 0 2px;
  text-align: right;
  user-select: none;
  color: #475569;
  font-variant-numeric: tabular-nums;
  border-right: 1px solid rgba(255, 255, 255, .05);
}
.dv-row.add .dv-ln:last-of-type { color: #4ade80; }
.dv-row.del .dv-ln { color: #f87171; }
.dv-code {
  padding: 0 12px;
  font: inherit;
  color: inherit;
  white-space: pre;
}
.dv-row.add .dv-code { color: #bbf7d0; }
.dv-row.del .dv-code { color: #fecaca; }
.dv-row.same .dv-code { color: #94a3b8; }

html[data-theme='light'] .diff-view { background: #fff; color: #334155; }
html[data-theme='light'] .dv-head { background: rgba(15, 23, 42, .03); }
html[data-theme='light'] .dv-row.add { background: #e9f9ef; }
html[data-theme='light'] .dv-row.del { background: #fdecec; }
html[data-theme='light'] .dv-row.add .dv-code { color: #166534; }
html[data-theme='light'] .dv-row.del .dv-code { color: #991b1b; }
html[data-theme='light'] .dv-row.same .dv-code { color: #475569; }
html[data-theme='light'] .dv-ln { color: #94a3b8; }
</style>
