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
  }
]
