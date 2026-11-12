import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'

export const folderCreateSchema = z.object({
  parentId: z.string().nullable().default(null),
  name: z.string().trim().min(1, '폴더 이름을 입력하세요').max(100),
  scope: scopeSchema.optional(),
  writePolicy: z.enum(['all', 'owner']).default('all')
})

export const folderPatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  scope: scopeSchema.optional(),
  writePolicy: z.enum(['all', 'owner']).optional()
})

export const uploadCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(0),
  folderId: z.string(),
  fileId: z.string().optional(),
  note: z.string().max(300).default('')
})

export interface FolderDto {
  id: string
  parentId: string | null
  rootId: string
  name: string
  scope: ScopeDto
  writePolicy: 'all' | 'owner'
  createdBy: string
  createdByName: string
  canWrite: boolean
  canManage: boolean
  updatedAt: number
}

export interface FileDto {
  id: string
  folderId: string
  name: string
  size: number
  versionCount: number
  currentVersionId: string | null
  lockedBy: string | null
  lockedByName: string | null
  lockedAt: number | null
  createdBy: string
  createdByName: string
  updatedBy: string | null
  updatedByName: string | null
  createdAt: number
  updatedAt: number
  path?: string
}

export interface FileVersionDto {
  id: string
  versionNo: number
  size: number
  note: string | null
  createdBy: string
  createdByName: string
  createdAt: number
}

export interface FolderView {
  folder: FolderDto | null
  breadcrumb: { id: string; name: string }[]
  folders: FolderDto[]
  files: FileDto[]
}

export interface TrashItemDto {
  type: 'file' | 'folder'
  id: string
  name: string
  size: number
  deletedAt: number
  deletedByName: string | null
  location: string
}

export interface UploadStateDto {
  id: string
  received: number
  size: number
  chunkSize: number
}
