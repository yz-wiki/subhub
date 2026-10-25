<script setup>
import { computed } from 'vue';

/* 规则集悬浮说明：只展示 data/rulesetMeta.json 的目录信息（名称 / 说明 / 标签 / 体量）。
   刻意不展示 urls、仓库主页等来源地址，避免提示框变成外链面板。 */
const props = defineProps({
  meta: { type: Object, default: null },
  name: { type: String, default: '' },
  desc: { type: String, default: '' },
  tags: { type: Array, default: () => [] },
});

const NOISE = /^(附录|[A-Z]\.\d|第[一二三四五六七八九十0-9]{1,3}[章节部分])/;
const PALETTE = ['#60a5fa', '#a78bfa', '#f472b6', '#facc15', '#4ade80', '#fb923c', '#38bdf8', '#fb7185'];
const RULES = [
  [/广告|拦截|去广告|追踪/i, '#f87171'],
  [/常用|推荐|必备/, '#fbbf24'],
  [/流媒体|视频|音乐|影视/, '#c084fc'],
  [/游戏/, '#34d399'],
  [/国内|大陆|直连|cn/i, '#38bdf8'],
  [/社交|通讯/i, '#22d3ee'],
  [/ai|人工智能|大模型/i, '#818cf8'],
  [/代理|gfw|兜底/i, '#fb923c'],
];

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function colorOf(tag) {
  const text = String(tag || '').trim();
  const hit = RULES.find(([re]) => re.test(text));
  return hit ? hit[1] : PALETTE[hash(text) % PALETTE.length];
}

const metaName = computed(() => String((props.meta && props.meta.name) || '').trim());
const ownName = computed(() => String(props.name || '').trim());
/* 对照表里的 name 常是文档章节名（「附录 A、全量索引」「A.1 geoip（260）」），
   所以优先用调用方传入的显示名，meta.name 只在干净时作为别名补充。 */
const title = computed(() => {
  if (ownName.value) return ownName.value;
  return NOISE.test(metaName.value) ? '' : metaName.value;
});
const aliasName = computed(() => {
  if (!metaName.value || NOISE.test(metaName.value) || metaName.value === title.value) return '';
  return metaName.value;
});
/* 对照表的 desc 常带「10.1 国际视频：」「A.1 geoip（260）：」这类文档前缀，剥掉更顺眼 */
const descText = computed(() => {
  const raw = String((props.meta && props.meta.desc) || props.desc || '').trim();
  if (!raw) return '';
  const cut = raw.indexOf('：');
  if (cut <= 0 || cut > 24) return raw;
  const head = raw.slice(0, cut).trim();
  const docLike = /^(附录|A\.\d|\d+(\.\d+)*\s|第[一二三四五六七八九十0-9]{1,3}[章节部分])/.test(head);
  if (!metaName.value || head === metaName.value || docLike) return raw.slice(cut + 1).trim();
  return raw;
});
const tipTags = computed(() => {
  const out = [];
  const add = (tag) => {
    const text = String(tag || '').trim();
    if (!text || text.length > 16 || NOISE.test(text) || text === '其它' || text === '全量索引' || out.includes(text)) return;
    out.push(text);
  };
  (Array.isArray(props.tags) ? props.tags : []).forEach(add);
  (((props.meta && props.meta.tags) || [])).forEach(add);
  return out.slice(0, 8);
});
const countText = computed(() => {
  const count = Number((props.meta && props.meta.count) || 0);
  return count > 0 ? `${count.toLocaleString('en-US')} 条` : '';
});
const sizeText = computed(() => String((props.meta && props.meta.size) || '').trim());
</script>

<template>
  <div class="meta-tip">
    <div class="tip-head">
      <b>{{ title || '目录条目' }}</b>
      <span v-if="aliasName" class="tip-alias">{{ aliasName }}</span>
    </div>
    <p v-if="descText" class="tip-desc">{{ descText }}</p>
    <div v-if="tipTags.length" class="tip-tags">
      <span v-for="t in tipTags" :key="t" class="tip-tag" :style="{ '--tip-color': colorOf(t) }">{{ t }}</span>
    </div>
    <div v-if="countText || sizeText" class="tip-foot">
      <span v-if="countText">规则 {{ countText }}</span>
      <span v-if="sizeText">文件 {{ sizeText }}</span>
    </div>
  </div>
</template>

<style scoped>
.meta-tip {
  max-width: 300px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 1px;
  text-align: left;
  white-space: normal;
}
.tip-head { display: flex; align-items: center; gap: 6px; }
.tip-head b { font-size: 12.5px; line-height: 1.35; }
.tip-alias {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 5px;
  opacity: .7;
  border: 1px solid rgba(148, 163, 184, .35);
}
.tip-desc { margin: 0; font-size: 11.5px; line-height: 1.55; opacity: .82; }
.tip-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tip-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 1;
  color: color-mix(in srgb, var(--tip-color, #94a3b8) 80%, #e5e7eb);
  border: 1px solid color-mix(in srgb, var(--tip-color, #94a3b8) 42%, transparent);
  background: color-mix(in srgb, var(--tip-color, #94a3b8) 16%, transparent);
}
.tip-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10.5px;
  opacity: .6;
  font-variant-numeric: tabular-nums;
}
</style>
