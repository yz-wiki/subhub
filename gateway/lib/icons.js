'use strict';

/**
 * 图标库：内置 emoji 图标（地区 / 服务品牌）+ 自定义上传（png/jpeg/webp/svg，≤96KB）。
 * 存储：CONFIG_DIR/icons.json，内置条目只读。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_IMAGE_BYTES = 96 * 1024;
const MAX_ICONS = 400;
const IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/i;

const BUILTIN = [
  { id: 'flag-hk', name: '香港', category: '地区', value: '🇭🇰' },
  { id: 'flag-tw', name: '台湾', category: '地区', value: '🇹🇼' },
  { id: 'flag-jp', name: '日本', category: '地区', value: '🇯🇵' },
  { id: 'flag-sg', name: '新加坡', category: '地区', value: '🇸🇬' },
  { id: 'flag-us', name: '美国', category: '地区', value: '🇺🇸' },
  { id: 'flag-kr', name: '韩国', category: '地区', value: '🇰🇷' },
  { id: 'flag-gb', name: '英国', category: '地区', value: '🇬🇧' },
  { id: 'flag-de', name: '德国', category: '地区', value: '🇩🇪' },
  { id: 'flag-fr', name: '法国', category: '地区', value: '🇫🇷' },
  { id: 'flag-ca', name: '加拿大', category: '地区', value: '🇨🇦' },
  { id: 'flag-au', name: '澳大利亚', category: '地区', value: '🇦🇺' },
  { id: 'flag-nl', name: '荷兰', category: '地区', value: '🇳🇱' },
  { id: 'svc-netflix', name: 'Netflix', category: '流媒体', value: '🎬' },
  { id: 'svc-youtube', name: 'YouTube', category: '流媒体', value: '▶️' },
  { id: 'svc-disney', name: 'Disney+', category: '流媒体', value: '🏰' },
  { id: 'svc-telegram', name: 'Telegram', category: '社交', value: '✈️' },
  { id: 'svc-twitter', name: 'X / Twitter', category: '社交', value: '🐦' },
  { id: 'svc-spotify', name: 'Spotify', category: '音乐', value: '🎵' },
  { id: 'svc-apple', name: 'Apple', category: '服务', value: '🍎' },
  { id: 'svc-microsoft', name: 'Microsoft', category: '服务', value: '🪟' },
  { id: 'svc-google', name: 'Google', category: '服务', value: '🔍' },
  { id: 'svc-openai', name: 'OpenAI', category: 'AI', value: '🤖' },
  { id: 'svc-github', name: 'GitHub', category: '开发', value: '🐙' },
  { id: 'svc-steam', name: 'Steam', category: '游戏', value: '🎮' },
  { id: 'svc-cloudflare', name: 'Cloudflare', category: '服务', value: '☁️' },
  { id: 'role-node', name: '节点', category: '通用', value: '🚀' },
  { id: 'role-auto', name: '自动选择', category: '通用', value: '⚡' },
  { id: 'role-direct', name: '直连', category: '通用', value: '🛡️' },
  { id: 'role-reject', name: '广告拦截', category: '通用', value: '🚫' },
  { id: 'role-global', name: '全球', category: '通用', value: '🌐' },
  { id: 'role-download', name: '下载', category: '通用', value: '📦' },
  { id: 'role-ai', name: 'AI 服务', category: '通用', value: '🧠' },
  { id: 'role-media', name: '流媒体', category: '通用', value: '📺' },
  { id: 'role-game', name: '游戏', category: '通用', value: '🕹️' },
];

class IconStore {
  constructor({ dataDir, seedDir, logger = () => {} }) {
    this.file = path.join(dataDir, 'icons.json');
    this.log = logger;
    this.custom = [];
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const seed = seedDir && path.join(seedDir, 'icons.json');
      if (!fs.existsSync(this.file) && seed && fs.existsSync(seed)) {
        fs.copyFileSync(seed, this.file);
        this.log('icons', `首次启动：已写入示例图标文件 ${this.file}`);
      }
    } catch (err) {
      this.log('warn', `初始化图标目录失败：${err.message}`);
    }
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8') || '{}');
      this.custom = Array.isArray(parsed.icons) ? parsed.icons.filter((it) => it && it.id && it.value) : [];
    } catch (err) {
      this.log('warn', `读取 icons.json 失败：${err.message}`);
      this.custom = [];
    }
  }

  persist() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, icons: this.custom }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  all() {
    return [
      ...BUILTIN.map((it) => ({ ...it, builtin: true, kind: 'emoji' })),
      ...this.custom.map((it) => ({ ...it, builtin: false, kind: it.kind || 'image' })),
    ];
  }

  list({ q = '', limit = 0 } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    let items = this.all();
    if (needle) {
      items = items.filter((it) => (
        it.name.toLowerCase().includes(needle)
        || String(it.category || '').toLowerCase().includes(needle)
        || String(it.id || '').toLowerCase().includes(needle)
      ));
    }
    if (limit > 0) items = items.slice(0, limit);
    return items;
  }

  get(id) {
    return this.all().find((it) => it.id === id) || null;
  }

  summary() {
    return {
      total: this.all().length,
      builtin: BUILTIN.length,
      custom: this.custom.length,
      categories: [...new Set(this.all().map((it) => it.category))],
    };
  }

  create(input) {
    const name = String(input.name || '').trim().slice(0, 24);
    if (!name) {
      const e = new Error('图标名称不能为空');
      e.status = 400;
      throw e;
    }
    const raw = String(input.value || '').trim();
    if (!raw) {
      const e = new Error('请提供图标内容（emoji 或图片）');
      e.status = 400;
      throw e;
    }
    let kind = 'emoji';
    let value = raw;
    if (raw.startsWith('data:')) {
      const m = IMAGE_RE.exec(raw);
      if (!m) {
        const e = new Error('图片必须是 png / jpeg / webp / svg 的 dataUrl');
        e.status = 400;
        throw e;
      }
      const bytes = Math.floor((m[2].replace(/\s+/g, '').length * 3) / 4);
      if (bytes > MAX_IMAGE_BYTES) {
        const e = new Error(`图片过大（${Math.round(bytes / 1024)}KB），上限 96KB`);
        e.status = 400;
        throw e;
      }
      kind = 'image';
    } else if (raw.length > 8) {
      const e = new Error('emoji 图标不能超过 8 个字符');
      e.status = 400;
      throw e;
    }
    if (this.custom.length >= MAX_ICONS) {
      const e = new Error(`自定义图标已达上限（${MAX_ICONS}）`);
      e.status = 400;
      throw e;
    }
    const item = {
      id: `ic-${crypto.randomBytes(4).toString('hex')}`,
      name,
      category: String(input.category || '自定义').trim().slice(0, 16) || '自定义',
      kind,
      value,
      createdAt: new Date().toISOString(),
    };
    this.custom.push(item);
    this.persist();
    this.log('icons', `新增图标 ${item.name}（${kind}）`);
    return item;
  }

  update(id, input) {
    const item = this.custom.find((it) => it.id === id);
    if (!item) {
      const e = new Error('内置图标不可编辑');
      e.status = 400;
      throw e;
    }
    if (input.name !== undefined) {
      const name = String(input.name || '').trim().slice(0, 24);
      if (!name) {
        const e = new Error('图标名称不能为空');
        e.status = 400;
        throw e;
      }
      item.name = name;
    }
    if (input.category !== undefined) item.category = String(input.category || '自定义').slice(0, 16);
    this.persist();
    return item;
  }

  remove(id) {
    const idx = this.custom.findIndex((it) => it.id === id);
    if (idx < 0) {
      const e = new Error('内置图标不可删除');
      e.status = 400;
      throw e;
    }
    const [item] = this.custom.splice(idx, 1);
    this.persist();
    this.log('icons', `删除图标 ${item.name}`);
    return { ok: true };
  }
}

module.exports = { IconStore, BUILTIN, MAX_IMAGE_BYTES };

