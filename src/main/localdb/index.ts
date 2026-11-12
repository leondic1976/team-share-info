import { Db } from '../../node/sqlite'
import { LOCAL_MIGRATIONS } from './migrations'
import { KvRepo } from './kv'
import { PersonalEventsRepo } from './personal-events'
import { DiaryRepo } from './diary'
import { PersonalTasksRepo } from './personal-tasks'
import { AlarmsRepo, MemosRepo, ToolsRepo } from './tools'
import { LauncherRepo } from './launcher'
import { OrganizeRepo } from './organize'
import { NotesRepo } from './notes'

export interface LocalDb {
  db: Db
  kv: KvRepo
  events: PersonalEventsRepo
  diary: DiaryRepo
  tasks: PersonalTasksRepo
  memos: MemosRepo
  alarms: AlarmsRepo
  tools: ToolsRepo
  launcher: LauncherRepo
  organize: OrganizeRepo
  notes: NotesRepo
}

let current: LocalDb | null = null

export function openLocalDb(path: string): LocalDb {
  const db = new Db(path)
  db.migrate(LOCAL_MIGRATIONS)
  current = {
    db, kv: new KvRepo(db), events: new PersonalEventsRepo(db), diary: new DiaryRepo(db), tasks: new PersonalTasksRepo(db),
    memos: new MemosRepo(db),
    alarms: new AlarmsRepo(db),
    tools: new ToolsRepo(db),
    launcher: new LauncherRepo(db),
    organize: new OrganizeRepo(db),
    notes: new NotesRepo(db)
  }
  return current
}

export function localDb(): LocalDb {
  if (!current) throw new Error('local db not opened')
  return current
}

export function closeLocalDb(): void {
  current?.db.close()
  current = null
}
