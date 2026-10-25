<script setup>
import { computed, ref, watch } from 'vue';
import { NModal, NInput, NButton, NSelect, useMessage } from 'naive-ui';
import { api } from '../api.js';
import { state, can } from '../state.js';
import IconCatManager from './IconCatManager.vue';
import {
  ensureIconCat, iconCatChips, iconCatColor, iconCatLabel, iconCatList,
  iconCatOptions, resolveIconCat, syncIconCats,
} from './iconCats.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '选择图标' },
  value: { type: String, default: '' },
});
const emit = defineEmits(['update:show', 'update:value']);

const message = useMessage();
const q = ref('');
const activeCat = ref('');
const uploading = ref(false);
const uploadName = ref('');
const uploadCat = ref('自定义');
const catManageOpen = ref(false);

function normalizeCat(value, create = true) {
  const raw = String(value || '').trim();
  if (!raw) return '自定义';
  const byKey = iconCatList(state.icons).find((c) => c.key === raw);
  if (byKey) return byKey.key;
  const byLabel = iconCatList(state.icons).find((c) => c.label === raw);
  if (byLabel) return byLabel.key;
  if (create) ensureIconCat(raw, raw);
  return raw;
}

const catChips = computed(() => iconCatChips(state.icons, activeCat.value));
const catOptions = computed(() => iconCatOptions(state.icons));

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  return (state.icons || []).filter((it) => {
    const key = resolveIconCat(it.category);
    if (activeCat.value && key !== activeCat.value) return false;
    if (!needle) return true;
    return `${it.name} ${it.category} ${iconCatLabel(key)} ${it.id}`.toLowerCase().includes(needle);
  });
});

const groups = computed(() => {
  const order = iconCatList(state.icons || []).map((c) => c.key);
  const map = new Map();
  for (const it of filtered.value) {
    const key = resolveIconCat(it.category);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return [...map.entries()]
    .map(([key, icons]) => ({
      key,
      label: iconCatLabel(key),
      color: iconCatColor(key),
      icons,
    }))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
});

watch(() => props.show, (open) => {
  if (open) {
    q.value = '';
    activeCat.value = '';
    syncIconCats(state.icons || []);
  }
});
watch(catManageOpen, (open) => {
  if (open) return;
  if (activeCat.value) activeCat.value = resolveIconCat(activeCat.value);
});

function clearFilters() {
  q.value = '';
  activeCat.value = '';
}

function pick(icon) {
  emit('update:value', icon.id);
  emit('update:show', false);
}

function clear() {
  emit('update:value', '');
  emit('update:show', false);
}

async function removeIcon(icon) {
  if (!window.confirm(`删除图标「${icon.name}」？已有订阅里的引用会显示为空白。`)) return;
  try {
    await api(`/api/icons/${encodeURIComponent(icon.id)}`, { method: 'DELETE' });
    const idx = state.icons.findIndex((it) => it.id === icon.id);
    if (idx >= 0) state.icons.splice(idx, 1);
    if (props.value === icon.id) emit('update:value', '');
    message.success('已删除图标');
  } catch (err) {
    message.error(err.payload?.error || err.message || '删除失败');
  }
}

async function readFile(file) {
  if (!file) return;
  if (file.size > 96 * 1024) {
    message.warning('图片不能超过 96KB');
    return;
  }
  const category = normalizeCat(uploadCat.value, true);
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = String(reader.result || '');
    uploading.value = true;
    try {
      const name = (uploadName.value || file.name.replace(/\.[^.]+$/, '')).slice(0, 24);
      const out = await api('/api/icons', {
        method: 'POST',
        body: { name, value: dataUrl, category },
      });
      state.icons.push(out.icon);
      ensureIconCat(out.icon.category, iconCatLabel(out.icon.category));
      emit('update:value', out.icon.id);
      emit('update:show', false);
      message.success(`已上传图标 ${out.icon.name}（分类：${iconCatLabel(out.icon.category)}）`);
    } catch (err) {
      message.error(err.payload?.error || err.message || '上传失败');
    } finally {
      uploading.value = false;
    }
  };
  reader.readAsDataURL(file);
}

function onFile(event) {
  const file = event.target.files && event.target.files[0];
  readFile(file);
  event.target.value = '';
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    style="width: 780px; max-width: 94vw"
    :bordered="false"
    @update:show="(v) => emit('update:show', v)"
  >
    <div class="icon-picker">
      <div class="picker-toolbar">
        <n-input v-model:value="q" clearable placeholder="搜索图标名称、分类或 id…" />
        <n-tag size="small" :bordered="false">{{ filtered.length }} / {{ state.icons.length }}</n-tag>
        <span class="spacer" />
        <n-button size="small" quaternary @click="catManageOpen = true">分类管理</n-button>
        <n-button size="small" quaternary @click="clear">清除选择</n-button>
      </div>

      <div class="picker-chips">
        <button
          v-for="c in catChips" :key="c.key || 'all'" type="button"
          class="picker-chip" :class="{ active: activeCat === c.key }"
          :style="{ '--chip-color': c.color }" @click="activeCat = c.key"
        >
          <span v-if="c.key" class="chip-dot" :style="{ background: c.color }" />
          {{ c.label }} <span class="picker-num">{{ c.count }}</span>
        </button>
      </div>

      <div v-if="!groups.length" class="icon-empty picker-empty">
        <span class="picker-empty-glyph">◌</span>
        <b>{{ q.trim() ? '没有匹配的图标' : activeCat ? '这个分类下还没有图标' : '图标库为空' }}</b>
        <p class="hint">
          {{ q.trim()
            ? `没有与「${q.trim()}」匹配的图标，换个关键词试试。`
            : activeCat
              ? `「${iconCatLabel(activeCat)}」分类下还没有图标。`
              : '可以在下方上传自己的图标，或先在图标库里添加。' }}
        </p>
        <div class="picker-empty-actions">
          <n-button v-if="q.trim() || activeCat" size="small" quaternary @click="clearFilters">查看全部图标</n-button>
          <n-button size="small" quaternary @click="catManageOpen = true">管理分类</n-button>
        </div>
      </div>

      <div v-for="g in groups" :key="g.key" class="picker-section">
        <div class="picker-section-head">
          <span class="chip-dot" :style="{ background: g.color }" />
          <b>{{ g.label }}</b>
          <span class="picker-num">{{ g.icons.length }}</span>
        </div>
        <div class="icon-grid">
          <button
            v-for="icon in g.icons"
            :key="icon.id"
            type="button"
            class="icon-cell"
            :class="{ active: value === icon.id }"
            :title="`${icon.name} · ${icon.id}`"
            @click="pick(icon)"
          >
            <span class="icon-face">
              <img v-if="String(icon.value).startsWith('data:')" :src="icon.value" :alt="icon.name" />
              <template v-else>{{ icon.value }}</template>
            </span>
            <span class="icon-name">{{ icon.name }}</span>
            <span
              v-if="!icon.builtin && can('icons:write')"
              class="icon-del"
              title="删除图标"
              @click.stop="removeIcon(icon)"
            >✕</span>
          </button>
        </div>
      </div>

      <div v-if="can('icons:write')" class="picker-upload">
        <div class="picker-section-head"><b>上传自定义图标</b><span class="hint">PNG / JPEG / WebP / SVG，单张 ≤96KB</span></div>
        <div class="picker-upload-row">
          <n-input v-model:value="uploadName" placeholder="图标名称（可选，默认用文件名）" style="max-width: 220px" />
          <n-select
            v-model:value="uploadCat" :options="catOptions" filterable tag
            placeholder="分类，默认「自定义」" style="width: 170px"
          />
          <label class="file-btn">
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" @change="onFile" />
            {{ uploading ? '上传中…' : '选择图片' }}
          </label>
        </div>
        <p class="hint">内置图标只读；自定义图标可在卡片右上角删除。分类名称与颜色只保存在本机浏览器。</p>
      </div>
    </div>
  </n-modal>

  <IconCatManager v-model:show="catManageOpen" :icons="state.icons || []" />
</template>

<style scoped>
.picker-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.picker-toolbar .n-input { flex: 1 1 220px; }
.spacer { margin-left: auto; }
.picker-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 11px 0 4px; }
.picker-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 25px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel-strong);
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: color .12s, border-color .12s, background .12s;
}
.picker-chip:hover {
  color: var(--text);
  border-color: color-mix(in srgb, var(--chip-color, var(--accent)) 60%, var(--line));
}
.picker-chip.active {
  color: var(--text);
  border-color: var(--chip-color, var(--accent));
  background: color-mix(in srgb, var(--chip-color, var(--accent)) 14%, var(--panel-strong));
}
.chip-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
.picker-num { font-size: 10px; color: var(--text-dim); }
.picker-section { margin-top: 10px; }
.picker-section-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-bottom: 6px;
  margin-bottom: 8px;
  border-bottom: 1px dashed var(--line-soft);
}
.picker-section-head b { font-size: 12.5px; }
.picker-section-head .hint { font-size: 11px; }
.picker-upload {
  margin-top: 14px;
  padding: 11px 12px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  background: var(--panel-strong);
}
.picker-upload-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.picker-empty { padding: 30px 14px; }
.picker-empty-glyph { font-size: 30px; line-height: 1; color: var(--text-dim); opacity: .6; }
.picker-empty p { margin: 0; max-width: 440px; font-size: 12px; }
.picker-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 2px; }
.icon-cell { position: relative; }
.icon-del {
  position: absolute; top: 2px; right: 3px; font-size: 10px; line-height: 1;
  padding: 2px 3px; border-radius: 4px; color: var(--text-dim); opacity: 0; transition: opacity .12s ease;
}
.icon-cell:hover .icon-del,
.icon-cell:focus-within .icon-del { opacity: 1; }
.icon-del:hover { color: #ef4444; background: rgba(239, 68, 68, .12); }
@media (max-width: 620px) {
  .picker-upload-row > * { width: 100% !important; max-width: none; }
}
</style>
