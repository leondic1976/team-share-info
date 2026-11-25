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
  /** activity log of the host (optional) */
  log?(req: FastifyRequest, action: string, detail?: Record<string, unknown>): void
  /** report an error of a background job */
  report?(message: string): void
}
