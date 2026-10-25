'use strict';

/**
 * 基础工具：日志环形缓冲、HTTP 响应、请求体读取、错误类型。
 * 无第三方依赖。
 */

const MAX_LOG = 500;
const logs = [];
let logSeq = 0;

function log(tag, msg) {
  const line = {
    id: ++logSeq,
    ts: new Date().toISOString(),
    tag: String(tag),
    msg: String(msg),
  };
  logs.push(line);
  if (logs.length > MAX_LOG) logs.splice(0, logs.length - MAX_LOG);
  process.stdout.write(`${line.ts} [${tag}] ${line.msg}\n`);
}

function recentLogs(limit = 200) {
  const n = Math.max(1, Math.min(Number(limit) || 200, MAX_LOG));
  return logs.slice(-n);
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
  const isHead = res.req && res.req.method === 'HEAD';
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': buf.length,
    ...headers,
  });
  res.end(isHead ? undefined : buf);
}

function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj, null, 2), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, '请求被中断')));
  });
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'JSON 格式不正确');
  }
}

function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function maskToken(token) {
  if (!token) return '-';
  const s = String(token);
  if (s.length <= 6) return s[0] + '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

function newId(bytes = 12) {
  return require('node:crypto').randomBytes(bytes).toString('base64url');
}

function sha1(text) {
  return require('node:crypto').createHash('sha1').update(String(text)).digest('hex');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return require('node:crypto').timingSafeEqual(ab, bb);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  HttpError,
  log,
  recentLogs,
  send,
  json,
  readBody,
  readJson,
  clientIp,
  maskToken,
  newId,
  sha1,
  safeEqual,
  fmtBytes,
  nowIso,
};
