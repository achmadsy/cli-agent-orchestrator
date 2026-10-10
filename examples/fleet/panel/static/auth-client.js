let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = token || null;
}

export function clearAuthState() {
  csrfToken = null;
}

export async function authFetch(path, options = {}) {
  const opts = { ...options, credentials: "same-origin" };
  const method = (opts.method || "GET").toUpperCase();
  if (!new Set(["GET", "HEAD", "OPTIONS"]).has(method) && csrfToken) {
    opts.headers = { ...(opts.headers || {}), "X-CSRF-Token": csrfToken };
  }
  const response = await fetch(path, opts);
  if (response.status === 401) {
    clearAuthState();
    window.dispatchEvent(new CustomEvent("cao-auth-required"));
  }
  return response;
}

export async function authJson(path, options = {}) {
  const response = await authFetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || response.statusText);
  }
  return response.json();
}
