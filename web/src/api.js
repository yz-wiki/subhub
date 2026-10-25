// 反代子路径：由服务端注入 window.__SUBHUB_BASE__（例如 /sub），本地开发为空
const RUNTIME_BASE = typeof window !== 'undefined' && window.__SUBHUB_BASE__ ? String(window.__SUBHUB_BASE__) : '';

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const url = RUNTIME_BASE && path.startsWith('/') ? RUNTIME_BASE + path : path;
  const res = await fetch(url, init);
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });
