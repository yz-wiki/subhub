<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { NButton, NInput, NModal, NSelect, NTag, useMessage } from 'naive-ui';
import {
  SWATCHES, UNCAT, createIconCat, deleteIconCat, iconCatList,
  moveIconCat, renameIconCat, syncIconCats,
} from './iconCats.js';

const props = defineProps({
  show: { type: Boolean, default: false },
  icons: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:show']);
const message = useMessage();

const rows = ref([]);
const busy = ref('');
const fresh = reactive({ name: '', color: SWATCHES[3] });
const del = reactive({ key: '', target: UNCAT });

const stats = computed(() => {
  const list = rows.value;
  return {
    cats: list.filter((r) => r.key !== UNCAT).length,
    used: list.filter((r) => r.key !== UNCAT && r.count > 0).length,
    icons: props.icons.length,
  };
});

function sync() {
  syncIconCats(props.icons);
  rows.value = iconCatList(props.icons).map((c) => ({
    key: c.key,
    label: c.label,
    color: c.color,
    count: c.count,
    managed: c.managed,
  }));
  if (del.key && !rows.value.some((r) => r.key === del.key)) {
    del.key = '';
    del.target = UNCAT;
  }
}

watch(() => props.show, (open) => { if (open) sync(); });
watch(() => props.icons, () => { if (props.show) sync(); }, { deep: true });

function close() {
  emit('update:show', false);
}

function move(row, delta) {
  if (row.key === UNCAT) return;
  moveIconCat(row.key, delta);
  sync();
}

async function saveRow(row) {
  if (row.key === UNCAT) return;
  busy.value = row.key;
  const out = renameIconCat(row.key, row.label, row.color);
  busy.value = '';
  if (!out) {
    message.warning('分类名称不能为空，也不能与其它分类重名');
    sync();
    return;
  }
  sync();
  message.success(`已保存分类「${out.label}」`);
}

function askDelete(row) {
  if (row.key === UNCAT) return;
  del.key = row.key;
  del.target = UNCAT;
}

function cancelDelete() {
  del.key = '';
  del.target = UNCAT;
}

const delOptions = computed(() => rows.value
  .filter((r) => r.key !== del.key)
  .map((r) => ({ label: `${r.label}（${r.count}）`, value: r.key })));

function confirmDelete() {
  const row = rows.value.find((r) => r.key === del.key);
  if (!row || !del.target) { message.warning('请选择迁移目标分类'); return; }
  if (!deleteIconCat(del.key, del.target)) {
    message.error('删除失败，请换一个迁移目标');
    return;
  }
  const targetLabel = rows.value.find((r) => r.key === del.target)?.label || UNCAT;
  message.success(`已删除「${row.label}」，${row.count} 个图标在界面中迁移到「${targetLabel}」`);
  cancelDelete();
  sync();
}

function addCategory() {
  const key = createIconCat(fresh.name, fresh.color);
  if (!key) { message.warning('请填写不重复的分类名称'); return; }
  const label = fresh.name.trim();
  fresh.name = '';
  fresh.color = SWATCHES[(SWATCHES.indexOf(fresh.color) + 1) % SWATCHES.length];
  sync();
  message.success(`已创建分类「${label}」`);
}

function applySwatch(row, color) {
  row.color = color;
}

sync();
</script>

<template>
  <n-modal
    :show="show" preset="card" title="图标分类管理"
    style="width: 760px; max-width: 96vw" @update:show="close"
  >
    <div class="icm">
      <div class="icm-hint">
        分类名称、颜色与顺序只保存在本机浏览器，用于整理图标；图标自身的分类仍会随上传/编辑写回后端。
      </div>
      <div class="icm-stats">
        <span class="icm-stat"><b>{{ stats.cats }}</b> 个分类</span>
        <span class="icm-stat"><b>{{ stats.used }}</b> 个已使用</span>
        <span class="icm-stat"><b>{{ stats.icons }}</b> 个图标</span>
      </div>

      <div class="icm-list">
        <div
          v-for="(row, index) in rows" :key="row.key" class="icm-row"
          :class="{ 'is-system': row.key === UNCAT }"
        >
          <span class="icm-dot" :style="{ background: row.color }" />
          <n-input
            v-model:value="row.label" size="small" :maxlength="16"
            :disabled="row.key === UNCAT" placeholder="分类名称" style="width: 150px"
          />
          <div class="icm-swatches">
            <button
              v-for="c in SWATCHES" :key="`${row.key}-${c}`" type="button" class="icm-swatch"
              :class="{ on: row.color === c }" :style="{ '--sw': c }" :title="`设为 ${c}`"
              :disabled="row.key === UNCAT" @click="applySwatch(row, c)"
            />
          </div>
          <n-tag size="tiny" :bordered="false">{{ row.count }}</n-tag>
          <span class="icm-spacer" />
          <div class="icm-actions">
            <n-button size="tiny" quaternary :disabled="index === 0 || row.key === UNCAT" title="上移" @click="move(row, -1)">↑</n-button>
            <n-button size="tiny" quaternary :disabled="index === rows.length - 2 || row.key === UNCAT" title="下移" @click="move(row, 1)">↓</n-button>
            <n-button
              size="tiny" type="primary" ghost :loading="busy === row.key"
              :disabled="row.key === UNCAT" @click="saveRow(row)"
            >保存</n-button>
            <n-button size="tiny" type="error" quaternary :disabled="row.key === UNCAT" @click="askDelete(row)">删除</n-button>
          </div>

          <div v-if="del.key === row.key" class="icm-del">
            <span class="icm-del-label">把该分类下的 <b>{{ row.count }}</b> 个图标在界面中迁移到</span>
            <n-select v-model:value="del.target" size="small" :options="delOptions" style="width: 180px" />
            <n-button size="tiny" @click="cancelDelete">取消</n-button>
            <n-button size="tiny" type="error" :disabled="!del.target" @click="confirmDelete">确认删除</n-button>
          </div>
        </div>
      </div>

      <div class="icm-new">
        <b>＋ 新建分类</b>
        <n-input
          v-model:value="fresh.name" size="small" :maxlength="16" placeholder="如 地区 / 服务 / 品牌"
          style="width: 170px" @keyup.enter="addCategory"
        />
        <div class="icm-swatches">
          <button
            v-for="c in SWATCHES" :key="`new-${c}`" type="button" class="icm-swatch"
            :class="{ on: fresh.color === c }" :style="{ '--sw': c }" :title="c"
            @click="fresh.color = c"
          />
        </div>
        <n-button size="small" type="primary" ghost @click="addCategory">创建分类</n-button>
      </div>
    </div>

    <template #footer>
      <div class="icm-footer">
        <span class="icm-hint">删除分类不会修改后端图标，只是在本机把它们归到目标分类。</span>
        <n-button @click="close">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.icm { display: flex; flex-direction: column; gap: 10px; }
.icm-hint { font-size: 12px; line-height: 1.6; color: var(--text-dim); }
.icm-stats { display: flex; gap: 8px; flex-wrap: wrap; }
.icm-stat {
  padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px;
  font-size: 11.5px; color: var(--text-dim); background: var(--panel-strong);
}
.icm-stat b { color: var(--text); margin-right: 2px; }
.icm-list { display: flex; flex-direction: column; gap: 6px; max-height: 46vh; overflow: auto; padding-right: 2px; }
.icm-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 9px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--panel-strong);
}
.icm-row.is-system { opacity: .72; }
.icm-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 10%, transparent); }
.icm-swatches { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.icm-swatch {
  width: 15px; height: 15px; padding: 0; border-radius: 4px; cursor: pointer;
  border: 1px solid var(--line-strong, var(--line)); background: var(--sw);
}
.icm-swatch.on { outline: 2px solid var(--text); outline-offset: 1px; }
.icm-swatch:disabled { cursor: default; opacity: .5; }
.icm-spacer { flex: 1; }
.icm-actions { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.icm-del {
  flex: 1 1 100%; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 4px; padding: 7px 9px; border-radius: 8px;
  border: 1px dashed color-mix(in srgb, #ef4444 45%, var(--line));
  background: color-mix(in srgb, #ef4444 7%, transparent);
}
.icm-del-label { font-size: 12px; color: var(--text-dim); }
.icm-new {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding-top: 10px; margin-top: 2px; border-top: 1px dashed var(--line);
}
.icm-new b { font-size: 12.5px; }
.icm-footer { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
@media (max-width: 620px) {
  .icm-row { align-items: flex-start; }
  .icm-row :deep(.n-input) { width: 100% !important; }
  .icm-spacer { display: none; }
}
</style>
