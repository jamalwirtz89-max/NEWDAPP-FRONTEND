/**
 * src/lib/apiClient.js
 *
 * Wrapper fetch qui :
 *  - récupère un JWT au premier appel  (GET /api/auth/token)
 *  - l'injecte dans X-Session-Token sur chaque requête
 *  - le refresh automatiquement 60s avant expiry
 *  - retry une fois si 401 TOKEN_EXPIRED
 *
 * Token stocké EN MÉMOIRE uniquement (jamais localStorage).
 */

const BASE = process.env.NEXT_PUBLIC_BACKEND_URL || "";

let _token = null, _exp = 0, _pending = null, _timer = null;

async function fetchToken() {
  if (_pending) return _pending;
  _pending = (async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/token`, {
        headers: { Referer: typeof window !== "undefined" ? window.location.href : "" },
      });
      if (!res.ok) throw new Error(`auth/token → ${res.status}`);
      const { token, expiresAt, ttl } = await res.json();
      _token = token; _exp = expiresAt;
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(() => fetchToken().catch(console.error), Math.max((ttl - 60) * 1000, 0));
      return token;
    } finally { _pending = null; }
  })();
  return _pending;
}

async function getToken() {
  if (!_token || Math.floor(Date.now() / 1000) >= _exp - 10) return fetchToken();
  return _token;
}

async function apiFetch(path, opts = {}, retry = false) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Session-Token": token, ...(opts.headers || {}) },
  });
  if (res.status === 401 && !retry) {
    const b = await res.json().catch(() => ({}));
    if (b.code === "TOKEN_EXPIRED" || b.code === "TOKEN_INVALID") { _token = null; return apiFetch(path, opts, true); }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `API ${res.status}`);
  }
  return res.json();
}

const api = {
  init: ()             => fetchToken(),
  get : (path, o = {}) => apiFetch(path, { method: "GET",  ...o }),
  post: (path, body, o = {}) => apiFetch(path, { method: "POST", body: JSON.stringify(body), ...o }),
};

export default api;
