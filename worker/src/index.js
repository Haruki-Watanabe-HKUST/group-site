/* ===== Cloudflare Worker — Watanabe Group bulletin board API =====
 *
 * Routes:
 *   GET  /posts?board=ca|am          List public posts (newest first)
 *   POST /posts                      Create a new post
 *   GET  /admin/posts?board=ca|am    Admin: list posts (auth required)
 *   DELETE /admin/posts/:id          Admin: delete a post (auth required)
 *
 * Bindings (configured in wrangler.toml / Cloudflare dashboard):
 *   env.DB                           D1 database (see schema.sql)
 *   env.ADMIN_PASSWORD               (secret) Plain-text admin password
 *   env.TURNSTILE_SECRET_KEY         (secret) Cloudflare Turnstile secret key
 *   env.ALLOWED_ORIGINS              Comma-separated list of allowed CORS origins
 *                                    e.g. "https://<user>.github.io,https://example.com"
 *   env.IP_HASH_SALT                 (secret) Random string used to hash visitor IPs
 */

const MAX_HANDLE_LEN = 40;
const MAX_BODY_LEN = 4000;
const VALID_BOARDS = ["ca", "am", "qm"];
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX_POSTS = 3;
const PUBLIC_LIST_LIMIT = 200;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(request, env, new Response(null, { status: 204 }));
    }

    try {
      let response;
      if (url.pathname === "/posts" && request.method === "GET") {
        response = await handleListPosts(request, env, url);
      } else if (url.pathname === "/posts" && request.method === "POST") {
        response = await handleCreatePost(request, env);
      } else if (url.pathname === "/admin/posts" && request.method === "GET") {
        response = await handleAdminList(request, env, url);
      } else if (url.pathname.startsWith("/admin/posts/") && request.method === "DELETE") {
        const id = url.pathname.slice("/admin/posts/".length);
        response = await handleAdminDelete(request, env, id);
      } else if (url.pathname === "/" && request.method === "GET") {
        response = json({ ok: true, service: "watanabe-board" });
      } else {
        response = json({ error: "not_found" }, 404);
      }
      return corsResponse(request, env, response);
    } catch (e) {
      console.error("Unhandled error:", e);
      return corsResponse(request, env, json({ error: "internal_error" }, 500));
    }
  },
};

/* ---------- Route handlers ---------- */

async function handleListPosts(request, env, url) {
  const board = (url.searchParams.get("board") || "").toLowerCase();
  if (!VALID_BOARDS.includes(board)) return json({ error: "invalid_board" }, 400);

  const stmt = env.DB.prepare(
    "SELECT id, handle, body, created_at FROM posts WHERE board = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?"
  ).bind(board, PUBLIC_LIST_LIMIT);
  const { results } = await stmt.all();
  return json({ posts: results });
}

async function handleCreatePost(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (_e) {
    return json({ error: "invalid_json" }, 400);
  }

  const board = String(payload.board || "").toLowerCase();
  const handle = String(payload.handle || "").trim();
  const body = String(payload.body || "").trim();
  const turnstileToken = String(payload.turnstile_token || "");

  if (!VALID_BOARDS.includes(board)) return json({ error: "invalid_board" }, 400);
  if (!handle) return json({ error: "handle_required" }, 400);
  if (handle.length > MAX_HANDLE_LEN) return json({ error: "handle_too_long" }, 400);
  if (!body) return json({ error: "body_required" }, 400);
  if (body.length > MAX_BODY_LEN) return json({ error: "body_too_long" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ipHash = await hashIp(ip, env.IP_HASH_SALT || "default-salt");

  // Rate limit: at most N posts per window per IP across all boards
  const since = nowSec() - RATE_LIMIT_WINDOW_SEC;
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM posts WHERE ip_hash = ? AND created_at_unix >= ?"
  ).bind(ipHash, since).first();
  if (recent && recent.c >= RATE_LIMIT_MAX_POSTS) {
    return json({ error: "rate_limited", retry_after: RATE_LIMIT_WINDOW_SEC }, 429);
  }

  // Turnstile verification (only if a secret is configured)
  if (env.TURNSTILE_SECRET_KEY) {
    const ok = await verifyTurnstile(turnstileToken, ip, env.TURNSTILE_SECRET_KEY);
    if (!ok) return json({ error: "captcha_failed" }, 400);
  }

  const nowIso = new Date().toISOString();
  const nowUnix = nowSec();
  const result = await env.DB.prepare(
    "INSERT INTO posts (board, handle, body, ip_hash, created_at, created_at_unix) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(board, handle, body, ipHash, nowIso, nowUnix).run();

  return json({ ok: true, id: result.meta.last_row_id });
}

async function handleAdminList(request, env, url) {
  if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
  const board = (url.searchParams.get("board") || "").toLowerCase();
  if (!VALID_BOARDS.includes(board)) return json({ error: "invalid_board" }, 400);
  const { results } = await env.DB.prepare(
    "SELECT id, handle, body, ip_hash, created_at, deleted_at FROM posts WHERE board = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 500"
  ).bind(board).all();
  return json({ posts: results });
}

async function handleAdminDelete(request, env, idStr) {
  if (!checkAdmin(request, env)) return json({ error: "unauthorized" }, 401);
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || id <= 0) return json({ error: "invalid_id" }, 400);
  await env.DB.prepare(
    "UPDATE posts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
  ).bind(new Date().toISOString(), id).run();
  return json({ ok: true });
}

/* ---------- Helpers ---------- */

function checkAdmin(request, env) {
  const provided = request.headers.get("X-Admin-Password") || "";
  const expected = env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  return constantTimeEqual(provided, expected);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyTurnstile(token, ip, secret) {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  form.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    return !!data.success;
  } catch (_e) {
    return false;
  }
}

async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(salt + ":" + ip);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const arr = Array.from(new Uint8Array(buf));
  return arr.slice(0, 8).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function corsResponse(request, env, response) {
  const origin = request.headers.get("Origin") || "";
  const allowList = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(Boolean);

  const headers = new Headers(response.headers);
  if (allowList.length === 0 || allowList.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin || "*");
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, { status: response.status, headers });
}
