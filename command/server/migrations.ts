import type { CmdMigration } from './sqlite'

/**
 * 긴급구조지휘대: the migrations of command.db (its own file next to the host's server DB, kept
 * by the server PC). Never edit an applied migration; append a new one.
 */
export const COMMAND_MIGRATIONS: CmdMigration[] = [
  {
    id: 1,
    name: 'command',
    sql: `
CREATE TABLE cmd_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- 지휘대담당 (3 at most), named by the server PC
CREATE TABLE cmd_managers (member_id TEXT PRIMARY KEY, assigned_by TEXT NOT NULL, assigned_at INTEGER NOT NULL);
-- 근무 유형: 긴급구조지휘대 / 긴급구조통제단 / 풍수해 비상상황근무 …
CREATE TABLE cmd_modes (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE cmd_teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#2563eb', sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- temporary people (not registered in the host); their person id is 'x:' || id
CREATE TABLE cmd_people (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', memo TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
-- one person, one 조
CREATE TABLE cmd_team_members (person_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES cmd_teams(id) ON DELETE CASCADE, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE cmd_roles (id TEXT PRIMARY KEY, mode_id TEXT NOT NULL REFERENCES cmd_modes(id) ON DELETE CASCADE, parent_id TEXT, name TEXT NOT NULL, duty_html TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_cmd_roles_mode ON cmd_roles(mode_id);
-- who does which role in which 조 (per mode, through the role)
CREATE TABLE cmd_assignments (role_id TEXT NOT NULL REFERENCES cmd_roles(id) ON DELETE CASCADE, team_id TEXT NOT NULL REFERENCES cmd_teams(id) ON DELETE CASCADE, person_id TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (role_id, team_id, person_id));
CREATE TABLE cmd_common (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', per_team INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
-- team_id '' : the same people whatever 조 is on
CREATE TABLE cmd_common_assign (common_id TEXT NOT NULL REFERENCES cmd_common(id) ON DELETE CASCADE, team_id TEXT NOT NULL DEFAULT '', person_id TEXT NOT NULL, PRIMARY KEY (common_id, team_id, person_id));
CREATE TABLE cmd_exceptions (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', from_date TEXT NOT NULL, to_date TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE cmd_overrides (id TEXT PRIMARY KEY, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL, team_id TEXT NOT NULL REFERENCES cmd_teams(id) ON DELETE CASCADE, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE cmd_notices (id TEXT PRIMARY KEY, title TEXT NOT NULL, body_html TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE cmd_notice_reads (notice_id TEXT NOT NULL REFERENCES cmd_notices(id) ON DELETE CASCADE, member_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY (notice_id, member_id));
CREATE TABLE cmd_materials (id TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', attachment_id TEXT, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE cmd_scenarios (id TEXT PRIMARY KEY, mode_id TEXT NOT NULL, title TEXT NOT NULL, summary_html TEXT NOT NULL DEFAULT '', target_html TEXT NOT NULL DEFAULT '', map TEXT NOT NULL DEFAULT '{}', messages TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL, created_by_name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE cmd_drills (id TEXT PRIMARY KEY, scenario_id TEXT, mode_id TEXT NOT NULL, title TEXT NOT NULL, summary_html TEXT NOT NULL DEFAULT '', target_html TEXT NOT NULL DEFAULT '', map TEXT NOT NULL DEFAULT '{}', team_ids TEXT NOT NULL DEFAULT '[]', with_common INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK (state IN ('scheduled','running','paused','ended')), start_at INTEGER, started_at INTEGER, paused_at INTEGER, paused_ms INTEGER NOT NULL DEFAULT 0, ended_at INTEGER, review_html TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
-- the participants, fixed when the drill starts (name and title kept for the record)
CREATE TABLE cmd_drill_members (drill_id TEXT NOT NULL REFERENCES cmd_drills(id) ON DELETE CASCADE, member_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', team_id TEXT, role_ids TEXT NOT NULL DEFAULT '[]', common INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (drill_id, member_id));
CREATE TABLE cmd_drill_msgs (id TEXT PRIMARY KEY, drill_id TEXT NOT NULL REFERENCES cmd_drills(id) ON DELETE CASCADE, sort INTEGER NOT NULL, body TEXT NOT NULL, targets TEXT NOT NULL DEFAULT '[]', sent_at INTEGER, skipped INTEGER NOT NULL DEFAULT 0, ad_hoc INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_cmd_drill_msgs ON cmd_drill_msgs(drill_id, sort);
CREATE TABLE cmd_drill_answers (id TEXT PRIMARY KEY, msg_id TEXT NOT NULL REFERENCES cmd_drill_msgs(id) ON DELETE CASCADE, member_id TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', choice_index INTEGER, answered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, late INTEGER NOT NULL DEFAULT 0, grade TEXT, comment TEXT NOT NULL DEFAULT '', graded_by TEXT, graded_by_name TEXT, graded_at INTEGER, UNIQUE (msg_id, member_id));
-- every version of every mark of a drill's map (a move closes one version and adds the next)
CREATE TABLE cmd_drill_marks (id TEXT PRIMARY KEY, drill_id TEXT NOT NULL REFERENCES cmd_drills(id) ON DELETE CASCADE, key TEXT NOT NULL, data TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, removed_at INTEGER);
CREATE INDEX idx_cmd_drill_marks ON cmd_drill_marks(drill_id);
CREATE TABLE cmd_drill_notes (id TEXT PRIMARY KEY, drill_id TEXT NOT NULL REFERENCES cmd_drills(id) ON DELETE CASCADE, at INTEGER NOT NULL, body TEXT NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL DEFAULT '');
`
  }
]
