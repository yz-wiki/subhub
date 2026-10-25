<script setup>
import { computed } from 'vue';
import { NButton, NCheckbox, NSelect, NTooltip } from 'naive-ui';

const props = defineProps({
  group: { type: Object, required: true },
  rules: { type: Array, default: () => [] },
  canWrite: { type: Boolean, default: false },
  expanded: { type: Boolean, default: false },
  index: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  color: { type: String, default: '#6366f1' },
});
const emit = defineEmits(['toggle', 'type', 'enabled', 'move', 'remove', 'pick-members', 'remove-member', 'add-rule', 'remove-rule', 'edit', 'dragstart', 'drop']);

const TYPE_OPTIONS = [
  { label: '手动选择', value: 'select' },
  { label: '自动测速', value: 'url-test' },
  { label: '故障转移', value: 'fallback' },
  { label: '负载均衡', value: 'load-balance' },
  { label: '中转链', value: 'relay' },
];
const members = computed(() => (props.group.type === 'select' || props.group.type === 'relay'
  ? (props.group.refs || [])
  : (props.group.patterns || [])));

function toneOf(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 997;
  return h % 6;
}

const summary = computed(() => {
  const first = members.value[0] || '自动';
  const g = props.group;
  if (/拦截|广告|广告拦截|Reject|Block/i.test(g.name)) return { icon: '⛔', label: '拦截', value: '拒绝' };
  if (g.type === 'relay') {
    const next = members.value[1] ? ` → ${members.value[1]}` : '';
    return { icon: '🔗', label: '中转链', value: `${first}${next}` };
  }
  if (g.type === 'url-test') return { icon: '⚡', label: '自动测速', value: first };
  if (g.type === 'fallback') return { icon: '🛟', label: '故障转移', value: first };
  if (g.type === 'load-balance') return { icon: '⚖️', label: '负载均衡', value: first };
  return { icon: '🎯', label: '手动选择', value: first };
});
</script>

<template>
  <div
    class="grow" :class="{ off: group.enabled === false, open: expanded }" :style="{ '--cat': color }"
    draggable="true" @dragstart="emit('dragstart', $event)" @dragover.prevent @drop.prevent="emit('drop', $event)"
  >
    <div class="grow-head" @click="emit('toggle')">
      <span class="grow-drag" title="拖动调整顺序">⠿</span>
      <span class="grow-chev">{{ expanded ? '▾' : '▸' }}</span>
      <span class="grow-icon">{{ summary.icon }}</span>
      <b class="grow-name">{{ group.name }}</b>
      <button v-if="canWrite" type="button" class="grow-edit" title="编辑名称 / 类型 / 成员 / 规则" @click.stop="emit('edit')">✎</button>
      <span class="grow-type">{{ (TYPE_OPTIONS.find((t) => t.value === group.type) || {}).label }}</span>
      <span class="grow-count">{{ members.length }} 成员</span>
      <span class="grow-count">{{ rules.length }} 规则</span>
      <span class="grow-summary">{{ summary.label }} <em>默认:</em> {{ summary.value }}</span>
      <span v-if="canWrite" class="grow-acts">
        <button type="button" class="grow-act" :title="group.enabled === false ? '启用该分组' : '停用该分组'" @click.stop="emit('enabled', group.enabled === false)">{{ group.enabled === false ? '启' : '停' }}</button>
        <button type="button" class="grow-act" title="上移" :disabled="index === 0" @click.stop="emit('move', -1)">↑</button>
        <button type="button" class="grow-act" title="下移" :disabled="index === total - 1" @click.stop="emit('move', 1)">↓</button>
        <button type="button" class="grow-act danger" title="删除" @click.stop="emit('remove')">✕</button>
      </span>
    </div>

    <div v-if="expanded" class="grow-body" @click.stop>
      <div class="grow-tools">
        <n-select
          size="tiny" :value="group.type" style="width: 108px" :options="TYPE_OPTIONS"
          :disabled="!canWrite" @update:value="(v) => emit('type', v)"
        />
        <n-checkbox :checked="group.enabled !== false" :disabled="!canWrite" @update:checked="(v) => emit('enabled', v)">启用</n-checkbox>
        <span style="margin-left: auto" />
        <n-button size="tiny" quaternary :disabled="index === 0" @click="emit('move', -1)">↑</n-button>
        <n-button size="tiny" quaternary :disabled="index === total - 1" @click="emit('move', 1)">↓</n-button>
        <n-button size="tiny" quaternary type="error" :disabled="!canWrite" @click="emit('remove')">删除</n-button>
      </div>
      <div class="chip-wrap">
        <span v-for="m in members" :key="m" class="mchip" :class="'tone-' + toneOf(m)">
          {{ m }}
          <button v-if="canWrite" type="button" class="mchip-x" @click="emit('remove-member', m)">✕</button>
        </span>
        <button v-if="canWrite" type="button" class="mchip add" @click="emit('pick-members')">＋ 添加成员</button>
        <span v-if="!members.length" class="hint">还没有成员，点「添加成员」选择节点或分组。</span>
      </div>
      <div v-if="rules.length" class="chip-wrap rules">
        <n-tooltip v-for="(r, ri) in rules" :key="ri" trigger="hover" placement="top">
          <template #trigger>
            <span class="rpill" :class="'tone-' + toneOf(r.name)">
              {{ r.name }}
              <span v-if="r.tags && r.tags.length" class="rpill-tag">{{ r.tags[0] }}</span>
              <button v-if="canWrite" type="button" class="rpill-x" @click="emit('remove-rule', r)">✕</button>
            </span>
          </template>
          <div class="gr-pop">
            <div class="gr-pop-head"><b>{{ r.name }}</b><span v-if="r.source" class="gr-pop-src">{{ r.source }}</span></div>
            <p v-if="r.desc">{{ r.desc }}</p>
            <div v-if="r.tags && r.tags.length" class="gr-pop-tags">
              <em v-for="t in r.tags" :key="t">{{ t }}</em>
            </div>
          </div>
        </n-tooltip>
      </div>
      <div class="row" style="gap: 6px">
        <button v-if="canWrite" type="button" class="mchip add" @click="emit('add-rule')">＋ 规则</button>
        <span v-if="!rules.length" class="hint">没有规则指向这个分组。</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grow {
  border: 1px solid var(--line, rgba(15, 23, 42, .1));
  border-left: 3px solid var(--cat, #6366f1);
  border-radius: 10px;
  background: color-mix(in srgb, var(--cat, #6366f1) 5%, var(--panel, #fff));
  overflow: hidden;
}
.grow.off { opacity: .55; }
.grow-head {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 7px 10px; cursor: pointer; font-size: 12.5px; min-height: 36px;
}
.grow-head:hover { background: color-mix(in srgb, var(--cat, #6366f1) 8%, transparent); }
.grow-drag { color: var(--text-dim, #94a3b8); font-size: 11px; cursor: grab; user-select: none; }
.grow-chev { color: var(--text-dim, #94a3b8); font-size: 11px; width: 10px; }
.grow-icon { font-size: 12px; line-height: 1; }
.grow-name { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30%; }
.grow-edit { border: 0; background: transparent; color: var(--text-dim, #94a3b8); cursor: pointer; font-size: 11px; padding: 0 2px; opacity: .55; }
.grow-edit:hover { opacity: 1; color: var(--accent, #2563eb); }
.grow-type { font-size: 10px; padding: 0 6px; border-radius: 5px; border: 1px solid var(--line, rgba(15,23,42,.12)); color: var(--text-dim, #64748b); }
.grow-count { font-size: 10.5px; color: var(--text-dim, #94a3b8); }
.grow-summary { margin-left: auto; font-size: 11px; color: var(--text-dim, #64748b); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.grow-summary em { font-style: normal; opacity: .6; }
.grow-acts { display: inline-flex; align-items: center; gap: 1px; margin-left: 4px; }
.grow-act { width: 18px; height: 18px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text-dim, #64748b); font-size: 10px; line-height: 1; cursor: pointer; }
.grow-act:hover { border-color: var(--line, rgba(15,23,42,.16)); background: var(--panel, #fff); color: var(--text, #0f172a); }
.grow-act:disabled { opacity: .3; cursor: default; }
.grow-act.danger:hover { color: #ef4444; }
.grow-body { padding: 0 10px 9px; display: flex; flex-direction: column; gap: 7px; }
.grow-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chip-wrap { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.mchip {
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px;
  border-radius: 999px; font-size: 11px; line-height: 1;
  border: 1px solid var(--line, rgba(15,23,42,.12)); background: var(--panel, #fff); color: var(--text, #0f172a);
}
.mchip-x, .rpill-x { border: 0; background: transparent; color: inherit; opacity: .45; font-size: 9px; cursor: pointer; padding: 0; line-height: 1; }
.mchip-x:hover, .rpill-x:hover { opacity: 1; color: #ef4444; }
.mchip.add { border-style: dashed; color: var(--text-dim, #64748b); background: transparent; cursor: pointer; }
.mchip.add:hover { color: var(--text, #0f172a); border-color: var(--accent, #2563eb); }
.rules { margin-top: 1px; }
.rpill {
  display: inline-flex; align-items: center; gap: 4px; height: 21px; padding: 0 7px;
  border-radius: 6px; font-size: 10.5px;
  border: 1px solid var(--line, rgba(15,23,42,.1)); background: var(--panel-strong, #f8fafc); color: var(--text-dim, #475569);
}
.rpill-tag { opacity: .6; border-left: 1px solid var(--line, rgba(15,23,42,.12)); padding-left: 4px; }
.grow-summary { max-width: 30%; overflow: hidden; white-space: nowrap; }
.grow-count { white-space: nowrap; }
.grow-acts { gap: 0; }
.grow-name { flex: 0 1 auto; max-width: 34%; }
.grow-type, .grow-count { flex: 0 0 auto; white-space: nowrap; }
.grow-acts { flex: 0 0 auto; }
@media (max-width: 1700px) { .grow-summary { display: none; } }
/* 第五轮：更大卡片、彩色成员/规则、富说明 */
.grow-head { min-height: 42px; padding: 9px 12px; }
.grow-name { font-size: 13.5px; }
.grow-body { padding: 0 12px 12px; gap: 9px; }
.mchip, .rpill { border-width: 1px; border-style: solid; }
.mchip.tone-0, .rpill.tone-0 { background: rgba(99,102,241,.16); border-color: rgba(99,102,241,.42); color: #a5b4fc; }
.mchip.tone-1, .rpill.tone-1 { background: rgba(16,185,129,.15); border-color: rgba(16,185,129,.4); color: #6ee7b7; }
.mchip.tone-2, .rpill.tone-2 { background: rgba(168,85,247,.16); border-color: rgba(168,85,247,.42); color: #d8b4fe; }
.mchip.tone-3, .rpill.tone-3 { background: rgba(245,158,11,.15); border-color: rgba(245,158,11,.4); color: #fcd34d; }
.mchip.tone-4, .rpill.tone-4 { background: rgba(6,182,212,.15); border-color: rgba(6,182,212,.4); color: #67e8f9; }
.mchip.tone-5, .rpill.tone-5 { background: rgba(20,184,166,.15); border-color: rgba(20,184,166,.4); color: #5eead4; }
html[data-theme='light'] .mchip.tone-0, html[data-theme='light'] .rpill.tone-0 { background: #eef2ff; border-color: #c7d2fe; color: #4338ca; }
html[data-theme='light'] .mchip.tone-1, html[data-theme='light'] .rpill.tone-1 { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
html[data-theme='light'] .mchip.tone-2, html[data-theme='light'] .rpill.tone-2 { background: #faf5ff; border-color: #e9d5ff; color: #7e22ce; }
html[data-theme='light'] .mchip.tone-3, html[data-theme='light'] .rpill.tone-3 { background: #fffbeb; border-color: #fde68a; color: #b45309; }
html[data-theme='light'] .mchip.tone-4, html[data-theme='light'] .rpill.tone-4 { background: #ecfeff; border-color: #a5f3fc; color: #0e7490; }
html[data-theme='light'] .mchip.tone-5, html[data-theme='light'] .rpill.tone-5 { background: #f0fdfa; border-color: #99f6e4; color: #0f766e; }
.gr-pop { width: 320px; padding: 12px 14px; border-radius: 11px; background: var(--panel, #141a26); border: 1px solid var(--line, #26314a); box-shadow: 0 14px 32px rgba(2,6,18,.35); }
.gr-pop-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.gr-pop-head b { font-size: 13px; }
.gr-pop-src { font-size: 10px; color: var(--text-dim, #94a3b8); border: 1px solid var(--line-soft, #26314a); border-radius: 6px; padding: 1px 6px; }
.gr-pop p { margin: 0 0 8px; font-size: 12px; line-height: 1.7; color: var(--text-dim, #94a3b8); }
.gr-pop-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.gr-pop-tags em { font-style: normal; font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--panel-strong, #1b2434); border: 1px solid var(--line-soft, #26314a); color: var(--text-dim, #94a3b8); }

</style>

