import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import type { CmdFile } from '../shared/types'
import type { CommandEvent } from '../shared/events'

/** A person of the host program who can be placed in a 조. */
export interface CommandMember {
  id: string
  name: string
  /** 직위 as the host knows it */
  title: string
  dept: string
  /** a short mark the host shows next to the name everywhere (TeamHub: '서무') */
  mark?: string
}

/**
 * Somebody on a list the host keeps of its own who is not a member (TeamHub: 미등록 인원, the
 * staff who do not use TeamHub). The list is edited only in the host.
 */
export interface CommandGuest {
  /** stable and unique within the list */
  id: string
  name: string
  title: string
  dept: string
  memo: string
  /** taken off the list (still named, so places left in the module can be shown) */
  gone?: boolean
  /** turned out to be this member of the host */
  as?: string
}

/**
 * What the command module needs from the program that runs it (TeamHub today, a program of its
 * own later). The module never reaches into the host otherwise.
 */
export interface CommandServerHost {
  /** folder for command.db; null keeps it in memory (tests) */
  dataDir: string | null
  /** authenticates a request (Fastify preHandler) */
  requireAuth: preHandlerAsyncHookHandler
  /** who asks (after requireAuth): member id, name, and whether this is the server PC */
  user(req: FastifyRequest): { id: string; name: string; isOwner: boolean }
  /** the active members */
  members(): CommandMember[]
  /**
   * optional: the people the host keeps a list of who are not members (TeamHub: 미등록 인원,
   * kept in 관리). The module places them like members (not in drills) and marks them 미등록;
   * the list is edited only in the host. Without it the module has no such people.
   */
  guests?: {
    /** the name of the list in the screens, e.g. '미등록 인원' */
    label: string
    /** where the host edits it, e.g. '관리 → 구성원·PC → 미등록 인원' */
    where: string
    list(): CommandGuest[]
    /**
     * puts somebody on the list (the module's own 임시 인원 of before move there once); the same
     * `key` always gives the same person, so a move that is done again registers nobody twice
     */
    add?(p: { name: string; title: string; dept: string; memo: string }, o: { key: string }): { id: string } | { error: string }
    /** the list changed (the module follows a merge and refreshes the screens) */
    onChange?(cb: () => void): void
  }
  /** member ids of the server PC's own account(s): they manage the module like a 지휘대담당 */
  ownerIds(): string[]
  /** files kept by the host: link uploaded ones to an owner, list, remove, and who may download */
  attachments: {
    link(ids: string[], ownerType: string, ownerId: string, memberId: string): void
    list(ownerType: string, ownerId: string): CmdFile[]
    remove(ownerType: string, ownerId: string): void
    registerOwner(ownerType: string, check: (ownerId: string, memberId: string) => boolean): void
  }
  /** realtime: to these members (null: everybody connected) */
  emit(memberIds: string[] | null, event: CommandEvent, payload: unknown): void
  /** the error to throw (status, code, Korean message) — the host turns it into its error reply */
  fail(status: number, code: string, message: string): Error
  /** wraps a reply body the way the host answers */
  ok<T>(data: T): unknown
  /**
   * who is away today by the host's own attendance board (TeamHub: 근무현황), with the reason
   * (optional; shown to those in charge as "away today — name a substitute")
   */
  absencesToday?(): { memberId: string; type: string }[]
  /** activity log of the host (optional) */
  log?(req: FastifyRequest, action: string, detail?: Record<string, unknown>): void
  /** report an error of a background job */
  report?(message: string): void
}
