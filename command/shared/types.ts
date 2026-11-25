/**
 * 긴급구조지휘대 (command): data shapes shared by the server and the screens.
 * Nothing here depends on the host program (TeamHub); see host.ts for what the host gives.
 */

/** A person who can be placed: a member of the host (`memberId`) or a temporary person (`x:` id). */
export interface CmdPerson {
  id: string
  name: string
  /** 직위 (rank or position) as the host knows it; for temporary people as typed */
  title: string
  dept: string
  /** a temporary person (not registered in the host): placed and shown, cannot answer in drills */
  temp: boolean
  memo?: string
  /** a short mark the host shows next to the name (e.g. '서무') */
  mark?: string
}

export interface CmdMode {
  id: string
  name: string
  sort: number
  hidden: boolean
}

export interface CmdTeam {
  id: string
  name: string
  color: string
  sort: number
  /** person ids, in order */
  members: string[]
}

export interface CmdRole {
  id: string
  modeId: string
  parentId: string | null
  name: string
  sort: number
  /** has a written 임무 설명 (read with GET /api/command/roles/:id) */
  hasDuty: boolean
}

export interface CmdAssignment {
  roleId: string
  teamId: string
  personId: string
}

export interface CmdCommon {
  id: string
  name: string
  description: string
  /** true: a different person per 조; false: the same people whatever 조 is on */
  perTeam: boolean
  sort: number
  /** teamId '' = fixed (perTeam false) */
  assign: { teamId: string; personId: string }[]
}

export interface CmdException {
  id: string
  personId: string
  reason: string
  fromDate: string
  /** null: until further notice */
  toDate: string | null
}

export interface CmdRotation {
  /** the day the first 조 of `order` starts (YYYY-MM-DD) */
  baseDate: string
  /** when a period begins (HH:mm) */
  shiftTime: string
  periodDays: number
  order: string[]
}

export interface CmdOverride {
  id: string
  fromAt: number
  toAt: number
  teamId: string
  note: string
  createdAt: number
}

export interface CmdManager {
  memberId: string
  name: string
}

export interface CmdDrillBrief {
  id: string
  title: string
  modeId: string
  state: DrillState
  startAt: number | null
  startedAt: number | null
  endedAt: number | null
  teamIds: string[]
  /** for me: messages I still have to handle */
  pendingForMe: number
  participant: boolean
}

/** Everything the screens need at once (GET /api/command). */
export interface CommandState {
  modes: CmdMode[]
  teams: CmdTeam[]
  roles: CmdRole[]
  assignments: CmdAssignment[]
  common: CmdCommon[]
  exceptions: CmdException[]
  overrides: CmdOverride[]
  rotation: CmdRotation | null
  /** every person who can be placed: active members of the host and temporary people */
  people: CmdPerson[]
  managers: CmdManager[]
  me: { id: string; isManager: boolean; isOwner: boolean }
  unreadNotices: number
  /** drills that are scheduled, running or paused, and the last ended ones */
  drills: CmdDrillBrief[]
  serverNow: number
}

export interface CmdNotice {
  id: string
  title: string
  bodyHtml: string
  pinned: boolean
  createdBy: string
  createdByName: string
  createdAt: number
  updatedAt: number
  attachments: CmdFile[]
  read: boolean
}

export interface CmdFile {
  id: string
  name: string
  size: number
}

export interface CmdMaterial {
  id: string
  category: string
  title: string
  description: string
  file: CmdFile | null
  createdBy: string
  createdByName: string
  createdAt: number
}

// ---------- map (지도 표기) ----------
export type MarkKind = 'pin' | 'line' | 'arrow' | 'area' | 'text'
export const MARK_ICONS = ['command', 'vehicle', 'fire', 'rescue', 'water', 'entrance', 'hazard', 'evacuation', 'assembly', 'point'] as const
export type MarkIcon = (typeof MARK_ICONS)[number]
export const MARK_ICON_LABEL: Record<MarkIcon, string> = {
  command: '지휘소',
  vehicle: '차량',
  fire: '화점',
  rescue: '요구조자',
  water: '소화전·수원',
  entrance: '출입구',
  hazard: '위험물',
  evacuation: '대피로',
  assembly: '집결지',
  point: '일반'
}
export const MARK_COLORS = ['#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#2563eb', '#7c3aed'] as const

/**
 * One mark on the picture. Coordinates are fractions of the picture (0..1), so a mark stays at
 * the same place at any size. `key` is the mark itself; a moved mark is a new version (`id`)
 * of the same key, so the map can be replayed as it was at any moment of a drill.
 */
export interface Mark {
  id: string
  key: string
  kind: MarkKind
  icon?: MarkIcon
  color: string
  label: string
  points: [number, number][]
  createdAt?: number
  removedAt?: number | null
}

export interface MapData {
  imageId: string | null
  /** natural size of the picture (for the aspect ratio) */
  width: number
  height: number
  marks: Mark[]
}

/** A change of the map a scenario message brings with it (applied when the message is sent). */
export type MarkChange = { op: 'add'; mark: Omit<Mark, 'id'> } | { op: 'move'; key: string; points: [number, number][] } | { op: 'remove'; key: string }

// ---------- scenarios and drills ----------
export type TargetKind = 'role' | 'person' | 'all'
/** assigned: only the people it is for; first: anybody, the first answer settles it; all: every participant answers */
export type Handling = 'assigned' | 'first' | 'all'
export type AnswerKind = 'text' | 'choice'
export type DrillState = 'scheduled' | 'running' | 'paused' | 'ended'
export type Grade = 'good' | 'fair' | 'poor'
export const GRADE_LABEL: Record<Grade, string> = { good: '우수', fair: '보통', poor: '미흡' }
export const HANDLING_LABEL: Record<Handling, string> = { assigned: '지정 담당자만 처리', first: '아무나 먼저 처리', all: '전원 각자 처리' }

export interface ScenarioMsg {
  id: string
  sort: number
  offsetMin: number
  title: string
  bodyHtml: string
  targetKind: TargetKind
  targetIds: string[]
  handling: Handling
  answerKind: AnswerKind
  choices: string[]
  correctIndex: number | null
  limitMin: number | null
  popup: boolean
  mapChanges: MarkChange[]
}

export interface Scenario {
  id: string
  modeId: string
  title: string
  summaryHtml: string
  targetHtml: string
  map: MapData
  messages: ScenarioMsg[]
  createdBy: string
  createdByName: string
  createdAt: number
  updatedAt: number
}

export interface ScenarioBrief {
  id: string
  modeId: string
  title: string
  messages: number
  updatedAt: number
}

export interface DrillMember {
  memberId: string
  name: string
  title: string
  teamId: string | null
  roleIds: string[]
  common: boolean
}

export interface DrillAnswer {
  id: string
  msgId: string
  memberId: string
  name: string
  body: string
  choiceIndex: number | null
  attachments: CmdFile[]
  answeredAt: number
  /** seconds from the message being sent */
  seconds: number
  late: boolean
  grade: Grade | null
  comment: string
  gradedByName: string | null
}

export interface DrillMsg extends ScenarioMsg {
  /** the members who are to handle it (worked out when it is sent) */
  targets: string[]
  sentAt: number | null
  skipped: boolean
  answers: DrillAnswer[]
  /** nothing left to answer (first: somebody answered; assigned/all: every one of the targets) */
  done: boolean
  /** made during the drill (즉석 메시지) */
  adHoc: boolean
}

export interface DrillNote {
  id: string
  at: number
  body: string
  byName: string
}

export interface Drill {
  id: string
  scenarioId: string | null
  modeId: string
  title: string
  state: DrillState
  startAt: number | null
  startedAt: number | null
  pausedAt: number | null
  pausedMs: number
  endedAt: number | null
  teamIds: string[]
  withCommon: boolean
  summaryHtml: string
  targetHtml: string
  map: { imageId: string | null; width: number; height: number }
  /** every version of every mark (createdAt/removedAt), to show the map at any moment */
  marks: Mark[]
  members: DrillMember[]
  messages: DrillMsg[]
  notes: DrillNote[]
  reviewHtml: string
  /** the one asking may run it */
  isManager: boolean
  serverNow: number
}

export interface SummaryRow {
  key: string
  name: string
  received: number
  answered: number
  late: number
  avgSeconds: number | null
  grades: Record<Grade, number>
  choiceAsked: number
  choiceRight: number
}
