import type { Migration } from '../../node/sqlite'

/**
 * Local DB migrations (personal data, never sent to the server - 2.3).
 * Never edit an applied migration; append a new one instead.
 */
export const LOCAL_MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'base',
    sql: `
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE query_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, key)
);
`
  },
  {
    id: 2,
    name: 'personal-events-diary',
    sql: `
CREATE TABLE personal_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  rrule TEXT,
  exdates TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  reminders TEXT NOT NULL DEFAULT '[]',
  busy_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_pe_range ON personal_events(start_at, end_at);
CREATE TABLE diary_entries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE fired_reminders (
  key TEXT PRIMARY KEY,
  fired_at INTEGER NOT NULL
);
`
  },
  {
    id: 3,
    name: 'personal-tasks',
    sql: `
CREATE TABLE personal_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  due_at INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal',
  done_at INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`
  },
  {
    id: 4,
    name: 'memos-alarms-tools',
    sql: `
CREATE TABLE memos (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'yellow',
  pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  sticky INTEGER NOT NULL DEFAULT 0,
  x INTEGER, y INTEGER, w INTEGER, h INTEGER,
  always_on_top INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE alarms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('once','repeat','deadline','timer')),
  fire_at INTEGER NOT NULL,
  rrule TEXT,
  lead_days TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  snooze_until INTEGER,
  last_fired_at INTEGER,
  sound INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE snippets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE clipboard_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('text','image')),
  body TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE favorites (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  route TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (item_type, item_id)
);
CREATE TABLE focus_sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  minutes INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'focus'
);
`
  },
  {
    id: 5,
    name: 'launcher-utilities',
    sql: `
CREATE TABLE launcher_personal (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('app','path','url')),
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  detected INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, target)
);
CREATE TABLE recent_docs (
  path TEXT PRIMARY KEY,
  opened_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE security_results (
  id TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL,
  items TEXT NOT NULL
);
`
  },
  {
    id: 6,
    name: 'files-bookmarks-notes',
    sql: `
CREATE TABLE fm_pins (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE fs_roots (
  path TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scan_at INTEGER,
  file_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE fs_files (
  path TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  is_dir INTEGER NOT NULL DEFAULT 0,
  gen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_fs_files_root ON fs_files(root, gen);
CREATE INDEX idx_fs_files_ext ON fs_files(ext);
CREATE INDEX idx_fs_files_mtime ON fs_files(mtime);
CREATE INDEX idx_fs_files_dir ON fs_files(dir);
CREATE VIRTUAL TABLE fs_files_fts USING fts5(name, content='fs_files', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER fs_files_ai AFTER INSERT ON fs_files BEGIN
  INSERT INTO fs_files_fts(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TRIGGER fs_files_ad AFTER DELETE ON fs_files BEGIN
  INSERT INTO fs_files_fts(fs_files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
END;
CREATE TRIGGER fs_files_au AFTER UPDATE OF name ON fs_files BEGIN
  INSERT INTO fs_files_fts(fs_files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  INSERT INTO fs_files_fts(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TABLE tags (
  name TEXT PRIMARY KEY,
  color TEXT NOT NULL DEFAULT '#64748b'
);
CREATE TABLE file_tags (
  path TEXT NOT NULL,
  tag TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE ON UPDATE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (path, tag)
);
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (collection_id, path)
);
CREATE TABLE smart_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (url)
);
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page','database')),
  title TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  props TEXT NOT NULL DEFAULT '{}',
  row_values TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  is_template INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_notes_parent ON notes(parent_id, sort);
CREATE TABLE note_links (
  from_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX idx_note_links_to ON note_links(to_id);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body_text, content='notes', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
END;
CREATE TRIGGER notes_au AFTER UPDATE OF title, body_text ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_text) VALUES ('delete', old.rowid, old.title, old.body_text);
  INSERT INTO notes_fts(rowid, title, body_text) VALUES (new.rowid, new.title, new.body_text);
END;
`
  }
]
