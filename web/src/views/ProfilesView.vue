<script setup>
import { computed, ref, watch } from 'vue';
import { NButton, NModal, NInput, NSelect, NCheckbox, NCheckboxGroup, useMessage, useDialog } from 'naive-ui';
import { state, loadState, targetById, can } from '../state.js';
import { api } from '../api.js';
import UiIcon from '../components/UiIcon.vue';
import ProfileLinkDialog from '../components/ProfileLinkDialog.vue';

const message = useMessage();
const dialog = useDialog();
const loading = ref(false);
const saving = ref(false);
const busyToken = ref('');
const editing = ref(null);
const editOpen = ref(false);
const adv = ref(false);
const redeemOpen = ref(false);
const redeemCode = ref('');
const redeemBusy = ref(false);
/* 统一「订阅配置」弹窗：链接、二维码、下载与预览都在里面 */
const subOpen = ref(false);
const subProfile = ref(null);

/* 后端 GET /api/profiles 返回 { profiles }；共享的 state.loadProfiles 仍按旧字段读取，
   这里按真实响应装载，避免订阅页看到空列表。 */
async function refresh() {
  if (!can('subscribe')) return;
  loading.value = true;
  try {
    const data = await api('/api/profiles');
    state.profiles = data.profiles || data.items || [];
  } catch (e) {
    message.error(e.message || '加载失败');
  } finally {
    loading.value = false;
  }
}

const form = ref({ name: '', note: '', sources: '', template: '', targets: ['mihomo'], cacheTtl: '', updateInterval: 6, enabled: true });
const targetOptions = computed(() => state.targets.map((t) => ({ label: t.label, value: t.id })));
const templateOptions = computed(() => state.templates.map((t) => ({ label: t.title || t.name, value: t.name })));

const user = computed(() => state.auth.user || {});
const quota = computed(() => user.value.quota || {});

/* 后端目前只下发 maxProfiles；节点 / 模板 / 导入源沿用产品默认上限，
   若后续 quota 扩展了同名字段则自动采用。 */
const NODE_CAP = 100;
const SOURCE_CAP_PER_KIND = 2;
const profileCap = computed(() => Number(quota.value.maxProfiles) || 0);
const nodeCap = computed(() => Number(quota.value.maxNodes) || NODE_CAP);
const templateCap = computed(() => Number(quota.value.maxTemplates) || 1);
const templateUsed = computed(() => Number(quota.value.usedTemplates) || 0);
const sourceCap = computed(() => Number(quota.value.maxSourcesPerKind) || SOURCE_CAP_PER_KIND);

const stats = computed(() => [
  {
    key: 'profiles',
    icon: 'file-code',
    tint: 'blue',
    label: '订阅配额',
    value: state.profiles.length,
    suffix: `/${profileCap.value || '∞'}`,
  },
  {
    key: 'nodes',
    icon: 'server',
    tint: 'violet',
    label: '节点上限配额',
    value: nodeCap.value,
    suffix: '/订阅',
  },
  {
    key: 'templates',
    icon: 'database',
    tint: 'green',
    label: '模板配额',
    value: templateUsed.value,
    suffix: `/${templateCap.value}`,
  },
  {
    key: 'sources',
    icon: 'link',
    tint: 'indigo',
    label: '导入源配额',
    value: sourceCap.value,
    suffix: '/每种',
  },
]);

function openNew() {
  editing.value = null;
  adv.value = false;
  form.value = {
    name: '',
    note: '',
    sources: '',
    template: (state.templates[0] || {}).name || '',
    targets: ['mihomo'],
    cacheTtl: '',
    updateInterval: 6,
    enabled: true,
  };
  editOpen.value = true;
}

function openEdit(p, advanced) {
  if (!advanced) {
    location.hash = `#/convert?profile=${encodeURIComponent(p.token)}`;
    return;
  }
  editing.value = p;
  adv.value = true;
  const allowed = (p.allowedTargets && p.allowedTargets.length ? p.allowedTargets : ['mihomo']);
  form.value = {
    name: p.name,
    note: p.note || '',
    sources: (p.sources || []).join('\n'),
    template: p.template,
    targets: allowed.slice(),
    cacheTtl: p.cacheTtl === null || p.cacheTtl === undefined ? '' : String(p.cacheTtl),
    updateInterval: p.updateInterval || 6,
    enabled: p.enabled !== false,
  };
  editOpen.value = true;
}

async function save() {
  const ttl = String(form.value.cacheTtl || '').trim();
  const body = {
    name: form.value.name.trim(),
    note: form.value.note.trim(),
    sources: form.value.sources.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    template: form.value.template,
    allowedTargets: form.value.targets,
    cacheTtl: ttl === '' ? null : Number(ttl),
    updateInterval: Number(form.value.updateInterval) || 6,
    enabled: !!form.value.enabled,
  };
  if (!body.name) { message.error('请填写订阅名称'); return; }
  const hasNodes = !!(editing.value && (editing.value.nodes || []).length);
  if (!body.sources.length && !hasNodes) { message.error('请至少填写一个上游订阅链接'); return; }
  saving.value = true;
  try {
    if (editing.value) await api(`/api/profiles/${encodeURIComponent(editing.value.token)}`, { method: 'PUT', body });
    else await api('/api/profiles', { method: 'POST', body });
    message.success('订阅已保存');
    editOpen.value = false;
    await refresh();
  } catch (e) {
    message.error(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

function remove(p) {
  dialog.warning({
    title: '删除订阅',
    content: `确定删除「${p.name}」？已分发的链接会立即失效。`,
    positiveText: '删除',
    negativeText: '取消',
    positiveButtonProps: { type: 'error' },
    onPositiveClick: async () => {
      try {
        await api(`/api/profiles/${encodeURIComponent(p.token)}`, { method: 'DELETE' });
        message.success('已删除');
        await refresh();
      } catch (e) { message.error(e.message || '删除失败'); }
    },
  });
}

async function copy(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制到剪贴板');
    return;
  } catch { /* 回退到 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    message.success('已复制到剪贴板');
  } catch {
    message.error('复制失败，请手动选择');
  }
}

function primaryLink(p) {
  const targets = (p.allowedTargets && p.allowedTargets.length ? p.allowedTargets : Object.keys(p.links || {}));
  for (const t of targets) if (p.links && p.links[t]) return p.links[t];
  return (p.links && p.links.auto) || '';
}

/* 行内「刷新」：调用现有自检接口，重新拉取上游并转换全部客户端格式 */
async function refreshProfile(p) {
  if (busyToken.value) return;
  busyToken.value = p.token;
  try {
    const data = await api(`/api/profiles/${encodeURIComponent(p.token)}/test`, { method: 'POST' });
    const results = data.results || [];
    const ok = results.filter((r) => r.ok).length;
    message.success(`已刷新「${p.name}」：${ok}/${results.length} 个客户端格式可用（${(data.ms || 0)} ms）`);
    await refresh();
  } catch (e) {
    message.error(e.message || '刷新失败');
  } finally {
    busyToken.value = '';
  }
}

const EXT_BY_TARGET = {
  mihomo: 'yaml',
  stash: 'yaml',
  singbox: 'json',
  daed: 'txt',
  v2ray: 'txt',
};
const MIME_BY_EXT = {
  yaml: 'application/yaml;charset=utf-8',
  json: 'application/json;charset=utf-8',
  conf: 'text/plain;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
};

function downloadKey(p) {
  const allowed = Array.isArray(p.allowedTargets) && p.allowedTargets.length ? p.allowedTargets : [];
  const hit = allowed.find((t) => p.links && p.links[t]);
  if (hit) return hit;
  return Object.keys(p.links || {}).find((k) => k !== 'auto') || 'auto';
}

async function download(p, target) {
  const key = target || downloadKey(p);
  const url = (p.links || {})[key] || primaryLink(p);
  if (!url) { message.error('该订阅还没有可用链接'); return; }
  const ext = EXT_BY_TARGET[key] || 'conf';
  const safeName = String(p.name || 'subscription').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'subscription';
  const label = key === 'auto' ? '通用' : (targetById(key) || {}).label || key;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error((text || '').replace(/^#\s*/, '').trim() || `下载失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(new Blob([blob], { type: MIME_BY_EXT[ext] || blob.type }));
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `${safeName}-${key}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    message.success(`已开始下载 ${label} 配置`);
  } catch (e) {
    message.error(e.message || '下载失败');
  }
}

const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(v) {
  if (!v) return '从未';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtUpdated(p) {
  if (!p.updatedAt || !p.createdAt) return '从未';
  if (new Date(p.updatedAt).getTime() <= new Date(p.createdAt).getTime()) return '从未';
  return fmtTime(p.updatedAt);
}
function go(view) { state.view = view; }

/* ——— 二维码 ——— */
let qrLoader = null;
function qrLibUrl() {
  // 始终走当前页面同源，避免 publicBase 指向对外域名时跨域或不可达
  return new URL('vendor/qrcode.js', document.baseURI).href;
}
function loadQrLib() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!qrLoader) {
    qrLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = qrLibUrl();
      s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('二维码库未就绪')));
      s.onerror = () => reject(new Error('二维码库加载失败'));
      document.head.appendChild(s);
    });
  }
  return qrLoader;
}

/* 统一「配置」弹窗：一条订阅里列出全部客户端，切换后复制链接、扫码、下载或预览 */
function openSub(p) {
  subProfile.value = p;
  subOpen.value = true;
}

/* ——— 兑换码 ——— */
async function redeem() {
  const code = redeemCode.value.trim();
  if (!code) { message.error('请输入兑换码'); return; }
  redeemBusy.value = true;
  try {
    const data = await api('/api/invites/redeem', { method: 'POST', body: { code } });
    const g = data.granted || {};
    const bits = [];
    if (g.dailyConvert) bits.push(`转换 ${g.dailyConvert} 次/天`);
    if (g.dailyPull) bits.push(`拉取 ${g.dailyPull} 次/天`);
    if (g.maxProfiles) bits.push(`订阅上限 ${g.maxProfiles}`);
    if (g.clients && g.clients.length) bits.push(`客户端 ${g.clients.length} 个`);
    if (g.expiresAt) bits.push(`到期 ${g.expiresAt}`);
    message.success(bits.length ? `兑换成功：${bits.join('，')}` : '兑换成功');
    redeemOpen.value = false;
    redeemCode.value = '';
    await loadState();
  } catch (e) { message.error(e.message || '兑换失败'); }
}

/* 直接刷新 /#/profiles 时，本组件会先于 loadState 挂载；
   等登录态与权限就绪后再拉取订阅，避免首屏误判为空列表。 */
let hydrated = false;
watch(
  () => [state.loading, can('subscribe')],
  ([busy, allowed]) => {
    if (busy) return;
    if (!allowed) { hydrated = false; return; }
    if (hydrated) return;
    hydrated = true;
    refresh();
  },
  { immediate: true },
);
</script>

<template>
  <div class="page sub-page">
    <header class="sub-head">
      <div class="sub-heading">
        <h1 class="sub-title">我的订阅</h1>
        <p class="sub-subtitle">管理您的订阅链接</p>
      </div>
      <div class="sub-head-actions">
        <button type="button" class="btn btn-ghost" @click="redeemOpen = true">
          <UiIcon name="ticket" :size="15" />
          兑换码
        </button>
        <button type="button" class="btn btn-primary" :disabled="!can('subscribe')" @click="openNew">
          <UiIcon name="plus" :size="16" :stroke="2" />
          新建订阅
        </button>
      </div>
    </header>

    <div v-if="!can('subscribe')" class="perm-note">
      <UiIcon name="alert-circle" :size="15" />
      当前账号没有订阅权限，请联系管理员开通后重试。
    </div>

    <div class="stat-grid">
      <div v-for="s in stats" :key="s.key" class="stat-card">
        <span class="stat-ico" :class="'tint-' + s.tint">
          <UiIcon :name="s.icon" :size="22" :stroke="1.8" />
        </span>
        <div class="stat-copy">
          <div class="stat-label">{{ s.label }}</div>
          <div class="stat-value">{{ s.value }}<span class="stat-suffix">{{ s.suffix }}</span></div>
        </div>
      </div>
    </div>

    <section class="panel list-panel">
      <div class="panel-head">
        <h2 class="panel-title">订阅列表</h2>
      </div>

      <div v-if="(loading || state.loading) && !state.profiles.length" class="list-state">正在加载订阅…</div>

      <div v-else-if="!state.profiles.length" class="empty">
        <span class="empty-ico"><UiIcon name="file-text" :size="26" :stroke="1.5" /></span>
        <div class="empty-title">还没有订阅</div>
        <div class="empty-desc">创建订阅后，每个客户端都会获得独立链接，上游节点变更会自动跟随。</div>
        <button type="button" class="btn btn-primary" :disabled="!can('subscribe')" @click="openNew">
          <UiIcon name="plus" :size="16" :stroke="2" />
          新建订阅
        </button>
      </div>

      <div v-else class="list-body">
        <div v-for="p in state.profiles" :key="p.token" class="prow">
          <span class="prow-ico"><UiIcon name="file-code" :size="20" :stroke="1.8" /></span>

          <div class="prow-main">
            <div class="prow-name">
              {{ p.name }}
              <span v-if="p.enabled === false" class="prow-off">已停用</span>
            </div>
            <div class="prow-meta">
              <span class="meta-item"><UiIcon name="clock" :size="12" />创建于 {{ fmtTime(p.createdAt) }}</span>
              <span class="meta-dot">·</span>
              <span class="meta-item"><UiIcon name="clock" :size="12" />更新于 {{ fmtUpdated(p) }}</span>
            </div>
          </div>

          <div class="prow-actions">
            <button type="button" class="act" @click="openEdit(p, false)">
              <UiIcon name="pencil" :size="14" />编辑
            </button>
            <button type="button" class="act" @click="openEdit(p, true)">
              <UiIcon name="settings" :size="14" />设置
            </button>
            <button type="button" class="act" :disabled="busyToken === p.token" @click="refreshProfile(p)">
              <UiIcon name="refresh" :size="14" :class="{ spin: busyToken === p.token }" />刷新
            </button>
            <button type="button" class="act" @click="openSub(p)">
              <UiIcon name="file-code" :size="14" />配置
            </button>
            <button type="button" class="act danger" @click="remove(p)">
              <UiIcon name="trash" :size="14" />删除
            </button>
          </div>
        </div>
      </div>
    </section>

    <div class="tiles">
      <button type="button" class="tile" @click="go('library')">
        <span class="tile-ico tint-violet"><UiIcon name="file-plus" :size="22" :stroke="1.8" /></span>
        <span class="tile-copy">
          <b>我的模板</b>
          <small>管理和分享您的配置模板</small>
        </span>
        <UiIcon class="tile-go" name="external" :size="18" />
      </button>
      <button type="button" class="tile" @click="go('system')">
        <span class="tile-ico tint-gray"><UiIcon name="settings" :size="22" :stroke="1.8" /></span>
        <span class="tile-copy">
          <b>账户设置</b>
          <small>管理您的账户和数据导出</small>
        </span>
        <UiIcon class="tile-go" name="external" :size="18" />
      </button>
    </div>

    <!-- 新建 / 编辑 -->
    <n-modal v-model:show="editOpen" preset="card" :title="editing ? `编辑订阅：${editing.name}` : '新建订阅'" style="width: 680px; max-width: 94vw">
      <div class="stack">
        <n-input v-model:value="form.name" placeholder="订阅名称" />
        <n-input v-model:value="form.note" placeholder="备注（可选）" />
        <n-input v-model:value="form.sources" type="textarea" :rows="4" placeholder="上游订阅链接，每行一个（可选，也可以只使用自定义节点）" />
        <div class="form-grid">
          <n-select v-model:value="form.template" :options="templateOptions" placeholder="模板" />
          <n-checkbox v-model:checked="form.enabled">启用该订阅</n-checkbox>
        </div>
        <div>
          <div class="field-label">允许的客户端</div>
          <n-checkbox-group v-model:value="form.targets">
            <div class="target-grid">
              <n-checkbox v-for="t in targetOptions" :key="t.value" :value="t.value" :label="t.label" />
            </div>
          </n-checkbox-group>
        </div>
        <div>
          <button type="button" class="text-toggle" @click="adv = !adv">{{ adv ? '收起高级选项' : '高级选项' }}</button>
        </div>
        <div v-if="adv" class="form-grid">
          <n-input v-model:value="form.cacheTtl" placeholder="缓存秒数（可选，留空使用服务端默认）" />
          <n-input v-model:value="form.updateInterval" placeholder="客户端更新间隔（小时）" />
        </div>
      </div>
      <template #footer>
        <div class="modal-footer">
          <n-button @click="editOpen = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="save">保存</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 统一「配置」弹窗：客户端选择 + 链接 / 二维码 / 下载 + 预览 -->
    <ProfileLinkDialog
      v-model:show="subOpen"
      :profile="subProfile"
      :load-qr="loadQrLib"
      :download="download"
      @copy="copy"
    />

    <!-- 兑换码 -->
    <n-modal v-model:show="redeemOpen" preset="card" title="兑换码" style="width: 460px; max-width: 92vw">
      <div class="stack">
        <p class="redeem-tip">输入管理员发放的兑换码，可叠加转换次数、拉取次数、订阅上限、可用客户端与有效期。</p>
        <n-input v-model:value="redeemCode" placeholder="例如 SUB-XXXX-XXXX" @keyup.enter="redeem" />
      </div>
      <template #footer>
        <div class="modal-footer">
          <n-button @click="redeemOpen = false">取消</n-button>
          <n-button type="primary" :loading="redeemBusy" @click="redeem">兑换</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.sub-page {
  --sp-card: #ffffff;
  --sp-card-soft: #f8fafc;
  --sp-row: #f3f5f7;
  --sp-row-hover: #eceff4;
  --sp-line: rgba(15, 23, 42, 0.08);
  --sp-line-soft: rgba(15, 23, 42, 0.05);
  --sp-text: #0f172a;
  --sp-dim: #64748b;
  --sp-faint: #94a3b8;
  --sp-primary: #2563eb;
  --sp-primary-soft: #eef4ff;
  --sp-danger: #dc2626;
  --sp-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.04);
  display: flex;
  flex-direction: column;
  gap: 26px;
  max-width: 1600px;
  padding-left: 35px;
  padding-right: 35px;
  color: var(--sp-text);
  background-image:
    radial-gradient(1200px 460px at 18% -8%, rgba(186, 230, 253, 0.30), transparent 72%),
    radial-gradient(1000px 420px at 84% -12%, rgba(209, 250, 229, 0.24), transparent 72%);
  background-repeat: no-repeat;
}

html[data-theme='dark'] .sub-page {
  --sp-card: var(--panel);
  --sp-card-soft: #191919;
  --sp-row: #1a1a1a;
  --sp-row-hover: #222222;
  --sp-line: rgba(255, 255, 255, 0.09);
  --sp-line-soft: rgba(255, 255, 255, 0.06);
  --sp-text: var(--text);
  --sp-dim: rgba(255, 255, 255, 0.58);
  --sp-faint: rgba(255, 255, 255, 0.38);
  --sp-primary: #7aa2ff;
  --sp-primary-soft: rgba(96, 165, 250, 0.12);
  --sp-danger: #f87171;
  --sp-shadow: 0 1px 2px rgba(0, 0, 0, 0.20), 0 8px 24px rgba(0, 0, 0, 0.18);
  background-image: none;
}

/* 页头 */
.sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}
.sub-title {
  margin: 0;
  font-size: 26px;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: -0.025em;
  color: var(--sp-text);
}
.sub-subtitle {
  margin: 6px 0 0;
  font-size: 13.5px;
  line-height: 1.4;
  color: var(--sp-dim);
}
.sub-head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.btn {
  height: 40px;
  padding: 0 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid transparent;
  border-radius: 10px;
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}
.btn-ghost {
  background: #edf1f7;
  border-color: rgba(15, 23, 42, 0.04);
  color: #334155;
}
.btn-ghost:hover { background: #e5eaf2; }
.btn-primary {
  background: #ffffff;
  border-color: var(--sp-primary);
  color: var(--sp-primary);
  box-shadow: 0 1px 2px rgba(37, 99, 235, 0.06);
}
.btn-primary:hover { background: var(--sp-primary-soft); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
html[data-theme='dark'] .btn-ghost {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.06);
  color: var(--sp-text);
}
html[data-theme='dark'] .btn-ghost:hover { background: rgba(255, 255, 255, 0.1); }
html[data-theme='dark'] .btn-primary { background: transparent; }

.perm-note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border: 1px solid rgba(245, 158, 11, 0.28);
  border-radius: 10px;
  background: rgba(245, 158, 11, 0.08);
  color: #b45309;
  font-size: 12.5px;
}
html[data-theme='dark'] .perm-note { color: #fbbf24; }

/* 配额卡 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px;
}
.stat-card {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
  min-height: 120px;
  padding: 24px 26px;
  background: var(--sp-card);
  border: 1px solid var(--sp-line);
  border-radius: 14px;
  box-shadow: var(--sp-shadow);
}
.stat-ico {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  flex: none;
  border: 1px solid transparent;
}
.tint-blue {
  color: #2563eb;
  background: #d5e2fc;
  border-color: rgba(37, 99, 235, 0.14);
}
.tint-violet {
  color: #7c3aed;
  background: #e7cffa;
  border-color: rgba(124, 58, 237, 0.14);
}
.tint-green {
  color: #059669;
  background: #cfe8da;
  border-color: rgba(5, 150, 105, 0.14);
}
.tint-indigo {
  color: #4f46e5;
  background: #d4defb;
  border-color: rgba(79, 70, 229, 0.14);
}
.tint-gray {
  color: #64748b;
  background: #e3e6e9;
  border-color: rgba(100, 116, 139, 0.12);
}
html[data-theme='dark'] .tint-blue { background: rgba(37, 99, 235, 0.16); color: #8ab4ff; }
html[data-theme='dark'] .tint-violet { background: rgba(124, 58, 237, 0.16); color: #c4a0ff; }
html[data-theme='dark'] .tint-green { background: rgba(5, 150, 105, 0.16); color: #6ee7b7; }
html[data-theme='dark'] .tint-indigo { background: rgba(79, 70, 229, 0.16); color: #a5b4fc; }
html[data-theme='dark'] .tint-gray { background: rgba(148, 163, 184, 0.14); color: #cbd5e1; }

.stat-copy { min-width: 0; }
.stat-label {
  font-size: 13px;
  line-height: 1.25;
  color: var(--sp-dim);
  white-space: nowrap;
}
.stat-value {
  margin-top: 2px;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: -0.02em;
  color: var(--sp-text);
  white-space: nowrap;
}
.stat-suffix {
  font-size: 13px;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--sp-faint);
}

/* 订阅列表 */
.panel {
  background: var(--sp-card);
  border: 1px solid var(--sp-line);
  border-radius: 14px;
  box-shadow: var(--sp-shadow);
}
.list-panel { margin-top: 4px; padding: 20px 22px 18px; }
.panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.panel-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--sp-text);
}
.list-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: calc(100vh - 580px);
  min-height: 84px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.list-body::-webkit-scrollbar { width: 8px; }
.list-body::-webkit-scrollbar-thumb {
  background: rgba(100, 116, 139, 0.25);
  border-radius: 999px;
}
.list-state {
  padding: 30px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--sp-dim);
}

.prow {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 84px;
  padding: 14px 18px;
  border: 1px solid var(--sp-line-soft);
  border-radius: 10px;
  background: var(--sp-row);
  transition: background-color 0.16s ease, border-color 0.16s ease;
}
.prow:hover {
  background: var(--sp-row-hover);
  border-color: var(--sp-line);
}
.prow-ico {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  flex: none;
  color: #2563eb;
  background: #dfe5ee;
  border: 1px solid rgba(15, 23, 42, 0.05);
}
html[data-theme='dark'] .prow-ico {
  color: #8ab4ff;
  background: rgba(37, 99, 235, 0.18);
  border-color: rgba(138, 180, 255, 0.12);
}
.prow-main { min-width: 0; flex: 1; }
.prow-name {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--sp-text);
  overflow-wrap: anywhere;
}
.prow-off {
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  color: #b45309;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.2);
}
.prow-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--sp-dim);
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.meta-item :deep(svg) { color: var(--sp-faint); }
.meta-dot { color: var(--sp-faint); }
.prow-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 20px;
  flex-wrap: wrap;
  flex: none;
  margin-left: auto;
  padding-right: 6px;
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--sp-dim);
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.15s ease;
}
.act:hover { color: var(--sp-primary); }
.act.danger { color: var(--sp-danger); }
.act.danger:hover { color: #b91c1c; }
.act:disabled { opacity: 0.55; cursor: default; }
html[data-theme='dark'] .act.danger:hover { color: #fca5a5; }
.spin { animation: sp-spin 0.9s linear infinite; }
@keyframes sp-spin { to { transform: rotate(360deg); } }

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 42px 20px 46px;
  text-align: center;
}
.empty-ico {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  margin-bottom: 2px;
  color: var(--sp-primary);
  background: var(--sp-primary-soft);
  border: 1px solid rgba(37, 99, 235, 0.10);
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--sp-text);
}
.empty-desc {
  max-width: 460px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--sp-dim);
}
.empty .btn { margin-top: 6px; }

/* 底部两卡 */
.tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.tile {
  display: flex;
  align-items: center;
  gap: 18px;
  min-height: 112px;
  padding: 24px;
  text-align: left;
  font-family: inherit;
  color: inherit;
  background: var(--sp-card);
  border: 1px solid var(--sp-line);
  border-radius: 14px;
  box-shadow: var(--sp-shadow);
  cursor: pointer;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}
.tile:hover {
  border-color: rgba(37, 99, 235, 0.28);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 28px rgba(15, 23, 42, 0.07);
}
.tile:active { transform: translateY(1px); }
.tile-ico {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  flex: none;
  border: 1px solid transparent;
}
.tile-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.tile-copy b {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--sp-text);
}
.tile-copy small {
  font-size: 13px;
  line-height: 1.4;
  color: var(--sp-dim);
}
.tile-go { margin-left: auto; color: var(--sp-faint); }

/* 表单 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: center;
}
.field-label {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-dim);
}
.target-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.text-toggle {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--sp-primary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 兑换码 */
.redeem-tip { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--text-dim); }

@media (max-width: 1180px) {
  .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .list-body { max-height: none; }
}
@media (max-width: 900px) {
  .tiles { grid-template-columns: minmax(0, 1fr); }
  .prow { flex-wrap: wrap; }
  .prow-actions { width: 100%; justify-content: flex-start; }
}
@media (max-width: 640px) {
  .sub-page { gap: 16px; padding-left: 16px; padding-right: 16px; }
  .stat-grid { grid-template-columns: minmax(0, 1fr); }
  .sub-title { font-size: 22px; }
  .list-panel { padding: 16px; }
  .prow { padding: 12px; }
  .form-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
