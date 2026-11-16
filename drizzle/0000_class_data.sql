CREATE TABLE IF NOT EXISTS ai_chat_usage (
  client_id  TEXT NOT NULL,
  day        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, day)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS classes (
  code              TEXT PRIMARY KEY,
  teacher_key_hash  TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS class_values (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL,
  topic        TEXT NOT NULL,
  value        INTEGER NOT NULL,
  device_hash  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (code, topic, device_hash)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_class_values_code_topic_value ON class_values (code, topic, value, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_classes_created ON classes (created_at);
--> statement-breakpoint

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
--> statement-breakpoint

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
--> statement-breakpoint
