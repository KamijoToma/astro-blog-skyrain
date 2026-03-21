CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_id INTEGER,
  author_name TEXT NOT NULL,
  author_email_hash TEXT,
  author_url TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  ip_hash TEXT NOT NULL,
  user_agent TEXT,
  turnstile_ok INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES comments(id)
);

CREATE INDEX IF NOT EXISTS idx_comments_slug_status_created
  ON comments(slug, status, created_at);

CREATE INDEX IF NOT EXISTS idx_comments_parent_id
  ON comments(parent_id);

CREATE TABLE IF NOT EXISTS comment_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_ip_path_created
  ON comment_rate_limits(ip_hash, path, created_at);
