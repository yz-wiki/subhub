<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import {
  NConfigProvider, NDialogProvider, NMessageProvider, NSwitch, NTag, NButton,
  NDropdown, NAvatar, NModal, NInput, NTabs, NTabPane, NForm, NFormItem, NAlert,
} from 'naive-ui';
import { darkTheme, zhCN, dateZhCN, createDiscreteApi } from 'naive-ui';
import ConvertView from './views/ConvertView.vue';
import LibraryView from './views/LibraryView.vue';
import ProfilesView from './views/ProfilesView.vue';
import SystemView from './views/SystemView.vue';
import { state, loadState, setTheme } from './state.js';
import { api as request } from './api.js';

const message = createDiscreteApi(['message']).message;

const navOptions = [
  { label: '订阅转换', key: 'convert' },
  { label: '资源库', key: 'library' },
  { label: '订阅', key: 'profiles' },
  { label: '系统', key: 'system' },
];

const statusType = computed(() => {
  const e = state.status && state.status.engine;
  if (!e) return 'default';
  if (e.ok) return 'success';
  if (e.error) return 'error';
  return 'warning';
});

const statusText = computed(() => {
  const e = (state.status && state.status.engine) || {};
  if (e.ok) return '引擎在线';
  if (e.error) return '引擎异常';
  return '检测中…';
});
const statusDetail = computed(() => {
  const e = (state.status && state.status.engine) || {};
  if (e.ok) return `${e.version || 'subconverter'} · ${e.base || ''}`;
  return e.error || '正在连接转换引擎';
});

const accountLabel = computed(() => (state.auth.user ? state.auth.user.username : '登录'));
const accountOptions = computed(() => {
  const opts = [];
  if (!state.auth.user) opts.push({ label: '登录 / 注册', key: 'login' });
  else {
    opts.push({ label: `已登录：${state.auth.user.username}${state.auth.admin ? '（管理员）' : ''}`, key: 'info', disabled: true });
    opts.push({ label: '修改密码', key: 'password' });
    opts.push({ label: '退出登录', key: 'logout' });
  }
  opts.push({ label: '系统设置', key: 'system' });
  return opts;
});

const theme = computed(() => (state.theme === 'dark' ? darkTheme : null));
const darkOverrides = {
  common: {
    primaryColor: '#6366f1',
    primaryColorHover: '#818cf8',
    primaryColorPressed: '#4f52e0',
    primaryColorSuppl: '#6366f1',
    borderRadius: '10px',
    bodyColor: '#0a0a0a',
    cardColor: '#141414',
    modalColor: '#161616',
    popoverColor: '#1a1a1a',
    borderColor: 'rgba(255,255,255,0.10)',
    dividerColor: 'rgba(255,255,255,0.08)',
    textColorBase: '#ededed',
    textColor1: '#ededed',
    textColor2: 'rgba(255,255,255,0.82)',
    textColor3: 'rgba(255,255,255,0.60)',
    inputColor: 'rgba(255,255,255,0.03)',
    hoverColor: 'rgba(255,255,255,0.06)',
    fontFamily: "'Inter','PingFang SC','Microsoft YaHei',system-ui,sans-serif",
  },
  Card: { color: '#141414', borderColor: 'rgba(255,255,255,0.10)', borderRadius: '14px', paddingMedium: '16px 18px' },
  Button: { borderRadiusMedium: '9px', borderRadiusSmall: '8px' },
  Input: { color: 'rgba(255,255,255,0.03)', colorFocus: 'rgba(255,255,255,0.05)' },
  Tag: { borderRadius: '6px' },
};
const lightOverrides = {
  common: {
    primaryColor: '#4f46e5',
    primaryColorHover: '#6366f1',
    primaryColorPressed: '#4338ca',
    primaryColorSuppl: '#4f46e5',
    borderRadius: '10px',
    bodyColor: '#f7f7f8',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    borderColor: 'rgba(17,24,39,0.12)',
    dividerColor: 'rgba(17,24,39,0.08)',
    textColorBase: '#111827',
    textColor1: '#111827',
    textColor2: 'rgba(17,24,39,0.78)',
    textColor3: 'rgba(17,24,39,0.58)',
    inputColor: 'rgba(17,24,39,0.03)',
    hoverColor: 'rgba(17,24,39,0.05)',
    fontFamily: "'Inter','PingFang SC','Microsoft YaHei',system-ui,sans-serif",
  },
  Card: { color: '#ffffff', borderColor: 'rgba(17,24,39,0.12)', borderRadius: '14px', paddingMedium: '16px 18px' },
  Button: { borderRadiusMedium: '9px', borderRadiusSmall: '8px' },
  Tag: { borderRadius: '6px' },
};
const themeOverrides = computed(() => (state.theme === 'dark' ? darkOverrides : lightOverrides));

const loginOpen = ref(false);
const loginTab = ref('login');
const loginForm = ref({ username: '', password: '' });
const regForm = ref({ code: '', username: '', password: '' });
const pwdOpen = ref(false);
const pwdForm = ref({ current: '', next: '' });
const loginBusy = ref(false);

function openLogin() {
  loginOpen.value = true;
  loginTab.value = 'login';
  if (!loginForm.value.username) loginForm.value.username = 'admin';
}

async function submitLogin() {
  loginBusy.value = true;
  try {
    await request('/api/auth/login', { method: 'POST', body: loginForm.value });
    message.success('登录成功');
    loginOpen.value = false;
    await loadState();
    message.info(state.auth.defaultPassword ? '当前仍是默认密码 admin，请尽快修改' : '欢迎回来');
  } catch (e) {
    message.error(e.message || '登录失败');
  } finally {
    loginBusy.value = false;
  }
}

async function submitRegister() {
  loginBusy.value = true;
  try {
    await request('/api/auth/register', { method: 'POST', body: regForm.value });
    message.success('注册成功，已自动登录');
    loginOpen.value = false;
    await loadState();
  } catch (e) {
    message.error(e.message || '注册失败');
  } finally {
    loginBusy.value = false;
  }
}

async function submitPassword() {
  try {
    await request('/api/auth/password', { method: 'POST', body: pwdForm.value });
    message.success('密码已修改，请重新登录');
    pwdOpen.value = false;
    pwdForm.value = { current: '', next: '' };
    await loadState();
  } catch (e) {
    message.error(e.message || '修改失败');
  }
}

async function doLogout() {
  await request('/api/auth/logout', { method: 'POST' }).catch(() => {});
  message.success('已退出登录');
  await loadState();
}

function onAccount(key) {
  if (key === 'login') openLogin();
  else if (key === 'logout') doLogout();
  else if (key === 'password') pwdOpen.value = true;
  else if (key === 'system') state.view = 'system';
}

onMounted(async () => {
  const fromHash = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  if (['convert', 'library', 'profiles', 'system'].includes(fromHash)) state.view = fromHash;
  try {
    await loadState();
  } catch (e) {
    message.error(e.message || '无法连接网关');
  }
});

watch(() => state.view, (v) => {
  const next = `#/${v}`;
  if ((location.hash || '').split('?')[0] !== next) history.replaceState(null, '', next);
});

function onHashChange() {
  const v = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  if (['convert', 'library', 'profiles', 'system'].includes(v) && v !== state.view) state.view = v;
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', onHashChange);

watch(() => state.auth.defaultPassword, (v) => {
  if (v && state.auth.admin) message.warning('检测到默认密码 admin，请在系统页修改');
});
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-dialog-provider>
      <n-message-provider>
        <div class="app-shell">
          <header class="app-header">
            <div class="brand">
              <div class="brand-mark">S</div>
              <div>
                <div class="brand-name">SubHub</div>
                <div class="brand-sub">SUB CONVERTER</div>
              </div>
            </div>
            <div class="header-nav">
              <button
                v-for="item in navOptions" :key="item.key" type="button"
                :class="['nav-pill', { active: state.view === item.key }]"
                @click="state.view = item.key"
              >{{ item.label }}</button>
            </div>
            <div class="header-actions">
              <n-tag size="small" :type="statusType" round :title="statusDetail">{{ statusText }}</n-tag>
              <n-switch :value="state.theme === 'dark'" size="small" @update:value="(v) => setTheme(v ? 'dark' : 'light')">
                <template #checked>暗</template>
                <template #unchecked>亮</template>
              </n-switch>
              <n-button v-if="!state.auth.user" size="small" type="primary" class="login-btn" @click="openLogin">
                登录
              </n-button>
              <n-dropdown v-else :options="accountOptions" trigger="click" @select="onAccount">
                <n-button quaternary size="small">
                  <template #icon><n-avatar round size="small" :style="{ background: 'linear-gradient(135deg,#6d7dff,#22d3ee)', color: '#060912', fontSize: '11px' }">{{ accountLabel.slice(0, 1).toUpperCase() }}</n-avatar></template>
                  {{ accountLabel }}
                </n-button>
              </n-dropdown>
            </div>
          </header>

          <main>
            <ConvertView v-if="state.view === 'convert'" />
            <LibraryView v-else-if="state.view === 'library'" />
            <ProfilesView v-else-if="state.view === 'profiles'" />
            <SystemView v-else />
          </main>
        </div>

        <n-modal v-model:show="loginOpen" preset="card" title="登录 SubHub" style="width: 420px; max-width: 94vw">
          <n-tabs v-model:value="loginTab" type="segment" animated>
            <n-tab-pane name="login" tab="账号登录">
              <n-form label-placement="top" @submit.prevent="submitLogin">
                <n-form-item label="用户名"><n-input v-model:value="loginForm.username" placeholder="admin" /></n-form-item>
                <n-form-item label="密码"><n-input v-model:value="loginForm.password" type="password" show-password-on="click" @keyup.enter="submitLogin" /></n-form-item>
                <n-alert v-if="state.auth.defaultPassword" type="warning" :bordered="false" style="margin-bottom: 12px">当前为默认密码，登录后请尽快修改。</n-alert>
                <n-button type="primary" block :loading="loginBusy" @click="submitLogin">登录</n-button>
              </n-form>
            </n-tab-pane>
            <n-tab-pane name="register" tab="注册码注册">
              <n-form label-placement="top">
                <n-form-item label="注册码"><n-input v-model:value="regForm.code" placeholder="管理员生成的一次性注册码" /></n-form-item>
                <n-form-item label="用户名"><n-input v-model:value="regForm.username" placeholder="3-32 位字母数字" /></n-form-item>
                <n-form-item label="密码"><n-input v-model:value="regForm.password" type="password" show-password-on="click" /></n-form-item>
                <n-button type="primary" block :loading="loginBusy" @click="submitRegister">注册并登录</n-button>
              </n-form>
            </n-tab-pane>
          </n-tabs>
        </n-modal>

        <n-modal v-model:show="pwdOpen" preset="card" title="修改密码" style="width: 420px; max-width: 94vw">
          <n-form label-placement="top">
            <n-form-item label="当前密码"><n-input v-model:value="pwdForm.current" type="password" show-password-on="click" /></n-form-item>
            <n-form-item label="新密码"><n-input v-model:value="pwdForm.next" type="password" show-password-on="click" /></n-form-item>
            <n-button type="primary" block @click="submitPassword">保存</n-button>
          </n-form>
        </n-modal>
      </n-message-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>
