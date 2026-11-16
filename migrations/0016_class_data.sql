CREATE TABLE IF NOT EXISTS classes (
  code              TEXT PRIMARY KEY,
  teacher_key_hash  TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS class_values (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL,
  topic        TEXT NOT NULL,
  value        INTEGER NOT NULL,
  device_hash  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (code, topic, device_hash)
);

CREATE INDEX IF NOT EXISTS idx_class_values_code_topic_value ON class_values (code, topic, value, id);
CREATE INDEX IF NOT EXISTS idx_classes_created ON classes (created_at);
