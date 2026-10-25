'use strict';

/**
 * 模板仓库：ini 文件落盘在 CONFIG_DIR/templates，
 * 首次启动从镜像内 seed/templates 复制。元数据写在文件头部注释里。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseIni } = require('./ini');

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_SIZE = 256 * 1024;

class TemplateStore {
  constructor({ dataDir, dir, seedDir, logger }) {
    this.dir = dir || path.join(dataDir, 'templates');
    this.seedDir = seedDir;
    this.log = logger || (() => {});
    this.cache = new Map();
    this.revCache = { at: 0, value: '' };
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    let seeds = [];
    try {
      seeds = fs.readdirSync(this.seedDir).filter((f) => f.endsWith('.ini'));
    } catch (e) {
      this.log('tpl', `seed 目录不可读：${e.message}`);
    }
    for (const file of seeds) {
      const dst = path.join(this.dir, file);
      if (fs.existsSync(dst)) continue;
      try {
        fs.copyFileSync(path.join(this.seedDir, file), dst);
        this.log('tpl', `已初始化内置模板 ${file}`);
      } catch (e) {
        this.log('tpl', `复制模板失败 ${file}: ${e.message}`);
      }
    }
  }

  static isValidName(name) {
    return typeof name === 'string' && NAME_RE.test(name) && !name.includes('..');
  }

  fileFor(name) {
    if (!TemplateStore.isValidName(name)) return null;
    return path.join(this.dir, `${name}.ini`);
  }

  has(name) {
    const file = this.fileFor(name);
    return !!file && fs.existsSync(file);
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.ini'));
    } catch {
      return [];
    }
    const out = [];
    for (const file of files) {
      const name = file.slice(0, -4);
      try {
        const info = this.get(name);
        if (!info) continue;
        out.push({
          name,
          title: info.meta.title || name,
          description: info.meta.description || '',
          targets: info.meta.targets || [],
          groups: info.model.groups.length,
          rules: info.model.rules.length,
          bytes: info.bytes,
          updatedAt: info.updatedAt,
        });
      } catch {
        // 忽略坏文件
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return out;
  }

  get(name) {
    const file = this.fileFor(name);
    if (!file) return null;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const cached = this.cache.get(name);
    let entry;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      entry = cached;
    } else {
      const content = fs.readFileSync(file, 'utf8');
      const model = parseIni(content);
      entry = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        content,
        model,
        bytes: Buffer.byteLength(content, 'utf8'),
        meta: {
          title: model.meta.title || name,
          description: model.meta.description || '',
          targets: model.meta.targets || [],
          author: model.meta.author || '',
          version: model.meta.version || '',
        },
      };
      this.cache.set(name, entry);
    }
    return {
      name,
      content: entry.content,
      model: entry.model,
      bytes: entry.bytes,
      updatedAt: st.mtime.toISOString(),
      meta: entry.meta,
    };
  }

  save(name, content, { create = false } = {}) {
    if (!TemplateStore.isValidName(name)) throw new Error('模板名称只能包含字母、数字、点、下划线、短横线，且以字母或数字开头');
    const file = this.fileFor(name);
    const text = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
    if (!text.trim()) throw new Error('模板内容不能为空');
    if (Buffer.byteLength(text, 'utf8') > MAX_SIZE) throw new Error('模板内容超过 256KB 限制');
    if (create && fs.existsSync(file)) throw new Error('同名模板已存在');
    if (!create && !fs.existsSync(file)) throw new Error('模板不存在');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    this.cache.delete(name);
    this.revCache.at = 0;
    return this.get(name);
  }

  remove(name) {
    const file = this.fileFor(name);
    if (!file || !fs.existsSync(file)) throw new Error('模板不存在');
    fs.unlinkSync(file);
    this.cache.delete(name);
    this.revCache.at = 0;
  }

  /** 模板集合的版本号：任何模板变更都会让订阅缓存失效 */
  revision() {
    const now = Date.now();
    if (this.revCache.at && now - this.revCache.at < 500) return this.revCache.value;
    const parts = [];
    try {
      for (const file of fs.readdirSync(this.dir).filter((f) => f.endsWith('.ini')).sort()) {
        try {
          const st = fs.statSync(path.join(this.dir, file));
          parts.push(`${file}:${st.mtimeMs}:${st.size}`);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    const value = crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
    this.revCache = { at: now, value };
    return value;
  }
}

module.exports = { TemplateStore };


