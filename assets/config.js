/* ===== Site configuration =====
 * Edit these two values after you deploy the Cloudflare Worker.
 * Both are PUBLIC values (safe to commit to a public GitHub repo).
 *
 *   BOARD_API_URL: the public URL of your Cloudflare Worker
 *                  e.g. "https://watanabe-board.<your-subdomain>.workers.dev"
 *
 *   TURNSTILE_SITE_KEY: the "Site key" from Cloudflare Turnstile
 *                       (NOT the "Secret key" — that one stays in the Worker)
 *                       Leave as "" to disable Turnstile during local testing.
 */
window.BOARD_API_URL = "https://REPLACE-ME.workers.dev";
window.TURNSTILE_SITE_KEY = "";
