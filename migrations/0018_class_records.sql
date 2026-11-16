CREATE TABLE IF NOT EXISTS class_records (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL,
  topic        TEXT NOT NULL,
  device_hash  TEXT NOT NULL,
  seq          INTEGER,
  grp          INTEGER CHECK (grp IS NULL OR grp IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (code, topic, device_hash),
  UNIQUE (code, topic, seq)
);
