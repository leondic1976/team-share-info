# TeamHub

Windows LAN team collaboration app (Electron). One PC runs as server, others connect by IP.
**`plan.md` is the source of truth.** Part 2 (section 13) is the implementation spec; read 13.0 before every task
and work only on the next unchecked step in 13.12. Record progress in 13.14.

## Commands
- `pnpm dev` / `pnpm dev:b` — run app (profile A / profile B side by side)
- `pnpm build` — build main, server, preload, renderer into `out/`
- `pnpm typecheck && pnpm lint && pnpm test` — must pass before a step is done
- `pnpm e2e` — build + Playwright-driven Electron E2E (`e2e/*.e2e.ts`)
- `pnpm dist` — NSIS installer into `release/` (only when a step asks for it)

## Layout
- `src/main` main process (windows, tray, IPC, local DB, launcher, utilities)
- `src/preload` exposes `window.teamhub` (typed invoke/on over an allowlist in `src/shared/ipc.ts`)
- `src/renderer` React UI (`features/<feature>/`)
- `src/server` embedded server (Fastify + ws), runs in an Electron utilityProcess
- `src/node` Node-only helpers shared by main and server (`sqlite.ts`)
- `src/shared` pure TS shared by everything (constants, Zod schemas, IPC/event types)

## Rules
- DB: built-in `node:sqlite` via `src/node/sqlite.ts` with hand-written migrations (no native modules).
  Never edit an applied migration; append a new one.
- Personal data lives only in the local DB (`src/main/localdb`), which must never import network code (ESLint enforced).
- Shared data lives in the server DB; every shared item has a scope (team/group/members) checked on the server.
- UI text Korean; code, identifiers and comments English.
- Tests: `tests/**/*.test.ts` (vitest, Node). Use `TEAMHUB_USERDATA` to isolate app data in E2E.
- Commit only when asked. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
