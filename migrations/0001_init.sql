-- Categories form a tree: top-level categories own a label prefix (A, R, ...)
-- and a counter; sub-lists inherit their top-level category's prefix.
CREATE TABLE categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES categories(id),
  prefix     TEXT,
  next_num   INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX categories_prefix ON categories(prefix) WHERE prefix IS NOT NULL;

-- Items are never hard-deleted on completion: done_at set = archived, hidden from the list.
CREATE TABLE items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  label       TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  done_at     TEXT
);
CREATE UNIQUE INDEX items_open_label ON items(label) WHERE done_at IS NULL;

-- Short chat memory so "move it to recruiting" works across messages.
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Meta retries webhooks; remember message ids so a retry is not processed twice.
CREATE TABLE processed (
  msg_id     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
