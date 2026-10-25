'use strict';

/**
 * 运行设置：持久化在 CONFIG_DIR/settings.json。
 * 目前只有转换引擎一项：mode=internal 用容器内 subconverter，mode=remote 用远端地址。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  engine: { mode: 'internal', base: '', token: '' },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function maskToken(token) {
  const text = String(token || '');
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}…${text.slice(-2)}`;
}

function httpUrlError(raw, label) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text.length > 300) return `${label}地址过长`;
  if (!/^https?:\/\//i.test(text)) return `${label}地址必须以 http:// 或 https:// 开头`;
  return null;
}

class SettingsStore {
  constructor({ dataDir, logger = () => {} }) {
    this.file = path.join(dataDir, 'settings.json');
    this.log = logger;
    this.data = clone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8') || '{}');
      const engine = parsed && parsed.engine ? parsed.engine : {};
      const mode = engine.mode === 'remote' ? 'remote' : 'internal';
      this.data = {
        engine: {
          mode,
          base: String(engine.base || '').replace(/\/+$/, ''),
          token: String(engine.token || ''),
        },
      };
    } catch (err) {
      this.log('warn', `读取 settings.json 失败：${err.message}`);
    }
  }

  persist() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  /** 对外展示：token 只给掩码 */
  publicView() {
    const e = this.data.engine;
    return {
      engine: {
        mode: e.mode,
        base: e.base,
        hasToken: !!e.token,
        tokenMask: maskToken(e.token),
        internalBase: '',
      },
    };
  }

  engine() {
    return clone(this.data.engine);
  }

  updateEngine(input, { internalBase } = {}) {
    const mode = input.mode === 'remote' ? 'remote' : 'internal';
    let base = String(input.base || '').trim().replace(/\/+$/, '');
    if (mode === 'internal') {
      // 内置引擎始终使用容器内地址，清掉远端地址与令牌，避免界面显示旧地址。
      this.data.engine = { mode, base: '', token: '' };
      this.persist();
      return this.publicView();
    }
    const err = httpUrlError(base, '远端引擎');
    if (err) {
      const e = new Error(err);
      e.status = 400;
      throw e;
    }
    if (!base) {
      const e = new Error('切换到远端引擎需要填写地址');
      e.status = 400;
      throw e;
    }
    let token = this.data.engine.token;
    if (input.token !== undefined) token = String(input.token || '').trim();
    if (input.clearToken) token = '';
    this.data.engine = { mode, base, token };
    this.persist();
    return this.publicView();
  }

  /** 把设置应用到一个 Engine 实例 */
  applyTo(engine, { internalBase } = {}) {
    const e = this.data.engine;
    engine.base = (e.mode === 'remote' ? e.base : internalBase || e.base).replace(/\/+$/, '');
    engine.token = e.mode === 'remote' ? e.token : '';
    return e;
  }
}

module.exports = { SettingsStore, maskToken };

