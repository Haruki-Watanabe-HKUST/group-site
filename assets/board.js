/* ===== Bulletin board client-side logic ===== */
/*
 * Expects:
 *   - <div class="board" data-board-id="ca"> (or "am") on the page
 *   - window.BOARD_API_URL and window.TURNSTILE_SITE_KEY defined in HTML before this script
 *   - KaTeX auto-render loaded for math typesetting
 */

(function () {
  "use strict";

  const API = window.BOARD_API_URL;
  const TURNSTILE_KEY = window.TURNSTILE_SITE_KEY;

  if (!API) {
    console.error("BOARD_API_URL is not configured");
    return;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function formatTimestamp(iso) {
    try {
      const d = new Date(iso);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const mi = String(d.getMinutes()).padStart(2, "0");
      return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
    } catch (_e) {
      return iso;
    }
  }

  function renderMath(container) {
    if (window.renderMathInElement) {
      window.renderMathInElement(container, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
          { left: "\\[", right: "\\]", display: true },
        ],
        throwOnError: false,
      });
    }
  }

  function renderPosts(container, posts) {
    if (!posts || posts.length === 0) {
      container.innerHTML = '<div class="post-empty">まだ投稿はありません。最初の質問を投稿してみましょう。</div>';
      return;
    }
    const html = posts
      .map(function (p) {
        return [
          '<article class="post" id="post-' + p.id + '">',
          '<div class="post-header">',
          '<span class="handle">' + escapeHtml(p.handle || "名無し") + "</span>",
          '<span class="ts">' + formatTimestamp(p.created_at) + "</span>",
          "</div>",
          '<div class="post-body">' + escapeHtml(p.body) + "</div>",
          "</article>",
        ].join("");
      })
      .join("");
    container.innerHTML = html;
    renderMath(container);
  }

  async function loadPosts(boardId, container, statusEl, opts) {
    const initial = opts && opts.initial;
    if (!initial) {
      statusEl.textContent = "読み込み中…";
      statusEl.className = "board-status";
    }
    try {
      const res = await fetch(API + "/posts?board=" + encodeURIComponent(boardId), {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      renderPosts(container, data.posts || []);
      statusEl.textContent = "";
      statusEl.className = "board-status";
    } catch (e) {
      // If a static archive is already rendered, keep it silently.
      const hasStaticArchive = container.querySelector(".post");
      if (initial && hasStaticArchive) {
        statusEl.textContent = "";
        statusEl.className = "board-status";
        return;
      }
      statusEl.textContent = "投稿の読み込みに失敗しました: " + e.message;
      statusEl.className = "board-status error";
    }
  }

  async function submitPost(boardId, payload, statusEl) {
    statusEl.textContent = "送信中…";
    statusEl.className = "board-status";
    const res = await fetch(API + "/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(Object.assign({ board: boardId }, payload)),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      const msg = data.error || ("HTTP " + res.status);
      throw new Error(msg);
    }
    return data;
  }

  function init(boardEl) {
    const boardId = boardEl.dataset.boardId;
    if (!boardId) {
      console.error("data-board-id missing");
      return;
    }

    const form = boardEl.querySelector(".board-form");
    const handleInput = boardEl.querySelector('input[name="handle"]');
    const bodyInput = boardEl.querySelector('textarea[name="body"]');
    const honeypot = boardEl.querySelector('input[name="website"]');
    const submitBtn = boardEl.querySelector('button[type="submit"]');
    const statusEl = boardEl.querySelector(".board-status");
    const postsEl = boardEl.querySelector(".posts");
    const turnstileMount = boardEl.querySelector(".cf-turnstile");

    let turnstileToken = "";
    let turnstileWidgetId = null;

    function mountTurnstile() {
      if (!TURNSTILE_KEY || !window.turnstile || !turnstileMount) return;
      turnstileWidgetId = window.turnstile.render(turnstileMount, {
        sitekey: TURNSTILE_KEY,
        callback: function (token) { turnstileToken = token; },
        "error-callback": function () { turnstileToken = ""; },
        "expired-callback": function () { turnstileToken = ""; },
      });
    }

    if (TURNSTILE_KEY) {
      if (window.turnstile) {
        mountTurnstile();
      } else {
        window.onloadTurnstileCallback = mountTurnstile;
      }
    }

    // Typeset any pre-rendered static archive (KaTeX may not be loaded yet on first paint).
    function typesetStatic() { renderMath(postsEl); }
    if (window.renderMathInElement) {
      typesetStatic();
    } else {
      window.addEventListener("load", typesetStatic);
    }

    loadPosts(boardId, postsEl, statusEl, { initial: true });

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const handle = (handleInput.value || "").trim();
      const body = (bodyInput.value || "").trim();
      if (!handle) { statusEl.textContent = "ハンドルネームを入力してください。"; statusEl.className = "board-status error"; return; }
      if (!body) { statusEl.textContent = "質問内容を入力してください。"; statusEl.className = "board-status error"; return; }
      if (honeypot && honeypot.value) {
        statusEl.textContent = "送信できませんでした。"; statusEl.className = "board-status error"; return;
      }

      submitBtn.disabled = true;
      try {
        await submitPost(boardId, {
          handle: handle,
          body: body,
          turnstile_token: turnstileToken,
        }, statusEl);
        handleInput.value = "";
        bodyInput.value = "";
        statusEl.textContent = "投稿しました。";
        statusEl.className = "board-status ok";
        if (turnstileWidgetId !== null && window.turnstile) {
          window.turnstile.reset(turnstileWidgetId);
          turnstileToken = "";
        }
        await loadPosts(boardId, postsEl, statusEl);
        statusEl.textContent = "投稿しました。";
        statusEl.className = "board-status ok";
      } catch (err) {
        statusEl.textContent = "投稿に失敗しました: " + err.message;
        statusEl.className = "board-status error";
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".board[data-board-id]").forEach(init);
  });
})();
