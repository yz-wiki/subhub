import { reactive } from 'vue';

/**
 * 图标分类的「本机展示层」元数据。
 *
 * 后端图标只有 category 字符串，没有分类 CRUD 接口，因此分类的显示名、颜色、
 * 顺序与删除后的迁移关系都保存在 localStorage。图标本身的 category 仍会在
 * 上传/编辑时写回后端；这里只影响界面如何分组、配色与排序。
 */
export const PRESET_COLORS = [
  '#6d7dff', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4',
  '#a855f7', '#ef4444', '#14b8a6', '#f97316', '#64748b',
];
/** 分类编辑面板里只放 8 个常用色，避免一行过长。 */
export const SWATCHES = PRESET_COLORS.slice(0, 8);
export const ICON_CAT_STORE = 'subhub.iconCategories.v1';
export const UNCAT = '未分类';

export function hashString(value) {
  const s = String(value || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function iconFallbackColor(key) {
  return PRESET_COLORS[hashString(key) % PRESET_COLORS.length];
}

function loadStore() {
  const empty = { cats: [], merges: {} };
  try {
    if (typeof localStorage === 'undefined') return empty;
    const raw = JSON.parse(localStorage.getItem(ICON_CAT_STORE) || '{}');
    const cats = Array.isArray(raw.cats)
      ? raw.cats
        .filter((c) => c && String(c.key || '').trim())
        .map((c, i) => ({
          key: String(c.key).trim(),
          label: String(c.label || c.key).trim() || String(c.key).trim(),
          color: /^#[0-9a-f]{3,8}$/i.test(String(c.color || '')) ? String(c.color) : '',
          order: Number.isFinite(c.order) ? c.order : i,
        }))
      : [];
    const merges = raw.merges && typeof raw.merges === 'object'
      ? Object.fromEntries(Object.entries(raw.merges).filter(([k, v]) => k && typeof v === 'string' && v && k !== v))
      : {};
    return { cats, merges };
  } catch { return empty; }
}

export const iconCatStore = reactive(loadStore());

export function saveIconCatStore() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ICON_CAT_STORE, JSON.stringify({
      cats: iconCatStore.cats,
      merges: iconCatStore.merges,
    }));
  } catch { /* 本机存储不可用时静默降级，页面仍可正常使用 */ }
}

function nextOrder() {
  return iconCatStore.cats.reduce((max, c) => Math.max(max, Number(c.order) || 0), 0) + 10;
}

export function iconCatMeta(key) {
  return iconCatStore.cats.find((c) => c.key === key) || null;
}

/** 确保某个 category 在展示层有元数据；新建图标分类或首次上传时调用。 */
export function ensureIconCat(key, label, color) {
  const k = String(key || '').trim() || UNCAT;
  let meta = iconCatMeta(k);
  if (!meta) {
    meta = {
      key: k,
      label: String(label || k).trim() || k,
      color: color || iconFallbackColor(k),
      order: nextOrder(),
    };
    iconCatStore.cats.push(meta);
    saveIconCatStore();
  } else if (color && meta.color !== color) {
    meta.color = color;
    saveIconCatStore();
  }
  return meta;
}

/** 删除分类后，旧 key 通过 merges 链迁移到目标分类。 */
export function resolveIconCat(name) {
  let key = String(name || '').trim() || UNCAT;
  const seen = new Set();
  while (iconCatStore.merges[key] && !seen.has(key)) {
    seen.add(key);
    key = iconCatStore.merges[key];
  }
  return key;
}

export function iconCatLabel(key) {
  if (!key) return '全部';
  const meta = iconCatMeta(key);
  if (meta) return meta.label;
  return resolveIconCat(key);
}

export function iconCatColor(key) {
  if (!key) return 'var(--accent)';
  return iconCatMeta(key)?.color || iconFallbackColor(key);
}

function sortedCats() {
  return iconCatStore.cats
    .filter((c) => c.key !== UNCAT)
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.label).localeCompare(String(b.label), 'zh-CN'));
}

/**
 * 分类 + 数量。icons 里出现但展示层还没有元数据的分类会以只读条目补在末尾，
 * 这样不会因为一次渲染就偷偷写 localStorage。
 */
export function iconCatList(icons) {
  const counts = new Map();
  for (const it of icons || []) {
    const key = resolveIconCat(it.category);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const out = sortedCats().map((c) => ({
    key: c.key,
    label: c.label,
    color: c.color || iconFallbackColor(c.key),
    count: counts.get(c.key) || 0,
    managed: true,
  }));
  const known = new Set(out.map((c) => c.key));
  for (const [key, count] of counts) {
    if (known.has(key)) continue;
    out.push({
      key,
      label: key === UNCAT ? UNCAT : (iconCatMeta(key)?.label || key),
      color: iconCatMeta(key)?.color || (key === UNCAT ? '#94a3b8' : iconFallbackColor(key)),
      count,
      managed: false,
    });
  }
  out.push({
    key: UNCAT,
    label: UNCAT,
    color: iconCatMeta(UNCAT)?.color || '#94a3b8',
    count: counts.get(UNCAT) || 0,
    managed: false,
  });
  return out;
}

/** chips 只展示有图标的分类，外加当前选中项（即使为空也保留，避免筛选状态消失）。 */
export function iconCatChips(icons, active = '') {
  const list = iconCatList(icons);
  return [{ key: '', label: '全部', color: 'var(--accent)', count: (icons || []).length }]
    .concat(list.filter((c) => c.count > 0 || c.key === active));
}

export function iconCatOptions(icons) {
  const opts = iconCatList(icons)
    .filter((c) => c.managed)
    .map((c) => ({ label: c.label, value: c.key }));
  if (!opts.some((o) => o.value === '自定义')) opts.push({ label: '自定义', value: '自定义' });
  return opts;
}

export function createIconCat(label, color) {
  const clean = String(label || '').trim().slice(0, 16);
  if (!clean) return null;
  const byKey = iconCatMeta(clean);
  if (byKey) return byKey.key;
  const byLabel = iconCatStore.cats.find((c) => c.label === clean);
  if (byLabel) return byLabel.key;
  const key = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  iconCatStore.cats.push({
    key,
    label: clean,
    color: color || iconFallbackColor(clean),
    order: nextOrder(),
  });
  saveIconCatStore();
  return key;
}

export function renameIconCat(key, label, color) {
  const meta = iconCatMeta(key);
  if (!meta || key === UNCAT) return null;
  const clean = String(label || '').trim().slice(0, 16);
  if (!clean) return null;
  const clash = iconCatStore.cats.find((c) => c.key !== key && c.label === clean);
  if (clash) return null;
  meta.label = clean;
  if (color) meta.color = color;
  saveIconCatStore();
  return meta;
}

export function moveIconCat(key, delta) {
  const cats = sortedCats();
  const index = cats.findIndex((c) => c.key === key);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= cats.length) return false;
  [cats[index], cats[next]] = [cats[next], cats[index]];
  cats.forEach((c, i) => { c.order = i * 10; });
  saveIconCatStore();
  return true;
}

export function deleteIconCat(key, targetKey) {
  if (!key || key === UNCAT) return false;
  const target = resolveIconCat(targetKey || UNCAT);
  if (!target || target === key) return false;
  iconCatStore.merges[key] = target;
  const meta = iconCatMeta(key);
  if (meta && meta.label !== key) iconCatStore.merges[meta.label] = target;
  iconCatStore.cats = iconCatStore.cats.filter((c) => c.key !== key);
  saveIconCatStore();
  return true;
}

/** 把 state.icons 里出现的分类补进展示层，便于管理弹窗统一改名/配色。 */
export function syncIconCats(icons) {
  let changed = false;
  for (const it of icons || []) {
    const key = String(it.category || '').trim() || UNCAT;
    if (!iconCatMeta(key)) {
      iconCatStore.cats.push({
        key,
        label: key,
        color: iconFallbackColor(key),
        order: nextOrder(),
      });
      changed = true;
    }
  }
  if (changed) saveIconCatStore();
}
