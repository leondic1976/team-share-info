import type { Migration } from '../../node/sqlite'

/**
 * Server DB migrations (shared data). Never edit an applied migration.
 * Every shared item table carries scope_type ('team' | 'group' | 'members'); see scope.ts.
 */
export const SERVER_MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'base',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dept_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  title TEXT,
  ext TEXT,
  mobile TEXT,
  duty TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  status_message TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  pc_name TEXT NOT NULL,
  win_user TEXT NOT NULL,
  approved_ip TEXT NOT NULL,
  last_ip TEXT,
  app_version TEXT,
  approved_at INTEGER NOT NULL,
  approved_by TEXT,
  revoked_at INTEGER,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_devices_member ON devices(member_id);
CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  poll_token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  dept_name TEXT,
  title TEXT,
  ext TEXT,
  pc_name TEXT NOT NULL,
  win_user TEXT NOT NULL,
  ip TEXT NOT NULL,
  app_version TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
  decided_at INTEGER,
  decided_by TEXT,
  device_id TEXT,
  pending_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_join_state ON join_requests(state);
CREATE TABLE activity_logs (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  member_id TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT
);
CREATE INDEX idx_activity_at ON activity_logs(at);
CREATE TABLE app_releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  sha512 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mandatory INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'published' CHECK (state IN ('published','withdrawn')),
  published_at INTEGER NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_attach_owner ON attachments(owner_type, owner_id);
`
  },
  {
    id: 2,
    name: 'groups-scope-notices',
    sql: `
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#2563eb',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
  owner_id TEXT NOT NULL REFERENCES members(id),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived','dissolved')),
  quota_bytes INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  notify INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX idx_gm_member ON group_members(member_id);
CREATE TABLE group_invites (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invite','request')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','declined')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_gi_member ON group_invites(member_id, state);
CREATE TABLE scope_targets (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('group','member')),
  target_id TEXT NOT NULL,
  PRIMARY KEY (item_type, item_id, target_type, target_id)
);
CREATE INDEX idx_scope_target ON scope_targets(target_type, target_id);
CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('urgent','important','normal')),
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  require_ack INTEGER NOT NULL DEFAULT 0,
  reply_options TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  publish_at INTEGER NOT NULL,
  published_at INTEGER,
  expires_at INTEGER,
  renotify_minutes INTEGER,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_notices_pub ON notices(published_at);
CREATE TABLE notice_receipts (
  notice_id TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  delivered_at INTEGER,
  read_at INTEGER,
  acked_at INTEGER,
  reply TEXT,
  last_notified_at INTEGER,
  PRIMARY KEY (notice_id, member_id)
);
CREATE INDEX idx_receipts_member ON notice_receipts(member_id);
`
  },
  {
    id: 3,
    name: 'events-worklogs',
    sql: `
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('team','absence','busy')),
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  rrule TEXT,
  exdates TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  absence_type TEXT,
  reminders TEXT NOT NULL DEFAULT '[]',
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  series_id TEXT,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_events_range ON events(start_at, end_at);
CREATE INDEX idx_events_author ON events(created_by, kind);
CREATE TABLE event_attendees (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  response TEXT NOT NULL DEFAULT 'none' CHECK (response IN ('none','yes','no','maybe')),
  PRIMARY KEY (event_id, member_id)
);
CREATE TABLE holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'builtin'
);
CREATE TABLE worklogs (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  done_html TEXT NOT NULL DEFAULT '',
  todo_html TEXT NOT NULL DEFAULT '',
  notes_html TEXT NOT NULL DEFAULT '',
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (member_id, date)
);
CREATE INDEX idx_worklogs_date ON worklogs(date);
`
  },
  {
    id: 4,
    name: 'files',
    sql: `
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES folders(id),
  root_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  write_policy TEXT NOT NULL DEFAULT 'all' CHECK (write_policy IN ('all','owner')),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by TEXT
);
CREATE INDEX idx_folders_parent ON folders(parent_id);
CREATE INDEX idx_folders_root ON folders(root_id);
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  root_id TEXT NOT NULL,
  name TEXT NOT NULL,
  current_version_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  version_count INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_at INTEGER,
  created_by TEXT NOT NULL REFERENCES members(id),
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by TEXT
);
CREATE INDEX idx_files_folder ON files(folder_id);
CREATE INDEX idx_files_root ON files(root_id);
CREATE TABLE file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  blob_id TEXT NOT NULL REFERENCES blobs(id),
  size INTEGER NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_fv_file ON file_versions(file_id);
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  folder_id TEXT NOT NULL,
  file_id TEXT,
  note TEXT,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  temp_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','done','aborted')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE file_downloads (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  file_version_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_fd_file ON file_downloads(file_id);
`
  },
  {
    id: 5,
    name: 'messenger',
    sql: `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dm','room','group')),
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  dm_key TEXT UNIQUE,
  title TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_conv_group ON conversations(group_id) WHERE group_id IS NOT NULL;
CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  left_at INTEGER,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, member_id)
);
CREATE INDEX idx_cm_member ON conversation_members(member_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sender_id TEXT REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('text','file','image','system')),
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES members(id),
  to_id TEXT NOT NULL REFERENCES members(id),
  batch_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  deleted_by_sender INTEGER NOT NULL DEFAULT 0,
  deleted_by_receiver INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_notes_to ON notes(to_id, read_at);
CREATE INDEX idx_notes_from ON notes(from_id);
`
  },
  {
    id: 6,
    name: 'tasks-boards-contacts',
    sql: `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  assignee_id TEXT NOT NULL REFERENCES members(id),
  due_at INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','doing','done','confirmed')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER,
  confirmed_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, state);
CREATE INDEX idx_tasks_due ON tasks(due_at);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_comments_owner ON comments(owner_type, owner_id);
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'free' CHECK (kind IN ('free','work','qna')),
  description TEXT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id),
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_posts_board ON posts(board_id, created_at);
CREATE TABLE post_views (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, member_id)
);
CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  multiple INTEGER NOT NULL DEFAULT 0,
  anonymous INTEGER NOT NULL DEFAULT 0,
  closes_at INTEGER,
  closed_at INTEGER
);
CREATE TABLE poll_options (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, option_id, member_id)
);
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  title TEXT,
  phone TEXT,
  mobile TEXT,
  email TEXT,
  memo TEXT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_contacts_org ON contacts(org, name);
`
  },
  {
    id: 7,
    name: 'docs-annual',
    sql: `
CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('mustread','manual','handover','minutes','faq')),
  parent_id TEXT REFERENCES docs(id),
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  event_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  reviewed_at INTEGER,
  created_by TEXT NOT NULL REFERENCES members(id),
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_docs_kind ON docs(kind, updated_at);
CREATE TABLE doc_revisions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL,
  edited_by TEXT NOT NULL,
  edited_at INTEGER NOT NULL
);
CREATE INDEX idx_rev_doc ON doc_revisions(doc_id, edited_at);
CREATE TABLE doc_reads (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, member_id)
);
CREATE TABLE doc_templates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE annual_tasks (
  id TEXT PRIMARY KEY,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day INTEGER CHECK (day BETWEEN 1 AND 31),
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  remind_days_before INTEGER NOT NULL DEFAULT 7,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
`
  },
  {
    id: 8,
    name: 'shared-memos-sent-alarms',
    sql: `
CREATE TABLE shared_memos (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'yellow',
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  created_by TEXT NOT NULL REFERENCES members(id),
  checked_at INTEGER,
  checked_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE sent_alarms (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES members(id),
  to_id TEXT NOT NULL REFERENCES members(id),
  fire_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  delivered_at INTEGER,
  dismissed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sent_alarms_due ON sent_alarms(fire_at, delivered_at);
`
  },
  {
    id: 9,
    name: 'launcher-security-programs',
    sql: `
CREATE TABLE launcher_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('url','path','template')),
  name TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  blob_id TEXT,
  file_name TEXT,
  created_by TEXT REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE security_programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  process_names TEXT NOT NULL DEFAULT '[]',
  service_names TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
`
  },
  {
    id: 10,
    name: 'meetings',
    sql: `
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES members(id),
  conversation_id TEXT,
  event_id TEXT,
  mode TEXT NOT NULL DEFAULT 'video' CHECK (mode IN ('video','screen')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live','ended')),
  created_by TEXT NOT NULL REFERENCES members(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX idx_meetings_state ON meetings(state, started_at);
CREATE TABLE meeting_participants (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (meeting_id, member_id)
);
`
  },
  {
    id: 11,
    name: 'plugin-rooms',
    sql: `
CREATE TABLE plugin_rooms (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  title TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  shared TEXT NOT NULL DEFAULT '{}',
  closed INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_plugin_rooms ON plugin_rooms(plugin_id, updated_at);
CREATE TABLE plugin_entries (
  room_id TEXT NOT NULL REFERENCES plugin_rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  value TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (room_id, member_id)
);
`
  },
  {
    id: 12,
    name: 'task-assignees',
    // A task can have several assignees; tasks.assignee_id stays as the first one.
    sql: `
CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, member_id)
);
CREATE INDEX idx_task_assignees_member ON task_assignees(member_id);
INSERT INTO task_assignees (task_id, member_id, position) SELECT id, assignee_id, 0 FROM tasks;
`
  },
  {
    id: 13,
    name: 'ledgers',
    sql: `
CREATE TABLE ledgers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📄',
  doc TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  edit_mode TEXT NOT NULL DEFAULT 'all' CHECK (edit_mode IN ('all','owner')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team','group','members')),
  lock_by TEXT REFERENCES members(id),
  lock_at INTEGER,
  created_by TEXT NOT NULL REFERENCES members(id),
  updated_by TEXT REFERENCES members(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_ledgers_updated ON ledgers(deleted_at, updated_at);
`
  }
,
  {
    id: 14,
    name: 'ledger-rows-versions-task-done-each',
    sql: `
-- ledgers: one record per row instead of the sheet in one piece (large ledgers, several
-- people editing at once, change history, trash)
ALTER TABLE ledgers ADD COLUMN head TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ledgers ADD COLUMN head_rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ledgers ADD COLUMN head_seq INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ledgers ADD COLUMN feed_floor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ledgers ADD COLUMN snap_at INTEGER;
ALTER TABLE ledgers ADD COLUMN noted_at INTEGER;
ALTER TABLE ledgers ADD COLUMN deleted_by TEXT REFERENCES members(id);
CREATE TABLE ledger_rows (
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  pos REAL NOT NULL,
  cells TEXT NOT NULL DEFAULT '{}',
  seq INTEGER NOT NULL DEFAULT 1,
  gone INTEGER NOT NULL DEFAULT 0,
  gone_at INTEGER,
  PRIMARY KEY (ledger_id, id)
) WITHOUT ROWID;
CREATE INDEX idx_ledger_rows_pos ON ledger_rows(ledger_id, gone, pos);
CREATE INDEX idx_ledger_rows_seq ON ledger_rows(ledger_id, seq);
CREATE TABLE ledger_versions (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  doc BLOB NOT NULL,
  reason TEXT NOT NULL,
  by_id TEXT,
  by_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ledger_versions ON ledger_versions(ledger_id, created_at);
CREATE TABLE ledger_seen (
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, member_id)
) WITHOUT ROWID;
INSERT OR IGNORE INTO ledger_rows (ledger_id, id, pos, cells, seq)
  SELECT l.id, json_extract(j.value, '$.id'), (j.key + 1) * 1024.0, COALESCE(json_extract(j.value, '$.c'), '{}'), l.version
  FROM ledgers l, json_each(l.doc, '$.rows') j
  WHERE json_valid(l.doc) AND json_extract(j.value, '$.id') IS NOT NULL;
UPDATE ledgers SET head = json_remove(doc, '$.rows', '$.id'), head_seq = version WHERE json_valid(doc);
UPDATE ledgers SET doc = '', row_count = (SELECT COUNT(*) FROM ledger_rows r WHERE r.ledger_id = ledgers.id);
-- nobody is told about ledgers that exist already
INSERT INTO ledger_seen (ledger_id, member_id, version) SELECT l.id, m.id, l.version FROM ledgers l, members m;
-- tasks: each assignee may have to finish on their own
ALTER TABLE tasks ADD COLUMN done_mode TEXT NOT NULL DEFAULT 'any' CHECK (done_mode IN ('any','each'));
ALTER TABLE task_assignees ADD COLUMN done_at INTEGER;
`
  },
  {
    id: 15,
    name: 'storage-defaults-5gb-200gb',
    sql: `
-- servers still on the former defaults (500MB per file, 50GB in all) move to the new ones;
-- limits an admin set to anything else are kept
UPDATE settings SET value = json_set(value, '$.maxFileBytes', 5368709120)
  WHERE key = 'storage' AND json_valid(value) AND json_extract(value, '$.maxFileBytes') = 524288000;
UPDATE settings SET value = json_set(value, '$.quotaBytes', 214748364800)
  WHERE key = 'storage' AND json_valid(value) AND json_extract(value, '$.quotaBytes') = 53687091200;
`
  },
  {
    id: 16,
    name: 'pc-unique-value',
    sql: `
-- the unique value of the PC a device or a join request belongs to: a PC that asks again is
-- recognised and gets its account back instead of a second one
ALTER TABLE devices ADD COLUMN pc_uid TEXT;
ALTER TABLE join_requests ADD COLUMN pc_uid TEXT;
CREATE INDEX idx_devices_pc_uid ON devices(pc_uid);
CREATE INDEX idx_join_pc_uid ON join_requests(pc_uid);
-- PCs shut out for good: a request from one of them is refused until it is taken off this list
CREATE TABLE blocked_pcs (
  id TEXT PRIMARY KEY,
  pc_uid TEXT,
  pc_name TEXT NOT NULL,
  win_user TEXT NOT NULL,
  member_name TEXT,
  reason TEXT NOT NULL,
  blocked_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_blocked_pc_uid ON blocked_pcs(pc_uid);
-- member details: what an admin set wins over what the member typed (admin_fields lists those
-- fields); the nickname belongs to the member alone
ALTER TABLE members ADD COLUMN nickname TEXT;
ALTER TABLE members ADD COLUMN admin_fields TEXT NOT NULL DEFAULT '[]';
`
  },
  {
    id: 17,
    name: 'duty-board',
    sql: `
-- 근무현황: an absence (events.kind = 'absence') may be recorded for a member by an admin or
-- a 서무. created_by stays the member who is away; registered_by is who typed it in.
ALTER TABLE events ADD COLUMN registered_by TEXT;
CREATE INDEX idx_events_absence ON events(kind, start_at, end_at);
`
  }
]
