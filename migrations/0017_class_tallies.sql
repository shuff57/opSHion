CREATE TABLE IF NOT EXISTS class_tallies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL,
  topic        TEXT NOT NULL,
  counts       TEXT NOT NULL,
  total        INTEGER NOT NULL,
  device_hash  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (code, topic, device_hash)
);
