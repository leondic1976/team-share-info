/**
 * 긴급구조지휘대 HTTP API (/api/command/*). Reading is open to every member; changing the 편성,
 * notices, materials, scenarios and running drills is for the server PC and the 지휘대담당.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { CommandServerHost } from './host'
import type { CmdDb } from './sqlite'
import { openCommandDb } from './db'
import { cleanHtml } from './html'
import * as S from './store'
import { newId, parseJson } from './sqlite'
import * as V from '../shared/schemas'
import type { CmdMaterial, CmdNotice, CommandState, Mark, ScenarioMsg } from '../shared/types'
import { ABSENCE_HINT_DAYS, answerRefusal, applyMarkChanges, checkSubstitution, coveringIn, drillElapsedMs, mergeAbsences, periodText, rolePath, roleWithChildren, ymd } from '../shared/logic'
import type { CommandChangedPayload, CommandDrillPayload } from '../shared/events'

export const OWNER = { notice: 'cmd_notice', material: 'cmd_material', scenario: 'cmd_scenario', answer: 'cmd_answer' } as const

export interface CommandServer {
  db: CmdDb
  /** sends what is due in running drills and starts scheduled ones (call every few seconds) */
  runJobs(now?: number): void
  close(): void
}

export function registerCommandRoutes(app: FastifyInstance, host: CommandServerHost): CommandServer {
  const db = openCommandDb(host.dataDir)
  const auth = { preHandler: host.requireAuth }
  const ok = <T>(d: T): unknown => host.ok(d)
  const fail = (status: number, code: string, msg: string): Error => host.fail(status, code, msg)
  const notFound = (what: string): Error => fail(404, 'NOT_FOUND', `${what}을(를) 찾을 수 없습니다.`)
  const bad = (msg: string): Error => fail(400, 'BAD_REQUEST', msg)
  const parse = <T extends z.ZodType>(schema: T, v: unknown): z.infer<T> => {
    const r = schema.safeParse(v ?? {})
    if (!r.success) throw fail(400, 'VALIDATION', r.error.issues[0]?.message ?? '입력이 올바르지 않습니다.')
    return r.data
  }
  const param = (req: FastifyRequest, k: string): string => String((req.params as Record<string, string>)[k] ?? '')
  const who = (req: FastifyRequest): { id: string; name: string; isOwner: boolean; manager: boolean } => {
    const u = host.user(req)
    return { ...u, manager: u.isOwner || S.isManagerId(db, u.id) }
  }
  const manage = (req: FastifyRequest): ReturnType<typeof who> => {
    const u = who(req)
    if (!u.manager) throw fail(403, 'FORBIDDEN', '서버 PC와 지휘대담당만 할 수 있습니다.')
    return u
  }
  const changed = (what: CommandChangedPayload['what'], to: string[] | null = null): void => host.emit(to, 'command.changed', { what } satisfies CommandChangedPayload)
  const drillEvent = (drillId: string, p: Omit<CommandDrillPayload, 'drillId'>, to?: string[]): void => host.emit(to ?? S.drillAudience(db, drillId, host.ownerIds()), 'command.drill', { drillId, ...p } satisfies CommandDrillPayload)
  const managerIds = (): string[] => [...new Set([...host.ownerIds(), ...S.managers(db, host.members()).map((m) => m.memberId)])]
  /** the host's own list of people who are not members (optional); a failure to read it is an empty list */
  const guests = (): S.GuestList | null => {
    if (!host.guests) return null
    try {
      return { label: host.guests.label, where: host.guests.where, list: host.guests.list() }
    } catch (e) {
      host.report?.(`guests: ${(e as Error).message}`)
      return { label: host.guests.label, where: host.guests.where, list: [] }
    }
  }
  /** Everything `pid` had becomes the member's (when the member already has a 조, pid's 조 and 배치 are dropped). */
  const mergePlaces = (pid: string, memberId: string): void => {
    if (S.teamOf(db, memberId)) {
      for (const t of ['cmd_team_members', 'cmd_assignments']) db.run(`DELETE FROM ${t} WHERE person_id = ?`, [pid])
    } else {
      db.run('UPDATE cmd_team_members SET person_id = ? WHERE person_id = ?', [memberId, pid])
      db.run('UPDATE OR IGNORE cmd_assignments SET person_id = ? WHERE person_id = ?', [memberId, pid])
    }
    db.run('UPDATE OR IGNORE cmd_common_assign SET person_id = ? WHERE person_id = ?', [memberId, pid])
    db.run('UPDATE cmd_exceptions SET person_id = ? WHERE person_id = ?', [memberId, pid])
    S.renameInSubstitutions(db, pid, memberId)
    for (const t of ['cmd_assignments', 'cmd_common_assign']) db.run(`DELETE FROM ${t} WHERE person_id = ?`, [pid])
  }
  /**
   * Follows the host's list: somebody merged there into a member (구성원과 합치기) has their
   * places here moved to that member. Returns whether anything moved.
   */
  const follow = (g: S.GuestList | null): boolean => {
    if (!g?.list.length) return false
    const active = new Set(host.members().map((m) => m.id))
    const merged = new Map(g.list.filter((x) => !x.gone && x.as && active.has(x.as)).map((x) => [S.GUEST + x.id, x.as!]))
    const todo = S.usedGuestIds(db).filter((id) => merged.has(id))
    if (!todo.length) return false
    db.tx(() => todo.forEach((id) => mergePlaces(id, merged.get(id)!)))
    return true
  }
  /**
   * The module's own 임시 인원 of before (cmd_people) move to the host's list once: each is put
   * there (the same key gives the same person, so doing it again registers nobody twice) and
   * their places (조, 배치, 공통업무, 예외) follow. Returns how many moved.
   */
  let moveError = ''
  const moveOldTemps = (): number => {
    const add = host.guests?.add
    if (!add) return 0
    const temps = db.all<{ id: string; name: string; title: string; memo: string }>('SELECT id, name, title, memo FROM cmd_people ORDER BY created_at')
    let moved = 0
    for (const t of temps) {
      const r = add({ name: t.name, title: t.title, dept: '', memo: t.memo }, { key: t.id })
      if ('error' in r) {
        if (r.error !== moveError) host.report?.(`move 임시 인원: ${r.error}`)
        moveError = r.error
        break
      }
      const from = S.TEMP + t.id
      const to = S.GUEST + r.id
      db.tx(() => {
        for (const tb of S.PERSON_TABLES) db.run(`UPDATE OR IGNORE ${tb} SET person_id = ? WHERE person_id = ?`, [to, from])
        for (const tb of S.PERSON_TABLES) db.run(`DELETE FROM ${tb} WHERE person_id = ?`, [from])
        S.renameInSubstitutions(db, from, to)
        db.run('DELETE FROM cmd_people WHERE id = ?', [t.id])
      })
      moved++
    }
    return moved
  }
  /** at start and whenever the host's list changes: move, follow; whether places changed */
  let syncing = false
  const sync = (): boolean => {
    // putting people on the host's list makes it tell us again
    if (syncing) return false
    syncing = true
    try {
      const moved = moveOldTemps()
      return follow(guests()) || moved > 0
    } catch (e) {
      host.report?.(`guests sync: ${(e as Error).message}`)
      return false
    } finally {
      syncing = false
    }
  }
  if (host.guests) {
    sync()
    host.guests.onChange?.(() => {
      sync()
      // names and the list shown in the pickers change too
      changed('setup')
    })
  }

  // every file of the module may be read by any member (the module is open to the whole team)
  for (const t of Object.values(OWNER)) host.attachments.registerOwner(t, () => true)

  // a server PC that was off did not send the messages that fell due meanwhile: hold the drills
  // that were running, so those in charge decide what to do (not a burst of old messages)
  db.run("UPDATE cmd_drills SET state = 'paused', paused_at = ? WHERE state = 'running'", [Date.now()])

  // ---------- everything at once ----------
  app.get('/api/command', auth, async (req) => {
    const u = who(req)
    const members = host.members()
    // a merge in the host's list whose news was missed is followed here too
    if (host.guests && sync()) changed('setup')
    const g = guests()
    const state: CommandState = {
      guests: g ? { label: g.label, where: g.where } : null,
      modes: S.modes(db),
      teams: S.teams(db),
      roles: S.roles(db),
      assignments: S.assignments(db),
      common: S.common(db),
      exceptions: S.exceptions(db),
      substitutions: S.substitutions(db),
      overrides: S.overrides(db),
      rotation: S.rotation(db),
      people: S.people(db, members, g),
      managers: S.managers(db, members),
      me: { id: u.id, isManager: u.manager, isOwner: u.isOwner },
      unreadNotices: S.unreadNotices(db, u.id),
      drills: S.drillBriefs(db, u.id),
      serverNow: Date.now()
    }
    // the hint "away then (today through the next days) — name a substitute" is for those in charge
    if (u.manager && host.absencesAhead) {
      try {
        const today = ymd(Date.now())
        const day = /^\d{4}-\d{2}-\d{2}$/
        const list = host
          .absencesAhead(ABSENCE_HINT_DAYS)
          .filter((x) => day.test(x.fromDate) && day.test(x.toDate))
          .map((x) => ({ personId: x.memberId, type: x.type, fromDate: x.fromDate < today ? today : x.fromDate, toDate: x.toDate }))
          .filter((x) => x.toDate >= x.fromDate)
        state.hostAbsences = mergeAbsences(list)
      } catch (e) {
        host.report?.(`absences: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return ok(state)
  })

  app.get('/api/command/roles/:id', auth, async (req) => {
    const r = db.get<{ id: string; name: string; duty_html: string }>('SELECT id, name, duty_html FROM cmd_roles WHERE id = ?', [param(req, 'id')])
    if (!r) throw notFound('분류')
    return ok({ id: r.id, name: r.name, dutyHtml: r.duty_html, path: rolePath(S.roles(db), r.id) })
  })

  // ---------- 지휘대담당 (the server PC only) ----------
  app.put('/api/command/managers', auth, async (req) => {
    const u = who(req)
    if (!u.isOwner) throw fail(403, 'OWNER_ONLY', '지휘대담당은 서버 PC에서만 정할 수 있습니다.')
    const { memberIds } = parse(V.managersSchema, req.body)
    const members = new Set(host.members().map((m) => m.id))
    const list = [...new Set(memberIds)].filter((id) => members.has(id))
    db.tx(() => {
      db.run('DELETE FROM cmd_managers')
      for (const id of list) db.run('INSERT INTO cmd_managers (member_id, assigned_by, assigned_at) VALUES (?, ?, ?)', [id, u.id, Date.now()])
    })
    host.log?.(req, 'command.managers', { memberIds: list })
    changed('setup')
    return ok({ memberIds: list })
  })

  // ---------- 근무 유형 ----------
  app.post('/api/command/modes', auth, async (req) => {
    manage(req)
    const b = parse(V.modeSchema, req.body)
    const id = newId()
    const t = Date.now()
    const sort = (db.get<{ s: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM cmd_modes')?.s ?? 0)
    db.run('INSERT INTO cmd_modes (id, name, sort, hidden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, b.name, sort, b.hidden ? 1 : 0, t, t])
    changed('setup')
    return ok({ id })
  })
  app.patch('/api/command/modes/:id', auth, async (req) => {
    manage(req)
    const b = parse(V.modePatchSchema, req.body)
    const r = db.run('UPDATE cmd_modes SET name = COALESCE(?, name), hidden = COALESCE(?, hidden), updated_at = ? WHERE id = ?', [b.name ?? null, b.hidden === undefined ? null : b.hidden ? 1 : 0, Date.now(), param(req, 'id')])
    if (!r.changes) throw notFound('근무 유형')
    changed('setup')
    return ok({ id: param(req, 'id') })
  })
  app.delete('/api/command/modes/:id', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    if (db.get('SELECT 1 FROM cmd_scenarios WHERE mode_id = ? AND deleted_at IS NULL', [id]) || db.get('SELECT 1 FROM cmd_drills WHERE mode_id = ?', [id])) throw bad('시나리오나 훈련 기록이 있는 근무 유형은 지울 수 없습니다. 숨기기를 쓰세요.')
    if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cmd_modes')!.n <= 1) throw bad('근무 유형은 하나 이상 있어야 합니다.')
    db.run('DELETE FROM cmd_modes WHERE id = ?', [id])
    changed('setup')
    return ok({ id })
  })
  app.put('/api/command/modes/order', auth, async (req) => {
    manage(req)
    const { ids } = parse(V.orderSchema, req.body)
    db.tx(() => ids.forEach((id, i) => db.run('UPDATE cmd_modes SET sort = ? WHERE id = ?', [i, id])))
    changed('setup')
    return ok({ ids })
  })

  // ---------- 조 ----------
  app.post('/api/command/teams', auth, async (req) => {
    manage(req)
    const b = parse(V.teamSchema, req.body)
    const id = newId()
    const t = Date.now()
    const sort = db.get<{ s: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM cmd_teams')?.s ?? 0
    db.run('INSERT INTO cmd_teams (id, name, color, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, b.name, b.color, sort, t, t])
    changed('setup')
    return ok({ id })
  })
  app.patch('/api/command/teams/:id', auth, async (req) => {
    manage(req)
    const b = parse(V.teamPatchSchema, req.body)
    const r = db.run('UPDATE cmd_teams SET name = COALESCE(?, name), color = COALESCE(?, color), updated_at = ? WHERE id = ?', [b.name ?? null, b.color ?? null, Date.now(), param(req, 'id')])
    if (!r.changes) throw notFound('조')
    changed('setup')
    return ok({ id: param(req, 'id') })
  })
  app.delete('/api/command/teams/:id', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    if (db.get('SELECT 1 FROM cmd_team_members WHERE team_id = ?', [id])) throw bad('조원이 있는 조는 지울 수 없습니다. 조원을 먼저 빼세요.')
    db.tx(() => {
      db.run('DELETE FROM cmd_teams WHERE id = ?', [id])
      const r = S.rotation(db)
      if (r) db.run('UPDATE cmd_settings SET value = ? WHERE key = ?', [JSON.stringify({ ...r, order: r.order.filter((x) => x !== id) }), 'rotation'])
    })
    changed('setup')
    return ok({ id })
  })
  app.put('/api/command/teams/order', auth, async (req) => {
    manage(req)
    const { ids } = parse(V.orderSchema, req.body)
    db.tx(() => ids.forEach((id, i) => db.run('UPDATE cmd_teams SET sort = ? WHERE id = ?', [i, id])))
    changed('setup')
    return ok({ ids })
  })
  /** The members of a 조, in order. Somebody in another 조 is moved here (their roles there go). */
  app.put('/api/command/teams/:id/members', auth, async (req) => {
    manage(req)
    const teamId = param(req, 'id')
    if (!db.get('SELECT 1 FROM cmd_teams WHERE id = ?', [teamId])) throw notFound('조')
    const { personIds } = parse(V.teamMembersSchema, req.body)
    const members = host.members()
    const list = [...new Set(personIds)]
    const excepted = new Set(S.exceptions(db).filter((e) => e.fromDate <= ymd(Date.now()) && (!e.toDate || e.toDate >= ymd(Date.now()))).map((e) => e.personId))
    const g = guests()
    const names = new Map(S.people(db, members, g).map((p) => [p.id, p.name]))
    const before = db.all<{ person_id: string }>('SELECT person_id FROM cmd_team_members WHERE team_id = ?', [teamId]).map((r) => r.person_id)
    for (const p of list) {
      // somebody already in this 조 may stay (e.g. one who left the host's list and is not taken out yet)
      if (!S.personExists(db, members, p, g) && !before.includes(p)) throw bad('없는 사람이 들어 있습니다.')
      if (excepted.has(p)) throw bad(`${names.get(p)}은(는) 예외자입니다. 예외를 먼저 끝내세요.`)
    }
    db.tx(() => {
      for (const p of before.filter((x) => !list.includes(x))) {
        db.run('DELETE FROM cmd_team_members WHERE person_id = ?', [p])
        db.run('DELETE FROM cmd_assignments WHERE team_id = ? AND person_id = ?', [teamId, p])
        db.run('DELETE FROM cmd_common_assign WHERE team_id = ? AND person_id = ?', [teamId, p])
      }
      list.forEach((p, i) => {
        const cur = S.teamOf(db, p)
        if (cur && cur !== teamId) {
          db.run('DELETE FROM cmd_assignments WHERE team_id = ? AND person_id = ?', [cur, p])
          db.run('DELETE FROM cmd_common_assign WHERE team_id = ? AND person_id = ?', [cur, p])
        }
        db.run('INSERT INTO cmd_team_members (person_id, team_id, sort) VALUES (?, ?, ?) ON CONFLICT (person_id) DO UPDATE SET team_id = excluded.team_id, sort = excluded.sort', [p, teamId, i])
      })
    })
    changed('setup')
    return ok({ personIds: list })
  })

  // ---------- 순환 ----------
  app.put('/api/command/rotation', auth, async (req) => {
    manage(req)
    const b = parse(V.rotationSchema, req.body)
    const known = new Set(S.teams(db).map((t) => t.id))
    const order = [...new Set(b.order)].filter((id) => known.has(id))
    if (!order.length) throw bad('순환할 조를 하나 이상 고르세요.')
    db.run('INSERT INTO cmd_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', ['rotation', JSON.stringify({ ...b, order })])
    changed('setup')
    return ok({ ...b, order })
  })
  app.post('/api/command/overrides', auth, async (req) => {
    manage(req)
    const b = parse(V.overrideSchema, req.body)
    if (!db.get('SELECT 1 FROM cmd_teams WHERE id = ?', [b.teamId])) throw notFound('조')
    const id = newId()
    db.run('INSERT INTO cmd_overrides (id, from_at, to_at, team_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, b.fromAt, b.toAt, b.teamId, b.note, Date.now()])
    changed('setup')
    return ok({ id })
  })
  app.delete('/api/command/overrides/:id', auth, async (req) => {
    manage(req)
    db.run('DELETE FROM cmd_overrides WHERE id = ?', [param(req, 'id')])
    changed('setup')
    return ok({ id: param(req, 'id') })
  })

  // ---------- 분류와 임무 ----------
  app.post('/api/command/roles', auth, async (req) => {
    manage(req)
    const b = parse(V.roleSchema, req.body)
    if (!db.get('SELECT 1 FROM cmd_modes WHERE id = ?', [b.modeId])) throw notFound('근무 유형')
    if (b.parentId && !db.get('SELECT 1 FROM cmd_roles WHERE id = ? AND mode_id = ?', [b.parentId, b.modeId])) throw notFound('상위 분류')
    const id = newId()
    const t = Date.now()
    const sort = db.get<{ s: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM cmd_roles WHERE mode_id = ? AND parent_id IS ?', [b.modeId, b.parentId])?.s ?? 0
    db.run('INSERT INTO cmd_roles (id, mode_id, parent_id, name, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, b.modeId, b.parentId, b.name, sort, t, t])
    changed('setup')
    return ok({ id })
  })
  app.patch('/api/command/roles/:id', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    const b = parse(V.rolePatchSchema, req.body)
    const cur = db.get<{ mode_id: string }>('SELECT mode_id FROM cmd_roles WHERE id = ?', [id])
    if (!cur) throw notFound('분류')
    if (b.parentId !== undefined && b.parentId !== null) {
      if (roleWithChildren(S.roles(db), id).has(b.parentId)) throw bad('자기 아래 분류로는 옮길 수 없습니다.')
      if (!db.get('SELECT 1 FROM cmd_roles WHERE id = ? AND mode_id = ?', [b.parentId, cur.mode_id])) throw notFound('상위 분류')
    }
    db.run('UPDATE cmd_roles SET name = COALESCE(?, name), duty_html = COALESCE(?, duty_html), updated_at = ? WHERE id = ?', [b.name ?? null, b.dutyHtml === undefined ? null : cleanHtml(b.dutyHtml), Date.now(), id])
    if (b.parentId !== undefined) db.run('UPDATE cmd_roles SET parent_id = ? WHERE id = ?', [b.parentId, id])
    changed('setup')
    return ok({ id })
  })
  app.put('/api/command/roles/order', auth, async (req) => {
    manage(req)
    const { ids } = parse(V.orderSchema, req.body)
    db.tx(() => ids.forEach((id, i) => db.run('UPDATE cmd_roles SET sort = ? WHERE id = ?', [i, id])))
    changed('setup')
    return ok({ ids })
  })
  /** A role and everything under it (and who was placed there). */
  app.delete('/api/command/roles/:id', auth, async (req) => {
    manage(req)
    const all = roleWithChildren(S.roles(db), param(req, 'id'))
    db.tx(() => {
      for (const id of all) db.run('DELETE FROM cmd_roles WHERE id = ?', [id])
    })
    changed('setup')
    return ok({ removed: all.size })
  })

  // ---------- 배치 ----------
  app.put('/api/command/assignments', auth, async (req) => {
    manage(req)
    const b = parse(V.assignSchema, req.body)
    const role = db.get<{ mode_id: string }>('SELECT mode_id FROM cmd_roles WHERE id = ?', [b.roleId])
    if (!role || role.mode_id !== b.modeId) throw notFound('분류')
    const list = [...new Set(b.personIds)]
    const names = new Map(S.people(db, host.members(), guests()).map((p) => [p.id, p.name]))
    const modeRoles = S.roles(db).filter((r) => r.modeId === b.modeId).map((r) => r.id)
    for (const p of list) {
      if (S.teamOf(db, p) !== b.teamId) throw bad(`${names.get(p) ?? '그 사람'}은(는) 이 조의 조원이 아닙니다.`)
      const other = db.get<{ role_id: string }>(`SELECT role_id FROM cmd_assignments WHERE team_id = ? AND person_id = ? AND role_id != ? AND role_id IN (${modeRoles.map(() => '?').join(',') || "''"})`, [b.teamId, p, b.roleId, ...modeRoles])
      if (other) throw bad(`${names.get(p)}은(는) 이미 "${rolePath(S.roles(db), other.role_id)}"에 배치되어 있습니다. 한 조에서는 한 분류만 맡습니다.`)
    }
    db.tx(() => {
      db.run('DELETE FROM cmd_assignments WHERE role_id = ? AND team_id = ?', [b.roleId, b.teamId])
      list.forEach((p, i) => db.run('INSERT INTO cmd_assignments (role_id, team_id, person_id, sort) VALUES (?, ?, ?, ?)', [b.roleId, b.teamId, p, i]))
    })
    changed('setup')
    return ok({ personIds: list })
  })
  /** Copies who does what from one 근무 유형 to another, by the same role path. */
  app.post('/api/command/assignments/copy', auth, async (req) => {
    manage(req)
    const b = parse(V.copyAssignSchema, req.body)
    if (b.fromModeId === b.toModeId) throw bad('같은 근무 유형입니다.')
    const all = S.roles(db)
    const toByPath = new Map(all.filter((r) => r.modeId === b.toModeId).map((r) => [rolePath(all, r.id), r.id]))
    const fromRoles = new Set(all.filter((r) => r.modeId === b.fromModeId).map((r) => r.id))
    const toRoles = new Set(toByPath.values())
    let copied = 0
    db.tx(() => {
      for (const a of S.assignments(db).filter((x) => fromRoles.has(x.roleId))) {
        const target = toByPath.get(rolePath(all, a.roleId))
        if (!target) continue
        const taken = db.all<{ role_id: string }>('SELECT role_id FROM cmd_assignments WHERE team_id = ? AND person_id = ?', [a.teamId, a.personId]).some((r) => toRoles.has(r.role_id))
        if (taken) continue
        db.run('INSERT OR IGNORE INTO cmd_assignments (role_id, team_id, person_id) VALUES (?, ?, ?)', [target, a.teamId, a.personId])
        copied++
      }
    })
    changed('setup')
    return ok({ copied })
  })

  // ---------- 공통업무 ----------
  app.post('/api/command/common', auth, async (req) => {
    manage(req)
    const b = parse(V.commonSchema, req.body)
    const id = newId()
    const sort = db.get<{ s: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM cmd_common')?.s ?? 0
    db.run('INSERT INTO cmd_common (id, name, description, per_team, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, b.name, b.description, b.perTeam ? 1 : 0, sort, Date.now()])
    changed('setup')
    return ok({ id })
  })
  app.patch('/api/command/common/:id', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    const b = parse(V.commonPatchSchema, req.body)
    const cur = db.get<{ per_team: number }>('SELECT per_team FROM cmd_common WHERE id = ?', [id])
    if (!cur) throw notFound('공통업무')
    db.tx(() => {
      db.run('UPDATE cmd_common SET name = COALESCE(?, name), description = COALESCE(?, description), per_team = COALESCE(?, per_team) WHERE id = ?', [b.name ?? null, b.description ?? null, b.perTeam === undefined ? null : b.perTeam ? 1 : 0, id])
      // the way of choosing changed: who was chosen the other way does not fit any more
      if (b.perTeam !== undefined && !!cur.per_team !== b.perTeam) db.run('DELETE FROM cmd_common_assign WHERE common_id = ?', [id])
    })
    changed('setup')
    return ok({ id })
  })
  app.delete('/api/command/common/:id', auth, async (req) => {
    manage(req)
    db.run('DELETE FROM cmd_common WHERE id = ?', [param(req, 'id')])
    changed('setup')
    return ok({ id: param(req, 'id') })
  })
  app.put('/api/command/common/:id/assign', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    const c = db.get<{ per_team: number }>('SELECT per_team FROM cmd_common WHERE id = ?', [id])
    if (!c) throw notFound('공통업무')
    const b = parse(V.commonAssignSchema, req.body)
    const teamId = c.per_team ? b.teamId : ''
    if (c.per_team && !db.get('SELECT 1 FROM cmd_teams WHERE id = ?', [teamId])) throw bad('조를 고르세요.')
    const members = host.members()
    const g = guests()
    const names = new Map(S.people(db, members, g).map((p) => [p.id, p.name]))
    const before = new Set(db.all<{ person_id: string }>('SELECT person_id FROM cmd_common_assign WHERE common_id = ? AND team_id = ?', [id, teamId]).map((r) => r.person_id))
    for (const p of b.personIds) {
      if (!S.personExists(db, members, p, g) && !before.has(p)) throw bad('없는 사람이 들어 있습니다.')
      if (c.per_team && S.teamOf(db, p) !== teamId) throw bad(`${names.get(p)}은(는) 이 조의 조원이 아닙니다.`)
    }
    db.tx(() => {
      db.run('DELETE FROM cmd_common_assign WHERE common_id = ? AND team_id = ?', [id, teamId])
      for (const p of new Set(b.personIds)) db.run('INSERT INTO cmd_common_assign (common_id, team_id, person_id) VALUES (?, ?, ?)', [id, teamId, p])
    })
    changed('setup')
    return ok({ id })
  })

  // ---------- 예외자 ----------
  app.post('/api/command/exceptions', auth, async (req) => {
    const u = manage(req)
    const b = parse(V.exceptionSchema, req.body)
    if (!S.personExists(db, host.members(), b.personId, guests())) throw notFound('사람')
    refuseCovering(b.personId, b.fromDate, b.toDate)
    const id = newId()
    db.tx(() => {
      db.run('INSERT INTO cmd_exceptions (id, person_id, reason, from_date, to_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, b.personId, b.reason, b.fromDate, b.toDate, u.id, Date.now()])
      // somebody on exception is in no 조 (when the exception is in force now)
      const today = ymd(Date.now())
      if (b.fromDate <= today && (!b.toDate || b.toDate >= today)) {
        db.run('DELETE FROM cmd_assignments WHERE person_id = ?', [b.personId])
        db.run("DELETE FROM cmd_common_assign WHERE person_id = ? AND team_id != ''", [b.personId])
        db.run('DELETE FROM cmd_team_members WHERE person_id = ?', [b.personId])
      }
    })
    changed('setup')
    return ok({ id })
  })
  app.patch('/api/command/exceptions/:id', auth, async (req) => {
    manage(req)
    const b = parse(V.exceptionSchema, req.body)
    refuseCovering(b.personId, b.fromDate, b.toDate)
    const r = db.run('UPDATE cmd_exceptions SET person_id = ?, reason = ?, from_date = ?, to_date = ? WHERE id = ?', [b.personId, b.reason, b.fromDate, b.toDate, param(req, 'id')])
    if (!r.changes) throw notFound('예외')
    changed('setup')
    return ok({ id: param(req, 'id') })
  })
  app.delete('/api/command/exceptions/:id', auth, async (req) => {
    manage(req)
    db.run('DELETE FROM cmd_exceptions WHERE id = ?', [param(req, 'id')])
    changed('setup')
    return ok({ id: param(req, 'id') })
  })

  // ---------- 대리자 ----------
  const personName = (id: string): string => S.people(db, host.members(), guests()).find((p) => p.id === id)?.name ?? '(알 수 없음)'
  /** A substitute cannot be on exception while covering (예외자 = out without replacement). */
  function refuseCovering(personId: string, fromDate: string, toDate: string | null): void {
    const x = coveringIn(S.substitutions(db), personId, fromDate, toDate)
    if (x) throw bad(`${personName(personId)}은(는) ${periodText(x.fromDate, x.toDate)}에 ${personName(x.personId)}의 대리자입니다. 대리를 먼저 고치거나 지우세요.`)
  }
  /** The rules (checkSubstitution); returns the warnings of an allowed one. `keep`: the people the record has now (may stay though they left the host's list). */
  const checkSub = (b: z.infer<typeof V.substitutionSchema>, id?: string, keep: string[] = []): string[] => {
    const members = host.members()
    const g = guests()
    if (!S.personExists(db, members, b.personId, g) && !keep.includes(b.personId)) throw notFound('부재자')
    if (!S.personExists(db, members, b.substituteId, g) && !keep.includes(b.substituteId)) throw notFound('대리자')
    const r = checkSubstitution({ ...b, id }, { substitutions: S.substitutions(db), exceptions: S.exceptions(db), teams: S.teams(db), assignments: S.assignments(db), common: S.common(db), roles: S.roles(db), people: S.people(db, members, g) })
    if (r.error) throw bad(r.error)
    return r.warnings
  }
  app.post('/api/command/substitutions', auth, async (req) => {
    const u = manage(req)
    const b = parse(V.substitutionSchema, req.body)
    const warnings = checkSub(b)
    const id = newId()
    const t = Date.now()
    db.run('INSERT INTO cmd_substitutions (id, person_id, substitute_id, reason, from_date, to_date, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, b.personId, b.substituteId, b.reason, b.fromDate, b.toDate, u.id, t, t])
    host.log?.(req, 'command.substitution', { id, personId: b.personId, substituteId: b.substituteId, fromDate: b.fromDate, toDate: b.toDate })
    changed('setup')
    return ok({ id, warnings })
  })
  app.patch('/api/command/substitutions/:id', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    const cur = db.get<{ person_id: string; substitute_id: string }>('SELECT person_id, substitute_id FROM cmd_substitutions WHERE id = ?', [id])
    if (!cur) throw notFound('대리')
    const b = parse(V.substitutionSchema, req.body)
    const warnings = checkSub(b, id, [cur.person_id, cur.substitute_id])
    db.run('UPDATE cmd_substitutions SET person_id = ?, substitute_id = ?, reason = ?, from_date = ?, to_date = ?, updated_at = ? WHERE id = ?', [b.personId, b.substituteId, b.reason, b.fromDate, b.toDate, Date.now(), id])
    changed('setup')
    return ok({ id, warnings })
  })
  app.delete('/api/command/substitutions/:id', auth, async (req) => {
    manage(req)
    db.run('DELETE FROM cmd_substitutions WHERE id = ?', [param(req, 'id')])
    changed('setup')
    return ok({ id: param(req, 'id') })
  })

  // ---------- 미등록 인원 (the host's list: placed here, edited there) ----------
  // The module keeps no list of its own any more: its 임시 인원 of before moved to the host's list
  // (moveOldTemps). Here they are only taken out of every place, or - 임시 인원 of before, when
  // the host has no list - merged into a member.
  /** the person of a ':id' route: of the host's list ('g:…', raw null) or a 임시 인원 of before ('x:…', raw = cmd_people id) */
  const personParam = (req: FastifyRequest): { pid: string; raw: string | null } => {
    const id = param(req, 'id')
    if (S.isGuest(id)) return { pid: id, raw: null }
    const raw = id.replace(S.TEMP, '')
    return { pid: S.TEMP + raw, raw }
  }
  /** 편성에서 빼기: out of every 조, 배치, 공통업무, 예외 and 대리 (a 임시 인원 of before is removed too). The host's list is not changed. */
  app.delete('/api/command/people/:id', auth, async (req) => {
    manage(req)
    const { pid, raw } = personParam(req)
    db.tx(() => {
      for (const t of S.PERSON_TABLES) db.run(`DELETE FROM ${t} WHERE person_id = ?`, [pid])
      db.run('DELETE FROM cmd_substitutions WHERE person_id = ? OR substitute_id = ?', [pid, pid])
      if (raw !== null) db.run('DELETE FROM cmd_people WHERE id = ?', [raw])
    })
    changed('setup')
    return ok({ id: pid })
  })
  /** A 임시 인원 of before is this member: everything they had becomes the member's. (People of the host's list are merged there.) */
  app.post('/api/command/people/:id/merge', auth, async (req) => {
    manage(req)
    const { pid, raw } = personParam(req)
    const g = guests()
    if (raw === null) throw bad(`${g?.label ?? '미등록 인원'}은(는) ${g?.where ?? '등록한 곳'}에서 구성원과 합칩니다.`)
    const { memberId } = parse(V.mergeSchema, req.body)
    if (!db.get('SELECT 1 FROM cmd_people WHERE id = ?', [raw])) throw notFound('임시 인원')
    if (!host.members().some((m) => m.id === memberId)) throw notFound('구성원')
    db.tx(() => {
      mergePlaces(pid, memberId)
      db.run('DELETE FROM cmd_people WHERE id = ?', [raw])
    })
    changed('setup')
    return ok({ memberId })
  })

  // ---------- 공지 ----------
  const noticeDto = (r: { id: string; title: string; body_html: string; pinned: number; created_by: string; created_by_name: string; created_at: number; updated_at: number }, memberId: string): CmdNotice => ({
    id: r.id,
    title: r.title,
    bodyHtml: r.body_html,
    pinned: !!r.pinned,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    attachments: host.attachments.list(OWNER.notice, r.id),
    read: r.created_by === memberId || !!db.get('SELECT 1 FROM cmd_notice_reads WHERE notice_id = ? AND member_id = ?', [r.id, memberId])
  })
  app.get('/api/command/notices', auth, async (req) => {
    const u = who(req)
    return ok(db.all<Parameters<typeof noticeDto>[0]>('SELECT * FROM cmd_notices WHERE deleted_at IS NULL ORDER BY pinned DESC, created_at DESC LIMIT 300').map((r) => noticeDto(r, u.id)))
  })
  app.post('/api/command/notices', auth, async (req) => {
    const u = manage(req)
    const b = parse(V.noticeSchema, req.body)
    const id = newId()
    const t = Date.now()
    db.run('INSERT INTO cmd_notices (id, title, body_html, pinned, created_by, created_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, b.title, cleanHtml(b.bodyHtml), b.pinned ? 1 : 0, u.id, u.name, t, t])
    host.attachments.link(b.attachmentIds, OWNER.notice, id, u.id)
    host.log?.(req, 'command.notice', { id, title: b.title })
    host.emit(null, 'command.changed', { what: 'notice', id, title: b.title, by: u.name, byId: u.id })
    return ok({ id })
  })
  app.patch('/api/command/notices/:id', auth, async (req) => {
    const u = manage(req)
    const id = param(req, 'id')
    const b = parse(V.noticeSchema, req.body)
    const r = db.run('UPDATE cmd_notices SET title = ?, body_html = ?, pinned = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [b.title, cleanHtml(b.bodyHtml), b.pinned ? 1 : 0, Date.now(), id])
    if (!r.changes) throw notFound('공지')
    host.attachments.link(b.attachmentIds, OWNER.notice, id, u.id)
    changed('notice')
    return ok({ id })
  })
  app.delete('/api/command/notices/:id', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    db.run('UPDATE cmd_notices SET deleted_at = ? WHERE id = ?', [Date.now(), id])
    host.attachments.remove(OWNER.notice, id)
    changed('notice')
    return ok({ id })
  })
  app.post('/api/command/notices/:id/read', auth, async (req) => {
    const u = who(req)
    db.run('INSERT OR IGNORE INTO cmd_notice_reads (notice_id, member_id, read_at) VALUES (?, ?, ?)', [param(req, 'id'), u.id, Date.now()])
    return ok({ id: param(req, 'id') })
  })

  // ---------- 자료 ----------
  const materialDto = (r: { id: string; category: string; title: string; description: string; attachment_id: string | null; created_by: string; created_by_name: string; created_at: number }): CmdMaterial => ({
    id: r.id,
    category: r.category,
    title: r.title,
    description: r.description,
    file: host.attachments.list(OWNER.material, r.id)[0] ?? null,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at
  })
  app.get('/api/command/materials', auth, async () => ok(db.all<Parameters<typeof materialDto>[0]>('SELECT * FROM cmd_materials WHERE deleted_at IS NULL ORDER BY category, created_at DESC').map(materialDto)))
  app.post('/api/command/materials', auth, async (req) => {
    const u = manage(req)
    const b = parse(V.materialSchema, req.body)
    const id = newId()
    db.run('INSERT INTO cmd_materials (id, category, title, description, attachment_id, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, b.category, b.title, b.description, b.attachmentId, u.id, u.name, Date.now()])
    if (b.attachmentId) host.attachments.link([b.attachmentId], OWNER.material, id, u.id)
    changed('material')
    return ok({ id })
  })
  app.patch('/api/command/materials/:id', auth, async (req) => {
    const u = manage(req)
    const id = param(req, 'id')
    const b = parse(V.materialSchema, req.body)
    const r = db.run('UPDATE cmd_materials SET category = ?, title = ?, description = ? WHERE id = ? AND deleted_at IS NULL', [b.category, b.title, b.description, id])
    if (!r.changes) throw notFound('자료')
    if (b.attachmentId) {
      const cur = host.attachments.list(OWNER.material, id)
      if (!cur.some((f) => f.id === b.attachmentId)) {
        host.attachments.remove(OWNER.material, id)
        host.attachments.link([b.attachmentId], OWNER.material, id, u.id)
      }
    }
    changed('material')
    return ok({ id })
  })
  app.delete('/api/command/materials/:id', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    db.run('UPDATE cmd_materials SET deleted_at = ? WHERE id = ?', [Date.now(), id])
    host.attachments.remove(OWNER.material, id)
    changed('material')
    return ok({ id })
  })

  // ---------- 시나리오 (those in charge only: participants must not read ahead) ----------
  const cleanMsgs = (list: z.infer<typeof V.scenarioMsgSchema>[]): ScenarioMsg[] =>
    list.map((m, i) => ({ ...m, id: newId(), sort: i, bodyHtml: cleanHtml(m.bodyHtml), mapChanges: m.mapChanges.map((c) => (c.op === 'add' ? { op: 'add' as const, mark: c.mark } : c)) }))
  const cleanMap = (m: z.infer<typeof V.mapSchema>): z.infer<typeof V.mapSchema> => ({ ...m, marks: m.marks.map((x) => ({ ...x, id: x.id ?? newId() })) })
  app.get('/api/command/scenarios', auth, async (req) => {
    manage(req)
    return ok(S.scenarioList(db))
  })
  app.get('/api/command/scenarios/:id', auth, async (req) => {
    manage(req)
    const s = S.scenario(db, param(req, 'id'))
    if (!s) throw notFound('시나리오')
    return ok(s)
  })
  const saveScenario = (req: FastifyRequest, id: string | null): { id: string } => {
    const u = manage(req)
    const b = parse(V.scenarioSchema, req.body)
    if (!db.get('SELECT 1 FROM cmd_modes WHERE id = ?', [b.modeId])) throw notFound('근무 유형')
    const t = Date.now()
    const map = cleanMap(b.map)
    const msgs = cleanMsgs(b.messages).sort((a, c) => a.offsetMin - c.offsetMin || a.sort - c.sort).map((m, i) => ({ ...m, sort: i }))
    const sid = id ?? newId()
    if (id) {
      const r = db.run('UPDATE cmd_scenarios SET mode_id = ?, title = ?, summary_html = ?, target_html = ?, map = ?, messages = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [b.modeId, b.title, cleanHtml(b.summaryHtml), cleanHtml(b.targetHtml), JSON.stringify(map), JSON.stringify(msgs), t, id])
      if (!r.changes) throw notFound('시나리오')
    } else {
      db.run('INSERT INTO cmd_scenarios (id, mode_id, title, summary_html, target_html, map, messages, created_by, created_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [sid, b.modeId, b.title, cleanHtml(b.summaryHtml), cleanHtml(b.targetHtml), JSON.stringify(map), JSON.stringify(msgs), u.id, u.name, t, t])
    }
    if (map.imageId) host.attachments.link([map.imageId], OWNER.scenario, sid, u.id)
    changed('scenario', managerIds())
    return { id: sid }
  }
  app.post('/api/command/scenarios', auth, async (req) => ok(saveScenario(req, null)))
  app.put('/api/command/scenarios/:id', auth, async (req) => ok(saveScenario(req, param(req, 'id'))))
  app.post('/api/command/scenarios/:id/copy', auth, async (req) => {
    const u = manage(req)
    const s = S.scenario(db, param(req, 'id'))
    if (!s) throw notFound('시나리오')
    const id = newId()
    const t = Date.now()
    db.run('INSERT INTO cmd_scenarios (id, mode_id, title, summary_html, target_html, map, messages, created_by, created_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, s.modeId, `${s.title} (복사)`.slice(0, 120), s.summaryHtml, s.targetHtml, JSON.stringify(s.map), JSON.stringify(s.messages.map((m) => ({ ...m, id: newId() }))), u.id, u.name, t, t])
    changed('scenario', managerIds())
    return ok({ id })
  })
  app.delete('/api/command/scenarios/:id', auth, async (req) => {
    manage(req)
    db.run('UPDATE cmd_scenarios SET deleted_at = ? WHERE id = ?', [Date.now(), param(req, 'id')])
    changed('scenario', managerIds())
    return ok({ id: param(req, 'id') })
  })

  // ---------- 훈련 ----------
  const attachmentsOf = (answerId: string): ReturnType<typeof host.attachments.list> => host.attachments.list(OWNER.answer, answerId)
  const loadDrill = (id: string, viewer: { id: string; manager: boolean }): NonNullable<ReturnType<typeof S.drill>> => {
    const d = S.drill(db, id, viewer, attachmentsOf)
    if (!d) throw notFound('훈련')
    return d
  }
  const row = (id: string): NonNullable<ReturnType<typeof S.drillRow>> => {
    const r = S.drillRow(db, id)
    if (!r) throw notFound('훈련')
    return r
  }

  /** Sends one message now: who handles it is worked out, the map changes it carries apply. */
  const sendMsg = (drillId: string, msgId: string, now: number, byMemberId: string): void => {
    const m = db.get<{ body: string; sent_at: number | null; skipped: number }>('SELECT body, sent_at, skipped FROM cmd_drill_msgs WHERE id = ? AND drill_id = ?', [msgId, drillId])
    if (!m || m.sent_at || m.skipped) return
    const body = parseJson<Omit<ScenarioMsg, 'id' | 'sort'>>(m.body, {} as ScenarioMsg)
    const targets = S.targetsFor(db, drillId, body)
    db.tx(() => {
      db.run('UPDATE cmd_drill_msgs SET sent_at = ?, targets = ? WHERE id = ?', [now, JSON.stringify(targets), msgId])
      if (body.mapChanges?.length) applyMarks(drillId, body.mapChanges, now, byMemberId)
    })
    drillEvent(drillId, { kind: 'message', msgId, popup: body.popup !== false })
    if (body.mapChanges?.length) drillEvent(drillId, { kind: 'mark' })
  }
  const applyMarks = (drillId: string, changes: ScenarioMsg['mapChanges'], now: number, byMemberId: string): void => {
    const current = S.drillMarks(db, drillId).filter((m) => m.removedAt == null)
    const { add, close } = applyMarkChanges(current, changes, newId)
    for (const id of close) db.run('UPDATE cmd_drill_marks SET removed_at = ? WHERE id = ?', [now, id])
    for (const m of add) insertMark(drillId, m, now, byMemberId)
  }
  const insertMark = (drillId: string, m: Mark, now: number, by: string): void => {
    const { id, key, createdAt: _c, removedAt: _r, ...data } = m
    db.run('INSERT INTO cmd_drill_marks (id, drill_id, key, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, drillId, key, JSON.stringify(data), by, now])
  }

  /** Starts a drill: the participants are fixed now, the scenario's map marks are placed. */
  const startDrill = (drillId: string, now: number, by: string): void => {
    const d = row(drillId)
    if (d.state !== 'scheduled') return
    const members = S.participants(db, host.members(), d.mode_id, parseJson<string[]>(d.team_ids, []), !!d.with_common, now, guests())
    db.tx(() => {
      db.run('DELETE FROM cmd_drill_members WHERE drill_id = ?', [drillId])
      for (const m of members) db.run('INSERT INTO cmd_drill_members (drill_id, member_id, name, title, team_id, role_ids, common, cover_for) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [drillId, m.memberId, m.name, m.title, m.teamId, JSON.stringify(m.roleIds), m.common ? 1 : 0, m.coverFor ?? ''])
      db.run("UPDATE cmd_drills SET state = 'running', started_at = ?, paused_at = NULL, paused_ms = 0 WHERE id = ?", [now, drillId])
    })
    drillEvent(drillId, { kind: 'state', state: 'running', popup: true })
    host.emit(null, 'command.drill', { drillId, kind: 'state', state: 'running' } satisfies CommandDrillPayload)
    // messages at minute 0 go at once
    runDue(drillId, now, by)
  }

  const runDue = (drillId: string, now: number, by: string): void => {
    const d = row(drillId)
    if (d.state !== 'running') return
    const elapsed = drillElapsedMs({ state: d.state, startedAt: d.started_at, pausedAt: d.paused_at, pausedMs: d.paused_ms, endedAt: d.ended_at }, now)
    for (const m of db.all<{ id: string; body: string }>('SELECT id, body FROM cmd_drill_msgs WHERE drill_id = ? AND sent_at IS NULL AND skipped = 0 ORDER BY sort', [drillId])) {
      const offset = parseJson<{ offsetMin?: number }>(m.body, {}).offsetMin ?? 0
      if (offset * 60_000 <= elapsed) sendMsg(drillId, m.id, now, by)
    }
  }

  app.get('/api/command/drills', auth, async (req) => ok(S.drillBriefs(db, who(req).id)))
  app.get('/api/command/drills/:id', auth, async (req) => ok(loadDrill(param(req, 'id'), who(req))))

  app.post('/api/command/drills', auth, async (req) => {
    const u = manage(req)
    const b = parse(V.drillCreateSchema, req.body)
    if (!db.get('SELECT 1 FROM cmd_modes WHERE id = ?', [b.modeId])) throw notFound('근무 유형')
    const known = new Set(S.teams(db).map((t) => t.id))
    const teamIds = b.teamIds.filter((t) => known.has(t))
    if (!teamIds.length) throw bad('참가 조를 고르세요.')
    const sc = b.scenarioId ? S.scenario(db, b.scenarioId) : null
    if (b.scenarioId && !sc) throw notFound('시나리오')
    const id = newId()
    const now = Date.now()
    db.tx(() => {
      db.run('INSERT INTO cmd_drills (id, scenario_id, mode_id, title, summary_html, target_html, map, team_ids, with_common, state, start_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        sc?.id ?? null,
        b.modeId,
        b.title,
        sc?.summaryHtml ?? '',
        sc?.targetHtml ?? '',
        JSON.stringify({ imageId: sc?.map.imageId ?? null, width: sc?.map.width ?? 0, height: sc?.map.height ?? 0 }),
        JSON.stringify(teamIds),
        b.withCommon ? 1 : 0,
        'scheduled',
        b.startAt,
        u.id,
        now
      ])
      for (const m of sc?.messages ?? []) {
        const { id: _i, sort, ...body } = m
        db.run('INSERT INTO cmd_drill_msgs (id, drill_id, sort, body) VALUES (?, ?, ?, ?)', [newId(), id, sort, JSON.stringify(body)])
      }
      // the scenario's marks are there from the first moment
      for (const mk of sc?.map.marks ?? []) insertMark(id, { ...mk, id: newId() }, now, u.id)
    })
    host.log?.(req, 'command.drill.create', { id, title: b.title })
    if (b.startAt == null || b.startAt <= now) startDrill(id, now, u.id)
    else host.emit(null, 'command.drill', { drillId: id, kind: 'state', state: 'scheduled' } satisfies CommandDrillPayload)
    return ok({ id })
  })

  app.post('/api/command/drills/:id/:action', auth, async (req) => {
    const u = manage(req)
    const id = param(req, 'id')
    const action = param(req, 'action')
    const d = row(id)
    const now = Date.now()
    if (action === 'start') {
      if (d.state !== 'scheduled') throw bad('이미 시작한 훈련입니다.')
      startDrill(id, now, u.id)
    } else if (action === 'pause') {
      if (d.state !== 'running') throw bad('진행 중인 훈련이 아닙니다.')
      db.run("UPDATE cmd_drills SET state = 'paused', paused_at = ? WHERE id = ?", [now, id])
      drillEvent(id, { kind: 'state', state: 'paused' })
    } else if (action === 'resume') {
      if (d.state !== 'paused') throw bad('멈춘 훈련이 아닙니다.')
      db.run("UPDATE cmd_drills SET state = 'running', paused_ms = paused_ms + ?, paused_at = NULL WHERE id = ?", [Math.max(0, now - (d.paused_at ?? now)), id])
      drillEvent(id, { kind: 'state', state: 'running' })
      runDue(id, now, u.id)
    } else if (action === 'end') {
      if (d.state === 'ended') throw bad('이미 끝난 훈련입니다.')
      const pausedMs = d.state === 'paused' && d.paused_at ? d.paused_ms + (now - d.paused_at) : d.paused_ms
      db.run("UPDATE cmd_drills SET state = 'ended', ended_at = ?, paused_ms = ?, paused_at = NULL WHERE id = ?", [now, pausedMs, id])
      drillEvent(id, { kind: 'state', state: 'ended' })
      host.emit(null, 'command.drill', { drillId: id, kind: 'state', state: 'ended' } satisfies CommandDrillPayload)
      host.log?.(req, 'command.drill.end', { id })
    } else if (action === 'delete') {
      if (d.state === 'running' || d.state === 'paused') throw bad('진행 중인 훈련은 지울 수 없습니다. 먼저 끝내세요.')
      for (const a of db.all<{ id: string }>('SELECT a.id FROM cmd_drill_answers a JOIN cmd_drill_msgs m ON m.id = a.msg_id WHERE m.drill_id = ?', [id])) host.attachments.remove(OWNER.answer, a.id)
      db.run('DELETE FROM cmd_drills WHERE id = ?', [id])
      host.emit(null, 'command.drill', { drillId: id, kind: 'state', state: 'deleted' } satisfies CommandDrillPayload)
    } else throw notFound('동작')
    return ok({ id })
  })

  /** 즉석 메시지: sent at once. */
  app.post('/api/command/drills/:id/messages', auth, async (req) => {
    const u = manage(req)
    const id = param(req, 'id')
    const d = row(id)
    if (d.state !== 'running' && d.state !== 'paused') throw bad('진행 중인 훈련에만 보낼 수 있습니다.')
    const b = parse(V.scenarioMsgSchema, req.body)
    const now = Date.now()
    const elapsed = drillElapsedMs({ state: d.state, startedAt: d.started_at, pausedAt: d.paused_at, pausedMs: d.paused_ms, endedAt: d.ended_at }, now)
    const sort = db.get<{ s: number }>('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM cmd_drill_msgs WHERE drill_id = ?', [id])?.s ?? 0
    const mid = newId()
    db.run('INSERT INTO cmd_drill_msgs (id, drill_id, sort, body, ad_hoc) VALUES (?, ?, ?, ?, 1)', [mid, id, sort, JSON.stringify({ ...b, bodyHtml: cleanHtml(b.bodyHtml), offsetMin: Math.floor(elapsed / 60_000) })])
    sendMsg(id, mid, now, u.id)
    return ok({ id: mid })
  })
  /** Changes a message that has not gone yet. */
  app.patch('/api/command/drills/:id/messages/:mid', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    const m = db.get<{ sent_at: number | null }>('SELECT sent_at FROM cmd_drill_msgs WHERE id = ? AND drill_id = ?', [param(req, 'mid'), id])
    if (!m) throw notFound('메시지')
    if (m.sent_at) throw bad('이미 보낸 메시지는 고칠 수 없습니다.')
    const b = parse(V.scenarioMsgSchema, req.body)
    db.run('UPDATE cmd_drill_msgs SET body = ? WHERE id = ?', [JSON.stringify({ ...b, bodyHtml: cleanHtml(b.bodyHtml) }), param(req, 'mid')])
    drillEvent(id, { kind: 'message' }, managerIds())
    return ok({ id: param(req, 'mid') })
  })
  app.post('/api/command/drills/:id/messages/:mid/:action', auth, async (req) => {
    const u = manage(req)
    const id = param(req, 'id')
    const mid = param(req, 'mid')
    const action = param(req, 'action')
    const d = row(id)
    if (d.state === 'ended' || d.state === 'scheduled') throw bad('진행 중인 훈련이 아닙니다.')
    const m = db.get<{ sent_at: number | null }>('SELECT sent_at FROM cmd_drill_msgs WHERE id = ? AND drill_id = ?', [mid, id])
    if (!m) throw notFound('메시지')
    if (action === 'send') {
      if (m.sent_at) throw bad('이미 보낸 메시지입니다.')
      db.run('UPDATE cmd_drill_msgs SET skipped = 0 WHERE id = ?', [mid])
      sendMsg(id, mid, Date.now(), u.id)
    } else if (action === 'skip') {
      if (m.sent_at) throw bad('이미 보낸 메시지입니다.')
      db.run('UPDATE cmd_drill_msgs SET skipped = 1 WHERE id = ?', [mid])
      drillEvent(id, { kind: 'message', msgId: mid }, managerIds())
    } else throw notFound('동작')
    return ok({ id: mid })
  })

  /** 다시 알림: the window pops up again for the members who have not answered. */
  app.post('/api/command/drills/:id/messages/:mid/remind', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    const { memberIds } = parse(V.remindSchema, req.body)
    const members = new Set(S.drillMembers(db, id).map((m) => m.memberId))
    const to = memberIds.filter((m) => members.has(m))
    if (to.length) host.emit(to, 'command.drill', { drillId: id, kind: 'remind', msgId: param(req, 'mid'), popup: true } satisfies CommandDrillPayload)
    return ok({ sent: to.length })
  })

  /** An answer (a participant, by the way the message is to be handled). */
  app.post('/api/command/drills/:id/messages/:mid/answer', auth, async (req) => {
    const u = who(req)
    const id = param(req, 'id')
    const mid = param(req, 'mid')
    const d = row(id)
    if (d.state === 'ended') throw bad('끝난 훈련입니다.')
    if (d.state === 'scheduled') throw bad('아직 시작하지 않은 훈련입니다.')
    const b = parse(V.answerSchema, req.body)
    const msgs = S.drillMsgs(db, id, new Map())
    const m = msgs.find((x) => x.id === mid)
    if (!m) throw notFound('메시지')
    const isParticipant = !!db.get('SELECT 1 FROM cmd_drill_members WHERE drill_id = ? AND member_id = ?', [id, u.id])
    const why = answerRefusal(m, u.id, isParticipant)
    if (why) throw bad(why)
    if (m.answerKind === 'choice') {
      if (b.choiceIndex == null || b.choiceIndex >= m.choices.length) throw bad('선택지를 고르세요.')
    } else if (!b.body && !b.attachmentIds.length) throw bad('처리 내용을 적으세요.')
    const now = Date.now()
    const cur = db.get<{ id: string }>('SELECT id FROM cmd_drill_answers WHERE msg_id = ? AND member_id = ?', [mid, u.id])
    const aid = cur?.id ?? newId()
    const late = m.limitMin != null && m.sentAt != null && now - m.sentAt > m.limitMin * 60_000
    if (cur) db.run('UPDATE cmd_drill_answers SET body = ?, choice_index = ?, updated_at = ? WHERE id = ?', [b.body, b.choiceIndex, now, aid])
    else db.run('INSERT INTO cmd_drill_answers (id, msg_id, member_id, body, choice_index, answered_at, updated_at, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [aid, mid, u.id, b.body, b.choiceIndex, now, now, late ? 1 : 0])
    host.attachments.link(b.attachmentIds, OWNER.answer, aid, u.id)
    drillEvent(id, { kind: 'answer', msgId: mid })
    return ok({ id: aid, late })
  })

  app.put('/api/command/drills/:id/answers/:aid/grade', auth, async (req) => {
    const u = manage(req)
    const b = parse(V.gradeSchema, req.body)
    const r = db.run('UPDATE cmd_drill_answers SET grade = ?, comment = ?, graded_by = ?, graded_by_name = ?, graded_at = ? WHERE id = ? AND msg_id IN (SELECT id FROM cmd_drill_msgs WHERE drill_id = ?)', [b.grade, b.comment, u.id, u.name, Date.now(), param(req, 'aid'), param(req, 'id')])
    if (!r.changes) throw notFound('답변')
    drillEvent(param(req, 'id'), { kind: 'grade' })
    return ok({ id: param(req, 'aid') })
  })

  // the map during a drill: those in charge add, move and remove marks; everybody sees it at once
  app.post('/api/command/drills/:id/marks', auth, async (req) => {
    const u = manage(req)
    const id = param(req, 'id')
    const d = row(id)
    if (d.state === 'ended') throw bad('끝난 훈련입니다.')
    const mark = parse(V.markSchema, req.body)
    const mid = newId()
    insertMark(id, { ...mark, id: mid }, Date.now(), u.id)
    drillEvent(id, { kind: 'mark' })
    return ok({ id: mid, key: mark.key })
  })
  app.patch('/api/command/drills/:id/marks/:key', auth, async (req) => {
    const u = manage(req)
    const id = param(req, 'id')
    if (row(id).state === 'ended') throw bad('끝난 훈련입니다.')
    const mark = parse(V.markSchema, { ...(req.body as object), key: param(req, 'key') })
    const cur = db.get<{ id: string }>('SELECT id FROM cmd_drill_marks WHERE drill_id = ? AND key = ? AND removed_at IS NULL', [id, mark.key])
    if (!cur) throw notFound('표식')
    const now = Date.now()
    db.tx(() => {
      db.run('UPDATE cmd_drill_marks SET removed_at = ? WHERE id = ?', [now, cur.id])
      insertMark(id, { ...mark, id: newId() }, now, u.id)
    })
    drillEvent(id, { kind: 'mark' })
    return ok({ key: mark.key })
  })
  app.delete('/api/command/drills/:id/marks/:key', auth, async (req) => {
    manage(req)
    const id = param(req, 'id')
    if (row(id).state === 'ended') throw bad('끝난 훈련입니다.')
    db.run('UPDATE cmd_drill_marks SET removed_at = ? WHERE drill_id = ? AND key = ? AND removed_at IS NULL', [Date.now(), id, param(req, 'key')])
    drillEvent(id, { kind: 'mark' })
    return ok({ key: param(req, 'key') })
  })

  // 통제 기록 and 총평 (those in charge)
  app.post('/api/command/drills/:id/notes', auth, async (req) => {
    const u = manage(req)
    const id = param(req, 'id')
    row(id)
    const b = parse(V.noteSchema, req.body)
    const nid = newId()
    db.run('INSERT INTO cmd_drill_notes (id, drill_id, at, body, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?)', [nid, id, Date.now(), b.body, u.id, u.name])
    drillEvent(id, { kind: 'note' }, managerIds())
    return ok({ id: nid })
  })
  app.delete('/api/command/drills/:id/notes/:nid', auth, async (req) => {
    manage(req)
    db.run('DELETE FROM cmd_drill_notes WHERE id = ? AND drill_id = ?', [param(req, 'nid'), param(req, 'id')])
    drillEvent(param(req, 'id'), { kind: 'note' }, managerIds())
    return ok({ id: param(req, 'nid') })
  })
  app.put('/api/command/drills/:id/review', auth, async (req) => {
    manage(req)
    const b = parse(V.reviewSchema, req.body)
    const r = db.run('UPDATE cmd_drills SET review_html = ? WHERE id = ?', [cleanHtml(b.reviewHtml), param(req, 'id')])
    if (!r.changes) throw notFound('훈련')
    drillEvent(param(req, 'id'), { kind: 'note' }, managerIds())
    return ok({ id: param(req, 'id') })
  })

  const runJobs = (now = Date.now()): void => {
    for (const d of db.all<{ id: string; created_by: string }>("SELECT id, created_by FROM cmd_drills WHERE state = 'scheduled' AND start_at IS NOT NULL AND start_at <= ?", [now])) startDrill(d.id, now, d.created_by)
    for (const d of db.all<{ id: string; created_by: string }>("SELECT id, created_by FROM cmd_drills WHERE state = 'running'")) runDue(d.id, now, d.created_by)
  }

  return { db, runJobs, close: () => db.close() }
}
