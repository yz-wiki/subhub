<template>
  <div class="bdf" :style="{ height }">
    <div class="bdf-head">
      <b class="bdf-title">{{ kind === 'dns' ? 'DNS 可视化' : '基础配置可视化' }}</b>
      <span class="bdf-hint">改表单即实时写回 YAML，右侧同步预览</span>
      <span class="bdf-spacer" />
      <span v-if="changedCount" class="bdf-count">已改 {{ changedCount }} 项</span>
      <n-button v-if="canRevert" size="tiny" quaternary @click="revertAll">撤销改动</n-button>
    </div>

    <p v-if="loadNote" class="bdf-note">{{ loadNote }}</p>
    <p v-if="emitNote" class="bdf-note">{{ emitNote }}</p>

    <div class="bdf-body">
      <section v-for="sec in sections" :key="sec.group" class="bdf-sec">
        <div class="bdf-sec-head">
          <b>{{ sec.group }}</b>
          <span class="bdf-spacer" />
          <span v-if="sec.hint" class="bdf-hint">{{ sec.hint }}</span>
        </div>
        <div class="bdf-grid">
          <div
            v-for="f in sec.fields" :key="f.key"
            class="bdf-field" :class="{ 'is-wide': f.type === 'policy', 'is-bad': !!invalid[f.key] }"
          >
            <div class="bdf-label">
              <code>{{ f.label }}</code>
              <span v-if="invalid[f.key]" class="bdf-bad">{{ invalid[f.key] }}</span>
              <span v-else-if="f.hint" class="bdf-hint">{{ f.hint }}</span>
            </div>

            <n-select
              v-if="f.type === 'bool'"
              v-model:value="form[f.key]" size="small" clearable :options="BOOL_OPTIONS"
              placeholder="未设置（跟随默认）"
            />
            <n-select
              v-else-if="f.type === 'enum'"
              v-model:value="form[f.key]" size="small" clearable
              :filterable="!!f.custom" :tag="!!f.custom" :options="enumOptions(f)"
              placeholder="未设置"
            />
            <n-input
              v-else-if="f.type === 'password'"
              v-model:value="form[f.key]" size="small" type="password" show-password-on="click"
              :placeholder="f.placeholder || '未设置'"
            />
            <n-input
              v-else-if="f.type === 'port'"
              v-model:value="form[f.key]" size="small" :placeholder="f.placeholder || '未设置'"
            />
            <n-input
              v-else-if="f.type === 'list'"
              v-model:value="form[f.key]" size="small"
              :placeholder="f.placeholder || '逗号分隔，留空则不写入'"
            />
            <div v-else-if="f.type === 'policy'" class="bdf-policy">
              <div v-for="(row, i) in form[f.key]" :key="`${f.key}-${i}`" class="bdf-policy-row">
                <n-input v-model:value="row.name" size="small" placeholder="域名，如 geosite:cn" />
                <n-input v-model:value="row.value" size="small" placeholder="服务器，如 https://doh.pub/dns-query" />
                <n-button size="tiny" quaternary type="error" @click="form[f.key].splice(i, 1)">删除</n-button>
              </div>
              <div class="bdf-policy-foot">
                <n-button size="tiny" dashed @click="form[f.key].push({ name: '', value: '' })">+ 添加域名策略</n-button>
                <span class="bdf-hint">左 = 域名 / geosite: / rule-set:，右 = 命中的 DNS 服务器</span>
              </div>
            </div>
            <n-input
              v-else
              v-model:value="form[f.key]" size="small" :placeholder="f.placeholder || '未设置'"
            />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script>
/* ──────────────────────────────────────────────────────────────
 * 极简 YAML 读写：只做「按缩进切块」的保守解析。
 *
 * 每个 key 节点记住自己整块原文（含注释），改动时只重写被编辑字段
 * 所在的那一块，其余行原样回填，因此未知字段、注释、不常见写法都
 * 不会丢。不支持锚点 / 多文档 / 块标量；遇到无法理解的形态就放弃
 * 接管该字段（保留原文，并在界面上提示改用原始 YAML）。
 * ────────────────────────────────────────────────────────────── */

const BASE_TOP_ORDER = ['mixed-port', 'socks-port', 'allow-lan', 'mode', 'log-level', 'ipv6', 'unified-delay', 'tcp-concurrent', 'external-controller', 'secret', 'global-client-fingerprint', 'profile', 'sniffer', 'tun', 'hosts', 'experimental', 'geox-url'];
const DNS_TOP_ORDER = ['dns'];

const ORDER = {
  dns: ['enable', 'listen', 'ipv6', 'enhanced-mode', 'fake-ip-range', 'use-hosts', 'use-system-hosts', 'respect-rules', 'default-nameserver', 'nameserver', 'proxy-server-nameserver', 'fallback', 'fallback-filter', 'nameserver-policy', 'fake-ip-filter'],
  'dns.fallback-filter': ['geoip', 'geoip-code', 'ipcidr'],
  profile: ['store-selected', 'store-fake-ip'],
  sniffer: ['enable', 'parse-pure-ip', 'sniff'],
  'sniffer.sniff': ['HTTP', 'TLS', 'QUIC'],
};

function padOf(n) {
  return ' '.repeat(Math.max(0, n));
}

function indentWidth(line) {
  let n = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 2;
    else break;
  }
  return n;
}

function leadingLength(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
  return i;
}

function stripComment(value) {
  const s = String(value == null ? '' : value);
  let quote = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /[ \t]/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function splitTopLevel(text, sep) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      buf += ch;
      if (quote === '"' && ch === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim() || out.length) out.push(buf);
  return out;
}

function unquoteText(text) {
  const t = String(text == null ? '' : text).trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

function parseScalar(raw) {
  const s = stripComment(raw).trim();
  if (!s) return '';
  if (s[0] === '[' && s[s.length - 1] === ']') {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ',').map((part) => parseScalar(part)).filter((v) => v !== '');
  }
  if (s[0] === '{' && s[s.length - 1] === '}') {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (inner) {
      for (const part of splitTopLevel(inner, ',')) {
        const kv = splitKeyValue(part.trim());
        if (kv) obj[kv.key] = parseScalar(kv.value);
      }
    }
    return obj;
  }
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return unquoteText(s);
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return unquoteText(s);
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^(null|~)$/i.test(s)) return null;
  if (/^[-+]?\d+$/.test(s)) return Number(s);
  if (/^[-+]?(\d+\.\d*|\.\d+)$/.test(s)) return Number(s);
  return s;
}

/** 把一行（去掉缩进后的）拆成 key / 行内 value；不是映射行则返回 null。 */
function splitKeyValue(body) {
  const s = String(body == null ? '' : body);
  if (!s) return null;
  if (s[0] === '"' || s[0] === "'") {
    const quote = s[0];
    let i = 1;
    while (i < s.length) {
      if (quote === '"' && s[i] === '\\') { i += 2; continue; }
      if (s[i] === quote) {
        if (quote === "'" && s[i + 1] === "'") { i += 2; continue; }
        i += 1;
        break;
      }
      i += 1;
    }
    const after = s.slice(i);
    if (!/^[ \t]*:(?:[ \t]|$)/.test(after)) return null;
    return { key: unquoteText(s.slice(0, i)), value: after.replace(/^[ \t]*:/, '').replace(/^[ \t]+/, '') };
  }
  /* 键里可以带冒号（geosite:cn），只有「冒号 + 空白/行尾」才是分隔符 */
  const m = /:(?=[ \t]|$)/.exec(s);
  if (!m) return null;
  const key = s.slice(0, m.index).trim();
  if (!key || /[ \t]/.test(key)) return null;
  if (key[0] === '#' || key[0] === '-') return null;
  return { key, value: s.slice(m.index + 1).replace(/^[ \t]+/, '') };
}

function parseTree(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const root = { root: true, key: null, indent: -1, children: [], inline: '', gap: [], tail: [] };
  const stack = [root];
  const flat = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed[0] === '#') continue;
    const indent = indentWidth(raw);
    const body = raw.slice(leadingLength(raw));
    const isSeq = body === '-' || /^-[ \t]/.test(body);
    let node;
    if (isSeq) {
      node = { seq: true, key: null, indent, inline: body.replace(/^-[ \t]*/, ''), children: [], start: i, gap: [] };
    } else {
      const kv = splitKeyValue(body);
      if (!kv) continue;
      node = { seq: false, key: kv.key, indent, inline: kv.value, children: [], start: i, gap: [] };
    }
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    node.parent = parent;
    parent.children.push(node);
    if (!isSeq) stack.push(node);
    flat.push(node);
  }

  for (const node of flat) {
    let limit = lines.length;
    for (let j = node.start + 1; j < lines.length; j += 1) {
      const t = lines[j].trim();
      if (!t || t[0] === '#') continue;
      if (indentWidth(lines[j]) <= node.indent) { limit = j; break; }
    }
    let end = node.start + 1;
    for (let j = node.start; j < limit; j += 1) if (lines[j].trim()) end = j + 1;
    node.end = end;
    node.raw = lines.slice(node.start, end);
  }

  const assignGaps = (parent) => {
    let cursor = parent.root ? 0 : parent.start + 1;
    for (const child of parent.children) {
      child.gap = lines.slice(cursor, child.start);
      cursor = child.end;
      if (!child.seq) assignGaps(child);
    }
    if (parent.root) parent.tail = lines.slice(cursor);
    else parent.tailLines = lines.slice(cursor, parent.end);
  };
  assignGaps(root);
  return { lines, root };
}

function pathOf(node) {
  const out = [];
  let cur = node;
  while (cur && !cur.root) { out.unshift(cur.key); cur = cur.parent; }
  return out;
}

function getNode(tree, path) {
  let cur = tree.root;
  for (const key of path) {
    const next = (cur.children || []).find((c) => !c.removed && !c.seq && c.key === key);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

function nodeValue(node) {
  if (!node) return undefined;
  const kids = (node.children || []).filter((c) => !c.removed);
  if (kids.length) {
    if (kids.every((c) => c.seq)) return kids.map((c) => parseScalar(c.inline));
    const obj = {};
    for (const c of kids) if (!c.seq) obj[c.key] = nodeValue(c);
    return obj;
  }
  return parseScalar(node.inline);
}

function needsQuote(s) {
  const str = String(s == null ? '' : s);
  if (!str) return true;
  if (/^[ \t]|[ \t]$/.test(str)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(str)) return true;
  if (/^(true|false|yes|no|on|off|null|~)$/i.test(str)) return true;
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(str)) return true;
  if (str.includes('#')) return true;
  if (/:\s|:$/.test(str)) return true;
  if (/[,{}\[\]]/.test(str)) return true;
  if (/[\n\t]/.test(str)) return true;
  return false;
}

function keyText(key) {
  const s = String(key == null ? '' : key);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

function scalarText(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const s = String(value == null ? '' : value);
  if (!s) return "''";
  return needsQuote(s) ? JSON.stringify(s) : s;
}

function flowListText(items) {
  const parts = (items || []).map((it) => {
    const s = String(it == null ? '' : it).trim();
    if (/^\d+$/.test(s)) return String(Number(s));
    return scalarText(s);
  });
  return `[${parts.join(', ')}]`;
}

/**
 * 在解析树上按字段打补丁：只标记 / 重写受影响的那一块，
 * 其余节点保留 raw 原文。
 */
function containerise(node) {
  if (!node) return false;
  if ((node.children || []).some((c) => !c.removed)) return true;
  const inline = String(node.inline || '').trim();
  node.children = node.children.filter((c) => !c.removed);
  if (!inline) { node.valueKind = 'map'; return true; }
  if (inline[0] !== '{' || inline[inline.length - 1] !== '}') return false;
  const inner = inline.slice(1, -1).trim();
  const entries = [];
  if (inner) {
    for (const part of splitTopLevel(inner, ',')) {
      const kv = splitKeyValue(part.trim());
      if (!kv) return false;
      entries.push(kv);
    }
  }
  node.inline = '';
  node.dirty = true;
  node.valueKind = 'map';
  node.tailLines = [];
  for (const e of entries) {
    node.children.push({
      key: e.key, indent: node.indent + 2, inline: '', children: [], gap: [], tailLines: [],
      created: true, dirty: true, valueKind: 'leaf',
      leafText: stripComment(e.value).trim() || "''",
      parent: node,
    });
  }
  return true;
}

function makeLeaf(node, text) {
  node.dirty = true;
  node.valueKind = 'leaf';
  node.leafText = text;
  node.inline = '';
  node.children = [];
  node.tailLines = [];
}

/* ── 表单字段 → YAML 补丁 ── */

function splitListText(text) {
  return String(text == null ? '' : text)
    .split(/[,，、\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function valueText(f, cur) {
  if (f.type === 'bool') return cur === true ? 'true' : (cur === false ? 'false' : null);
  if (f.type === 'list') {
    const items = splitListText(cur);
    return items.length ? flowListText(items) : null;
  }
  if (f.type === 'port') {
    const s = String(cur == null ? '' : cur).trim();
    if (!s || !/^\d+$/.test(s)) return null;
    return String(Number(s));
  }
  const s = String(cur == null ? '' : cur).trim();
  return s ? scalarText(s) : null;
}

function orderForParts(parts, kind) {
  const key = parts.join('.');
  if (!key) return kind === 'dns' ? DNS_TOP_ORDER : BASE_TOP_ORDER;
  return ORDER[key] || null;
}

function childIndent(parent) {
  if (!parent || parent.root) return 0;
  const any = (parent.children || []).find((c) => c.indent > parent.indent);
  return any ? any.indent : parent.indent + 2;
}

function insertCreated(parent, node, kind) {
  const order = orderForParts(pathOf(parent), kind);
  let at = -1;
  if (order) {
    const idx = order.indexOf(node.key);
    if (idx >= 0) {
      for (let k = idx - 1; k >= 0; k -= 1) {
        const j = parent.children.findIndex((c) => !c.removed && !c.seq && c.key === order[k]);
        if (j >= 0) { at = j + 1; break; }
      }
      if (at < 0) {
        for (let k = idx + 1; k < order.length; k += 1) {
          const j = parent.children.findIndex((c) => !c.removed && !c.seq && c.key === order[k]);
          if (j >= 0) { at = j; break; }
        }
      }
    }
  }
  if (at < 0) at = parent.children.length;
  node.parent = parent;
  parent.children.splice(at, 0, node);
}

function ensurePath(tree, path, kind) {
  let parent = tree.root;
  for (let i = 0; i < path.length; i += 1) {
    const last = i === path.length - 1;
    const node = parent.children.find((c) => !c.removed && !c.seq && c.key === path[i]);
    if (node && !last && !containerise(node)) return { ok: false };
    if (!node) {
      const created = {
        key: path[i], indent: childIndent(parent), inline: '', children: [], gap: [], tailLines: [],
        created: true, dirty: true, valueKind: last ? 'leaf' : 'map', leafText: '',
      };
      insertCreated(parent, created, kind);
      if (last) return { ok: true, node: created };
      parent = created;
      continue;
    }
    if (last) return { ok: true, node };
    parent = node;
  }
  return { ok: false };
}

function applyField(tree, f, cur, kind) {
  const text = valueText(f, cur);
  const node = getNode(tree, f.path);
  const alt = f.altPath ? getNode(tree, f.altPath) : null;
  if (text == null) {
    if (node) { node.removed = true; return { ok: true }; }
    if (alt) { alt.removed = true; return { ok: true }; }
    return { ok: true };
  }
  if (node) { makeLeaf(node, text); return { ok: true }; }
  if (alt) { makeLeaf(alt, text); return { ok: true }; }
  const made = ensurePath(tree, f.path, kind);
  if (!made.ok) return made;
  makeLeaf(made.node, text);
  return { ok: true };
}

function applyPolicy(tree, f, rows, prevRows, kind) {
  const prev = new Map((prevRows || []).map((r) => [String(r.name || '').trim(), String(r.value || '').trim()]));
  const clean = (rows || [])
    .map((r) => ({ name: String(r.name || '').trim(), value: String(r.value || '').trim() }))
    .filter((r) => r.name);
  let node = getNode(tree, f.path);
  if (!node) {
    if (!clean.length) return { ok: true };
    const made = ensurePath(tree, f.path, kind);
    if (!made.ok) return made;
    node = made.node;
  } else if (!containerise(node)) {
    return { ok: false };
  }
  node.dirty = true;
  node.valueKind = 'map';
  const keep = new Set(clean.map((r) => r.name));
  for (const child of node.children) if (!child.seq && !keep.has(child.key)) child.removed = true;
  for (const row of clean) {
    const child = node.children.find((c) => !c.removed && !c.seq && c.key === row.name);
    if (child && prev.get(row.name) === row.value) continue;
    if (child) {
      makeLeaf(child, scalarText(row.value));
    } else {
      node.children.push({
        key: row.name, indent: childIndent(node), inline: '', children: [], gap: [], tailLines: [],
        created: true, dirty: true, valueKind: 'leaf', leafText: scalarText(row.value), parent: node,
      });
    }
  }
  return { ok: true };
}

function markRenderable(root) {
  const walk = (node) => {
    let childDirty = false;
    for (const c of node.children) {
      /* 被删除的子节点也必须触发父级重排，否则 raw 回放会把删掉的行带回来 */
      if (c.removed) { childDirty = true; continue; }
      if (walk(c)) childDirty = true;
    }
    node.hasDirtyChild = childDirty;
    return childDirty || !!node.dirty || !!node.created;
  };
  for (const c of root.children) if (!c.removed) walk(c);
}

function render(tree) {
  const out = [];
  const emitNode = (node) => {
    out.push(...node.gap);
    if (node.created || node.dirty || node.hasDirtyChild) {
      const tail = String(node.inline || '').trim();
      const head = padOf(node.indent) + keyText(node.key) + ':'
        + (node.dirty && node.valueKind === 'leaf' ? '' : (tail[0] === '#' ? ` ${tail}` : ''));
      if (node.dirty && node.valueKind === 'leaf') {
        out.push(node.leafText ? `${head} ${node.leafText}` : head);
        return;
      }
      out.push(head);
      for (const c of node.children) { if (!c.removed) emitNode(c); }
      if (node.tailLines && node.tailLines.length) out.push(...node.tailLines);
      return;
    }
    out.push(...node.raw);
  };
  for (const c of tree.root.children) if (!c.removed) emitNode(c);
  out.push(...tree.root.tail);
  return out.join('\n');
}

function pruneEmpty(tree, touched, kind) {
  const keys = [...touched].sort((a, b) => b.split('.').length - a.split('.').length);
  for (const pathKey of keys) {
    const path = pathKey.split('.');
    if (!path.length || !path[0]) continue;
    /* dns: 段必须保留（后端要求 mihomo DNS 配置以 dns: 开头） */
    if (kind === 'dns' && path.length === 1 && path[0] === 'dns') continue;
    const node = getNode(tree, path);
    if (!node || node.removed) continue;
    if (node.children.some((c) => !c.removed)) continue;
    if (String(node.inline || '').trim()) continue;
    /* 刚被写成标量/列表的节点不能删（它是本次改动的结果，不是空壳） */
    if (node.dirty && node.valueKind === 'leaf') continue;
    if (node.created && (node.dirty || node.leafText)) continue;
    node.removed = true;
  }
}

/** 一次完整补丁：把「改动过的表单字段」写回 YAML 文本。 */
function patchYaml(text, kind, changes) {
  const tree = parseTree(text);
  const touched = new Set();
  const failed = [];
  for (const item of changes) {
    const f = item.field;
    const r = f.type === 'policy'
      ? applyPolicy(tree, f, item.value, item.prev, kind)
      : applyField(tree, f, item.value, kind);
    if (!r.ok) { failed.push(f.label); continue; }
    for (let i = 1; i < f.path.length; i += 1) touched.add(f.path.slice(0, i).join('.'));
  }
  pruneEmpty(tree, touched, kind);
  markRenderable(tree.root);
  return { text: render(tree), failed };
}

if (typeof module !== 'undefined' && module.exports) {
  /* 仅用于脚本自测（打包时不会被引用） */
  module.exports = { parseTree, getNode, nodeValue, render, patchYaml, parseScalar, splitKeyValue };
}
</script>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { NButton, NInput, NSelect } from 'naive-ui';

const props = defineProps({
  kind: { type: String, default: 'base' },
  modelValue: { type: String, default: '' },
  original: { type: String, default: '' },
  height: { type: String, default: '420px' },
});
const emit = defineEmits(['update:modelValue']);

const BOOL_OPTIONS = [
  { label: '开启 true', value: true },
  { label: '关闭 false', value: false },
];

const BASE_FIELDS = [
  { group: '端口与模式', key: 'mixedPort', label: 'mixed-port', path: ['mixed-port'], type: 'port', hint: 'HTTP/SOCKS 混合端口' },
  { group: '端口与模式', key: 'socksPort', label: 'socks-port', path: ['socks-port'], type: 'port', hint: '单独 SOCKS 端口' },
  { group: '端口与模式', key: 'allowLan', label: 'allow-lan', path: ['allow-lan'], type: 'bool', hint: '允许局域网连接' },
  { group: '端口与模式', key: 'mode', label: 'mode', path: ['mode'], type: 'enum', options: ['rule', 'global', 'direct'], hint: '出站模式' },
  { group: '端口与模式', key: 'logLevel', label: 'log-level', path: ['log-level'], type: 'enum', options: ['silent', 'error', 'warning', 'info', 'debug'] },
  { group: '连接与兼容', key: 'ipv6', label: 'ipv6', path: ['ipv6'], type: 'bool', hint: 'IPv6 解析与出站' },
  { group: '连接与兼容', key: 'unifiedDelay', label: 'unified-delay', path: ['unified-delay'], type: 'bool', hint: '统一延迟测量口径' },
  { group: '连接与兼容', key: 'tcpConcurrent', label: 'tcp-concurrent', path: ['tcp-concurrent'], type: 'bool', hint: 'TCP 并发握手' },
  { group: '连接与兼容', key: 'globalClientFingerprint', label: 'global-client-fingerprint', path: ['global-client-fingerprint'], type: 'enum', options: ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random'], custom: true, hint: 'TLS 指纹伪装' },
  { group: '外部控制', key: 'externalController', label: 'external-controller', path: ['external-controller'], type: 'text', placeholder: '127.0.0.1:9090', hint: '面板 / API 监听地址' },
  { group: '外部控制', key: 'secret', label: 'secret', path: ['secret'], type: 'password', hint: '面板 / API 密码（明文保存）' },
  { group: '订阅存储 profile', key: 'profileStoreSelected', label: 'profile.store-selected', path: ['profile', 'store-selected'], type: 'bool', hint: '记住手动选择的节点' },
  { group: '订阅存储 profile', key: 'profileStoreFakeIp', label: 'profile.store-fake-ip', path: ['profile', 'store-fake-ip'], type: 'bool', hint: '持久化 fake-ip 映射' },
  { group: 'Sniffer 嗅探', key: 'snifferEnable', label: 'sniffer.enable', path: ['sniffer', 'enable'], type: 'bool' },
  { group: 'Sniffer 嗅探', key: 'snifferParsePureIp', label: 'sniffer.parse-pure-ip', path: ['sniffer', 'parse-pure-ip'], type: 'bool', hint: '对纯 IP 连接也嗅探域名' },
  { group: 'Sniffer 嗅探', key: 'sniffHttp', label: 'sniffer.sniff.HTTP', path: ['sniffer', 'sniff', 'HTTP', 'ports'], altPath: ['sniffer', 'sniff', 'HTTP'], type: 'list', hint: 'HTTP 端口，逗号分隔（支持 8080-8880）' },
  { group: 'Sniffer 嗅探', key: 'sniffTls', label: 'sniffer.sniff.TLS', path: ['sniffer', 'sniff', 'TLS', 'ports'], altPath: ['sniffer', 'sniff', 'TLS'], type: 'list', hint: 'TLS 端口，逗号分隔' },
  { group: 'Sniffer 嗅探', key: 'sniffQuic', label: 'sniffer.sniff.QUIC', path: ['sniffer', 'sniff', 'QUIC', 'ports'], altPath: ['sniffer', 'sniff', 'QUIC'], type: 'list', hint: 'QUIC 端口，逗号分隔' },
];

const DNS_FIELDS = [
  { group: 'DNS 基础', key: 'dnsEnable', label: 'dns.enable', path: ['dns', 'enable'], type: 'bool', hint: '接管 DNS 解析' },
  { group: 'DNS 基础', key: 'dnsListen', label: 'dns.listen', path: ['dns', 'listen'], type: 'text', placeholder: '0.0.0.0:1053' },
  { group: 'DNS 基础', key: 'dnsIpv6', label: 'dns.ipv6', path: ['dns', 'ipv6'], type: 'bool', hint: '请求 AAAA' },
  { group: 'DNS 基础', key: 'dnsEnhancedMode', label: 'dns.enhanced-mode', path: ['dns', 'enhanced-mode'], type: 'enum', options: ['fake-ip', 'redir-host', 'normal'] },
  { group: 'DNS 基础', key: 'dnsFakeIpRange', label: 'dns.fake-ip-range', path: ['dns', 'fake-ip-range'], type: 'text', placeholder: '198.18.0.1/16' },
  { group: 'Hosts 与规则', key: 'dnsUseHosts', label: 'dns.use-hosts', path: ['dns', 'use-hosts'], type: 'bool', hint: '使用 hosts' },
  { group: 'Hosts 与规则', key: 'dnsUseSystemHosts', label: 'dns.use-system-hosts', path: ['dns', 'use-system-hosts'], type: 'bool', hint: '使用系统 hosts' },
  { group: 'Hosts 与规则', key: 'dnsRespectRules', label: 'dns.respect-rules', path: ['dns', 'respect-rules'], type: 'bool', hint: '按规则走代理解析' },
  { group: '上游服务器', key: 'dnsDefaultNameserver', label: 'dns.default-nameserver', path: ['dns', 'default-nameserver'], type: 'list', hint: '只放纯 IP，用于解析其他 DNS 域名' },
  { group: '上游服务器', key: 'dnsNameserver', label: 'dns.nameserver', path: ['dns', 'nameserver'], type: 'list', hint: '默认上游，逗号分隔' },
  { group: '上游服务器', key: 'dnsProxyServerNameserver', label: 'dns.proxy-server-nameserver', path: ['dns', 'proxy-server-nameserver'], type: 'list', hint: '代理节点域名解析用' },
  { group: '回退过滤', key: 'dnsFallback', label: 'dns.fallback', path: ['dns', 'fallback'], type: 'list', hint: '国内解析结果不合格时回退' },
  { group: '回退过滤', key: 'dnsGeoip', label: 'fallback-filter.geoip', path: ['dns', 'fallback-filter', 'geoip'], type: 'bool' },
  { group: '回退过滤', key: 'dnsGeoipCode', label: 'fallback-filter.geoip-code', path: ['dns', 'fallback-filter', 'geoip-code'], type: 'text', placeholder: 'CN' },
  { group: '回退过滤', key: 'dnsIpcidr', label: 'fallback-filter.ipcidr', path: ['dns', 'fallback-filter', 'ipcidr'], type: 'list', hint: '命中即视为被污染的网段' },
  { group: '域名策略', key: 'dnsPolicy', label: 'dns.nameserver-policy', path: ['dns', 'nameserver-policy'], type: 'policy' },
];

const GROUP_HINTS = {
  端口与模式: '留空表示使用 mihomo 默认值',
  连接与兼容: '',
  外部控制: '',
  '订阅存储 profile': '',
  'Sniffer 嗅探': '只填写需要嗅探的端口',
  'DNS 基础': '',
  'Hosts 与规则': '',
  上游服务器: '逗号分隔，支持 tls:// https:// 等写法',
  回退过滤: '',
  域名策略: '未改动的条目保留原始写法',
};

/* 表单状态：字符串 / 布尔 / 策略行数组 */
const form = reactive({});
const orig = ref({});
const invalid = reactive({});
const loadNote = ref('');
const emitNote = ref('');
const baseText = ref('');
const lastEmit = ref('');

const fields = computed(() => (props.kind === 'dns' ? DNS_FIELDS : BASE_FIELDS));

const sections = computed(() => {
  const out = [];
  for (const f of fields.value) {
    let sec = out.find((s) => s.group === f.group);
    if (!sec) {
      sec = { group: f.group, hint: GROUP_HINTS[f.group] || '', fields: [] };
      out.push(sec);
    }
    sec.fields.push(f);
  }
  return out;
});

const changedCount = computed(() => fields.value.filter((f) => !sameValue(f, form[f.key], orig.value[f.key])).length);

const canRevert = computed(() => !!props.original && changedCount.value > 0);

function blankValue(f) {
  if (f.type === 'policy') return [];
  if (f.type === 'bool' || f.type === 'enum') return null;
  return '';
}

function cloneValue(f, value) {
  if (f.type === 'policy') return (value || []).map((r) => ({ name: r.name, value: r.value }));
  return value;
}

function sameValue(f, a, b) {
  if (f.type === 'policy') {
    const x = a || [];
    const y = b || [];
    if (x.length !== y.length) return false;
    return x.every((row, i) => String(row.name || '') === String(y[i].name || '')
      && String(row.value || '') === String(y[i].value || ''));
  }
  /* 布尔要区分 false 与「未设置」：不能用 (a || null) === (b || null)，那会把 false 当成 null */
  if (f.type === 'bool') {
    const x = a == null || a === '' ? null : !!a;
    const y = b == null || b === '' ? null : !!b;
    return x === y;
  }
  return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
}

function enumOptions(f) {
  const opts = (f.options || []).map((o) => ({ label: o, value: o }));
  const cur = form[f.key];
  if (cur && !opts.some((o) => o.value === cur)) opts.unshift({ label: `${cur}（当前）`, value: cur });
  return opts;
}

function scalarToText(value) {
  if (Array.isArray(value)) return value.filter((x) => x == null || typeof x !== 'object').map(String).join(', ');
  if (value == null) return '';
  if (typeof value === 'object') return '';
  return String(value);
}

function readField(tree, f) {
  if (f.type === 'policy') {
    const node = getNode(tree, f.path);
    if (!node) return { ok: true, value: [] };
    const raw = nodeValue(node);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
    return { ok: true, value: Object.keys(raw).map((name) => ({ name, value: scalarToText(raw[name]) })) };
  }
  const node = getNode(tree, f.path) || (f.altPath ? getNode(tree, f.altPath) : null);
  if (!node) return { ok: true, value: blankValue(f) };
  const raw = nodeValue(node);
  if (f.type === 'bool') {
    if (raw === true || raw === 'true' || raw === 'yes' || raw === 'on') return { ok: true, value: true };
    if (raw === false || raw === 'false' || raw === 'no' || raw === 'off') return { ok: true, value: false };
    if (raw === '' || raw == null) return { ok: true, value: null };
    return { ok: false };
  }
  if (f.type === 'list') {
    if (Array.isArray(raw)) {
      return { ok: true, value: raw.filter((x) => x == null || typeof x !== 'object').map(String).join(', ') };
    }
    if (raw && typeof raw === 'object') return { ok: false };
    return { ok: true, value: raw == null ? '' : String(raw) };
  }
  if (raw && typeof raw === 'object') return { ok: false };
  return { ok: true, value: raw == null ? '' : String(raw) };
}

function refreshInvalid() {
  for (const f of fields.value) {
    if (f.type !== 'port') { delete invalid[f.key]; continue; }
    const s = String(form[f.key] == null ? '' : form[f.key]).trim();
    if (!s) { delete invalid[f.key]; continue; }
    if (!/^\d+$/.test(s)) { invalid[f.key] = '需为整数端口'; continue; }
    if (Number(s) < 1 || Number(s) > 65535) { invalid[f.key] = '范围 1–65535'; continue; }
    delete invalid[f.key];
  }
}

function loadFromText(text) {
  const src = String(text == null ? '' : text);
  baseText.value = src;
  const tree = parseTree(src);
  const next = {};
  const bad = [];
  for (const f of fields.value) {
    const r = readField(tree, f);
    next[f.key] = r.ok ? r.value : blankValue(f);
    if (!r.ok) bad.push(f.label);
  }
  for (const k of Object.keys(form)) if (!(k in next)) delete form[k];
  Object.assign(form, next);
  orig.value = {};
  for (const f of fields.value) orig.value[f.key] = cloneValue(f, next[f.key]);
  loadNote.value = bad.length
    ? `以下字段原写法不是普通映射，可视化模式暂不接管（保留原文，可在原始 YAML 中改）：${bad.join('、')}`
    : '';
  refreshInvalid();
  lastEmit.value = src;
}

/* 表单值 → YAML 的补丁逻辑在文件顶部的 <script> 里（纯函数，便于复用/自测）。 */

function emitYaml() {
  const changes = [];
  for (const f of fields.value) {
    if (f.type === 'port' && invalid[f.key]) continue;
    if (sameValue(f, form[f.key], orig.value[f.key])) continue;
    changes.push({ field: f, value: form[f.key], prev: orig.value[f.key] });
  }
  /* 每次都从「表单加载时的原文」重新打补丁：把字段改回原值也能还原成原文 */
  const res = patchYaml(baseText.value, props.kind, changes);
  const out = res.text;
  emitNote.value = res.failed.length
    ? `${res.failed.join('、')} 的原结构无法安全合并，已保留原文；请切到原始 YAML 处理这些字段。`
    : '';
  if (out === lastEmit.value) return;
  lastEmit.value = out;
  emit('update:modelValue', out);
}

function revertAll() {
  const src = String(props.original || '') || baseText.value;
  if (!src) return;
  loadFromText(src);
  emit('update:modelValue', src);
}

onMounted(() => loadFromText(props.modelValue));

watch(() => props.modelValue, (value) => {
  const next = String(value == null ? '' : value);
  /* 自己 emit 出去的回声不重新解析，否则每敲一个键都会丢焦点/回滚光标 */
  if (next === lastEmit.value) return;
  loadFromText(next);
});

watch(() => props.kind, () => loadFromText(props.modelValue));

/* 弹窗复用同一个实例：重新打开（original 变了）时按最新内容重置表单基线 */
watch(() => props.original, () => {
  if (String(props.original || '') !== baseText.value) loadFromText(props.modelValue);
});

watch(form, () => {
  refreshInvalid();
  emitYaml();
}, { deep: true });
</script>

<style scoped>
.bdf {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.bdf-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--panel-strong);
  min-width: 0;
}

.bdf-title { font-size: 12px; color: var(--text); white-space: nowrap; }

.bdf-spacer { flex: 1 1 auto; }

.bdf-hint {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.bdf-count { font-size: 11px; color: var(--accent); white-space: nowrap; }

.bdf-note {
  margin: 8px 12px 0;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--warn);
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.32);
}

.bdf-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bdf-sec {
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  padding: 8px 10px 10px;
  background: var(--panel);
}

.bdf-sec-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text);
  min-width: 0;
}

.bdf-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}

.bdf-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.bdf-field.is-wide { grid-column: 1 / -1; }

/* 控件撑满所在列（naive-ui 默认宽度不稳定，用 :deep 兜底） */
.bdf-field :deep(.n-select),
.bdf-field :deep(.n-input) { width: 100%; }

.bdf-field.is-bad :deep(.n-input) {
  border-color: var(--danger);
}

.bdf-label {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.bdf-label code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 0 4px;
  white-space: nowrap;
}

.bdf-bad { font-size: 11px; color: var(--danger); white-space: nowrap; }

.bdf-policy {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bdf-policy-row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr) auto;
  gap: 6px;
  align-items: center;
}

.bdf-policy-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

@media (max-width: 900px) {
  .bdf-grid { grid-template-columns: minmax(0, 1fr); }
  .bdf-policy-row { grid-template-columns: minmax(0, 1fr); }
}

html[data-theme='light'] .bdf-sec {
  background: var(--panel-strong);
  border-color: var(--line);
}

html[data-theme='light'] .bdf-label code {
  background: var(--accent-soft);
}
</style>
