-- D1 schema for Watanabe Group bulletin board
-- Run with: wrangler d1 execute watanabe-board --file=./schema.sql
-- For remote (production) DB, add the --remote flag.

CREATE TABLE IF NOT EXISTS posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  board           TEXT    NOT NULL,           -- 'ca' or 'am'
  handle          TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  ip_hash         TEXT    NOT NULL,           -- short salted SHA-256 of poster IP
  created_at      TEXT    NOT NULL,           -- ISO-8601 timestamp (for display)
  created_at_unix INTEGER NOT NULL,           -- unix seconds (for rate limiting)
  deleted_at      TEXT                        -- soft-delete; NULL = visible
);

CREATE INDEX IF NOT EXISTS idx_posts_board_id   ON posts (board, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_iphash_ts  ON posts (ip_hash, created_at_unix);
