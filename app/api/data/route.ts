import type { PoolClient } from 'pg'
import { getAppUser, isSameOriginWrite, type AppUser } from '@/src/server/auth'
import { withDatabaseTransaction } from '@/src/server/database'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_REQUEST_BYTES = 2_000_000
const MAX_QUERY_RESULTS = 500
const MAX_QUERY_SCAN = 20_000
const ADMIN_EMAIL = 'voho0000@gmail.com'
const jsonHeaders = { 'cache-control': 'no-store' }

type JsonRecord = Record<string, unknown>
type WriteKind = 'set' | 'update' | 'delete'
interface WriteOperation {
  kind: WriteKind
  path: string
  data?: JsonRecord
  merge?: boolean
}
interface StoredDocument { path: string; id: string; data: JsonRecord; revision: number }
interface ParsedPath { parts: string[]; collectionPath: string; id: string }

class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function fail(status: number, message: string): never { throw new ApiError(status, message) }
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: jsonHeaders })
}
function partsOf(path: unknown): string[] {
  if (typeof path !== 'string' || path.length > 1024) fail(400, 'Invalid document path')
  const parts = path.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..' || part.includes('\u0000'))) fail(400, 'Invalid document path')
  return parts
}
function documentPath(path: unknown): ParsedPath {
  const parts = partsOf(path)
  if (parts.length < 2 || parts.length % 2 !== 0) fail(400, 'Invalid document path')
  return { parts, collectionPath: parts.slice(0, -1).join('/'), id: parts.at(-1)! }
}
function collectionPath(path: unknown): string {
  const parts = partsOf(path)
  if (!parts.length || parts.length % 2 !== 1) fail(400, 'Invalid collection path')
  return parts.join('/')
}
function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function parseWrite(value: unknown): WriteOperation {
  if (!isRecord(value) || !['set', 'update', 'delete'].includes(String(value.kind))) fail(400, 'Invalid write')
  const parsed = documentPath(value.path)
  if (value.kind !== 'delete' && !isRecord(value.data)) fail(400, 'Invalid write data')
  return {
    kind: value.kind as WriteKind,
    path: parsed.parts.join('/'),
    ...(value.kind === 'delete' ? {} : { data: value.data as JsonRecord }),
    merge: value.merge === true,
  }
}
async function parseBody(request: Request): Promise<JsonRecord> {
  const length = Number(request.headers.get('content-length') || 0)
  if (length > MAX_REQUEST_BYTES) fail(413, 'Request is too large')
  let text: string
  try { text = await request.text() } catch { fail(400, 'Invalid request body') }
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) fail(413, 'Request is too large')
  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) fail(400, 'Invalid request body')
    return value
  } catch (error) {
    if (error instanceof ApiError) throw error
    fail(400, 'Invalid JSON')
  }
}

async function readStored(client: PoolClient, path: string, lock = false): Promise<StoredDocument | null> {
  const parsed = documentPath(path)
  const result = await client.query<{ data: JsonRecord; revision: string | number }>(
    `SELECT data, revision FROM app_documents WHERE collection_path = $1 AND document_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [parsed.collectionPath, parsed.id],
  )
  const row = result.rows[0]
  return row ? { path, id: parsed.id, data: row.data, revision: Number(row.revision) } : null
}

async function readOwner(client: PoolClient, requestId: string): Promise<JsonRecord | null> {
  const result = await client.query<{ data: JsonRecord }>(
    `SELECT data FROM app_documents WHERE collection_path = 'featureRequestOwners' AND document_id = $1`,
    [requestId],
  )
  return result.rows[0]?.data ?? null
}

interface Actor {
  user: AppUser | null
  admin: boolean
  memberships: Map<string, { role: string; canPublish: boolean }>
}
async function actorFor(client: PoolClient, user: AppUser | null): Promise<Actor> {
  const memberships = new Map<string, { role: string; canPublish: boolean }>()
  if (user) {
    const result = await client.query<{ document_id: string; data: JsonRecord }>(
      `SELECT document_id, data FROM app_documents WHERE collection_path = $1`,
      [`users/${user.uid}/memberships`],
    )
    for (const row of result.rows) {
      const tenantId = typeof row.data.tenant_id === 'string' && row.data.tenant_id ? row.data.tenant_id : row.document_id
      if (row.data.status !== 'active') continue
      const role = typeof row.data.role === 'string' ? row.data.role : 'member'
      memberships.set(tenantId, { role, canPublish: role === 'owner' || role === 'builder' })
    }
  }
  return {
    user,
    admin: user?.emailVerified === true && user.email?.toLowerCase() === ADMIN_EMAIL,
    memberships,
  }
}
function ownsTenant(actor: Actor, tenantId: unknown): boolean {
  return typeof tenantId === 'string' && actor.memberships.has(tenantId)
}
async function readable(client: PoolClient, actor: Actor, path: string, data: JsonRecord): Promise<boolean> {
  const { parts } = documentPath(path)
  const root = parts[0]
  if (root === 'users') return !!actor.user && parts[1] === actor.user.uid
  if (root === 'sharedPrompts' && parts.length === 2) {
    return actor.admin || data.authorId === actor.user?.uid
      || (!data.tenantId && data.isPublic !== false)
  }
  if (root === 'tenantPrompts' && parts.length === 2) {
    return ownsTenant(actor, data.tenantId)
  }
  if (root === 'featureRequests' && parts.length === 2) {
    if (actor.admin || data.visibility !== 'hidden') return true
    return (await readOwner(client, parts[1]))?.authorId === actor.user?.uid
  }
  if (root === 'featureRequestOwners' && parts.length === 2) {
    return actor.admin || (!!actor.user && data.authorId === actor.user.uid)
  }
  if (root === 'featureRequestVotes' && parts.length === 4) {
    return !!actor.user && parts[1] === actor.user.uid
  }
  if (root === 'templateBodies' && parts.length === 2) {
    if (data.ownerId === actor.user?.uid || actor.admin) return true
    if (data.scope !== 'shared' || typeof data.promptId !== 'string') return false
    const prompt = await readStored(client, `sharedPrompts/${data.promptId}`)
    return !!prompt && readable(client, actor, prompt.path, prompt.data)
  }
  if (root === 'templateBodies' && parts.length === 4 && parts[2] === 'chunks') {
    const manifest = await readStored(client, `templateBodies/${parts[1]}`)
    return !!manifest && readable(client, actor, manifest.path, manifest.data)
  }
  if (root === 'labDataReports' || root === 'labReports') return actor.admin
  return false
}

function timestampValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(timestampValue)
  if (!isRecord(value)) return value
  if (value.__type === 'timestamp' && typeof value.milliseconds === 'number') return value.milliseconds
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, timestampValue(nested)]))
}
function getField(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, data)
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(timestampValue(a)) === JSON.stringify(timestampValue(b))
}
function compare(a: unknown, b: unknown): number {
  const left = timestampValue(a)
  const right = timestampValue(b)
  if (left === right) return 0
  if (left === undefined || left === null) return -1
  if (right === undefined || right === null) return 1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right)
  return String(left).localeCompare(String(right))
}
function matchesWhere(data: JsonRecord, constraint: JsonRecord): boolean {
  const value = getField(data, String(constraint.field))
  const target = constraint.value
  switch (constraint.operator) {
    case '==': return equal(value, target)
    case '!=': return value !== undefined && !equal(value, target)
    case '<': return compare(value, target) < 0
    case '<=': return compare(value, target) <= 0
    case '>': return compare(value, target) > 0
    case '>=': return compare(value, target) >= 0
    case 'in': return Array.isArray(target) && target.some(item => equal(value, item))
    case 'array-contains': return Array.isArray(value) && value.some(item => equal(item, target))
    case 'array-contains-any': return Array.isArray(value) && Array.isArray(target) && value.some(item => target.some(candidate => equal(item, candidate)))
    default: fail(400, 'Unsupported query operator')
  }
}
function isConstraint(value: unknown): value is JsonRecord {
  return isRecord(value) && ['where', 'orderBy', 'limit', 'startAfter'].includes(String(value.type))
}
async function queryDocuments(client: PoolClient, actor: Actor, rawPath: unknown, rawConstraints: unknown): Promise<StoredDocument[]> {
  const path = collectionPath(rawPath)
  if (!Array.isArray(rawConstraints) || rawConstraints.length > 20 || !rawConstraints.every(isConstraint)) fail(400, 'Invalid query')
  const constraints = rawConstraints as JsonRecord[]
  const filters = constraints.filter(item => item.type === 'where')
  const orders = constraints.filter(item => item.type === 'orderBy')
  const cursors = constraints.filter(item => item.type === 'startAfter')
  if (orders.length > 1 || cursors.length > 1) fail(400, 'Unsupported query')
  const order = orders[0]
  if (order && (typeof order.field !== 'string' || !['asc', 'desc'].includes(String(order.direction)))) fail(400, 'Invalid ordering')
  const limitConstraint = constraints.find(item => item.type === 'limit')
  const resultLimit = limitConstraint ? Math.min(MAX_QUERY_RESULTS, Math.max(0, Number(limitConstraint.count) || 0)) : 100
  const result = await client.query<{ document_id: string; data: JsonRecord; revision: string | number }>(
    'SELECT document_id, data, revision FROM app_documents WHERE collection_path = $1 ORDER BY document_id LIMIT $2',
    [path, MAX_QUERY_SCAN],
  )
  let documents = result.rows.map(row => ({ path: `${path}/${row.document_id}`, id: row.document_id, data: row.data, revision: Number(row.revision) }))
  documents = documents.filter(document => filters.every(filter => matchesWhere(document.data, filter)))
  const cursor = cursors[0]
  if (cursor && typeof cursor.id === 'string') {
    documents = documents.filter(document => {
      const comparison = order ? compare(getField(document.data, String(order.field)), cursor.value) : 0
      const after = order?.direction === 'desc' ? comparison < 0 : comparison > 0
      return order ? after || (comparison === 0 && document.id.localeCompare(cursor.id as string) > 0) : document.id.localeCompare(cursor.id as string) > 0
    })
  }
  if (order) {
    const direction = order.direction === 'desc' ? -1 : 1
    documents.sort((a, b) => direction * compare(getField(a.data, String(order.field)), getField(b.data, String(order.field))) || a.id.localeCompare(b.id))
  }
  const visible: StoredDocument[] = []
  for (const document of documents) {
    if (await readable(client, actor, document.path, document.data)) visible.push(document)
    if (visible.length >= resultLimit) break
  }
  return visible
}

function mergeObject(base: JsonRecord, patch: JsonRecord): JsonRecord {
  const result: JsonRecord = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes('.')) {
      const keys = key.split('.')
      let target = result
      for (const part of keys.slice(0, -1)) {
        if (!isRecord(target[part])) target[part] = {}
        target = target[part] as JsonRecord
      }
      setValue(target, keys.at(-1)!, value)
    } else setValue(result, key, value)
  }
  return result
}
function setValue(target: JsonRecord, key: string, incoming: unknown): void {
  if (isRecord(incoming) && typeof incoming.__operation === 'string') {
    if (incoming.__operation === 'deleteField') { delete target[key]; return }
    if (incoming.__operation === 'serverTimestamp') {
      target[key] = { __type: 'timestamp', milliseconds: Date.now() }
      return
    }
    if (incoming.__operation === 'increment') {
      const amount = Number(incoming.value)
      if (!Number.isFinite(amount)) fail(400, 'Invalid increment')
      target[key] = (Number(target[key]) || 0) + amount
      return
    }
    fail(400, 'Unsupported field operation')
  }
  if (Array.isArray(incoming)) target[key] = incoming.map(item => resolveValue(item))
  else if (isRecord(incoming)) target[key] = resolveValue(incoming)
  else target[key] = incoming
}
function resolveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveValue)
  if (!isRecord(value)) return value
  if (value.__type === 'timestamp' && typeof value.milliseconds === 'number') return value
  if (typeof value.__operation === 'string') {
    const holder: JsonRecord = {}
    setValue(holder, 'value', value)
    return holder.value
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveValue(nested)]))
}
function applyWrite(current: JsonRecord | null, operation: WriteOperation): JsonRecord | null {
  if (operation.kind === 'delete') return null
  const data = operation.data ?? {}
  if (operation.kind === 'update' && !current) fail(404, 'Document not found')
  if (operation.kind === 'set' && !operation.merge) return resolveValue(data) as JsonRecord
  return mergeObject(current ? structuredClone(current) : {}, data)
}

async function tenantCanPublish(actor: Actor, data: JsonRecord | null): Promise<boolean> {
  if (!data || !actor.user) return false
  const membership = actor.memberships.get(String(data.tenantId ?? ''))
  return membership?.canPublish === true
}
async function canWrite(
  client: PoolClient,
  actor: Actor,
  operation: WriteOperation,
  current: JsonRecord | null,
  next: JsonRecord | null,
  writes: WriteOperation[],
  transaction: boolean,
): Promise<boolean> {
  const { parts } = documentPath(operation.path)
  if (actor.admin) return true
  if (!actor.user) return false
  if (parts[0] === 'users') {
    return parts[1] === actor.user.uid && parts[2] !== 'memberships' && parts[2] !== 'usage'
  }
  if (parts[0] === 'sharedPrompts' && parts.length === 2) {
    if (operation.kind === 'set' && !current) return next?.authorId === actor.user.uid && !next.tenantId
    if (!current || current.authorId !== actor.user.uid || current.tenantId) return false
    if (operation.kind === 'delete') return true
    const keys = Object.keys(operation.data ?? {})
    if (keys.length === 1 && keys[0] === 'usageCount') {
      return isRecord(operation.data?.usageCount) && operation.data?.usageCount.__operation === 'increment' && (current.isPublic !== false)
    }
    return keys.every(key => ['title', 'description', 'prompt', 'types', 'category', 'specialty', 'audience', 'tags', 'isAnonymous', 'authorName', 'outputFormat', 'languagePolicy', 'exampleOutput', 'isPublic', 'version', 'updatedAt', 'body'].includes(key))
  }
  if (parts[0] === 'tenantPrompts' && parts.length === 2) {
    if (operation.kind === 'set' && !current) return await tenantCanPublish(actor, next)
    if (!current || !ownsTenant(actor, current.tenantId)) return false
    if (operation.kind === 'delete') return await tenantCanPublish(actor, current)
    const keys = Object.keys(operation.data ?? {})
    if (keys.length === 1 && keys[0] === 'usageCount') {
      return isRecord(operation.data?.usageCount) && operation.data?.usageCount.__operation === 'increment'
    }
    return await tenantCanPublish(actor, current) && keys.every(key => ['title', 'description', 'prompt', 'types', 'category', 'specialty', 'audience', 'tags', 'isAnonymous', 'authorName', 'outputFormat', 'languagePolicy', 'exampleOutput', 'version', 'updatedAt'].includes(key))
  }
  if (parts[0] === 'featureRequests' && parts.length === 2) {
    if (operation.kind === 'set' && !current) {
      const ownerWrite = writes.find(item => item.path === `featureRequestOwners/${parts[1]}` && item.kind === 'set')
      return !!ownerWrite && ownerWrite.data?.authorId === actor.user.uid && next?.voteCount === 0
    }
    const owner = await readOwner(client, parts[1])
    if (!current || owner?.authorId !== actor.user.uid) return false
    if (operation.kind === 'delete') return false
    const keys = Object.keys(operation.data ?? {})
    if (keys.includes('voteCount')) return transaction && await validVotePair(client, actor, operation, writes)
    if (keys.every(key => ['title', 'description', 'category', 'displayAuthor', 'authorName', 'updatedAt'].includes(key))) return true
    return keys.every(key => ['visibility', 'hiddenReason', 'hiddenBy', 'updatedAt'].includes(key))
  }
  if (parts[0] === 'featureRequestOwners' && parts.length === 2) {
    if (operation.kind !== 'set' || current) return false
    const paired = writes.find(item => item.path === `featureRequests/${parts[1]}` && item.kind === 'set')
    return !!paired && next?.authorId === actor.user.uid && next.requestId === parts[1]
  }
  if (parts[0] === 'featureRequestVotes' && parts.length === 4) {
    return transaction && await validVotePair(client, actor, operation, writes)
  }
  if (parts[0] === 'templateBodies' && parts.length === 2) {
    if (operation.kind === 'set' && !current) return next?.ownerId === actor.user.uid
    return !!current && current.ownerId === actor.user.uid
  }
  if (parts[0] === 'templateBodies' && parts.length === 4 && parts[2] === 'chunks') {
    const manifest = await readStored(client, `templateBodies/${parts[1]}`)
    return !!manifest && manifest.data.ownerId === actor.user.uid
  }
  return false
}
function voteTarget(path: string): { uid: string; requestId: string } | null {
  const { parts } = documentPath(path)
  if (parts[0] !== 'featureRequestVotes' || parts.length !== 4 || parts[2] !== 'requests') return null
  return { uid: parts[1], requestId: parts[3] }
}
async function validVotePair(
  client: PoolClient,
  actor: Actor,
  operation: WriteOperation,
  writes: WriteOperation[],
): Promise<boolean> {
  let requestId: string | null = null
  const voteWrite = voteTarget(operation.path) ? operation : writes.find(item => voteTarget(item.path))
  const vote = voteWrite ? voteTarget(voteWrite.path) : null
  if (vote) requestId = vote.requestId
  else {
    const requestParts = partsOf(operation.path)
    if (requestParts[0] === 'featureRequests' && requestParts.length === 2) requestId = requestParts[1]
  }
  if (!requestId || !actor.user || !vote || vote.uid !== actor.user.uid) return false

  const pairedVotes = writes.filter(item => voteTarget(item.path)?.requestId === requestId)
  const requestWrites = writes.filter(item => item.path === `featureRequests/${requestId}` && item.kind === 'update')
  if (pairedVotes.length !== 1 || requestWrites.length !== 1 || !voteWrite || !vote) return false
  const requestWrite = requestWrites[0]
  const requestFields = Object.keys(requestWrite.data ?? {})
  const incrementOp = requestWrite.data?.voteCount
  if (requestFields.some(key => key !== 'voteCount' && key !== 'updatedAt')) return false
  if (!isRecord(incrementOp) || incrementOp.__operation !== 'increment') return false

  const existingVote = await readStored(client, voteWrite.path)
  const delta = voteWrite.kind === 'delete' ? -1 : 1
  if (Number(incrementOp.value) !== delta) return false
  const request = await readStored(client, `featureRequests/${requestId}`)
  const currentCount = request?.data.voteCount
  if (!request || !Number.isSafeInteger(currentCount) || Number(currentCount) + delta < 0) return false
  if (voteWrite.kind === 'delete') return !!existingVote
    && existingVote.data.userId === actor.user.uid
    && existingVote.data.requestId === requestId
    && Number(currentCount) > 0
  return !existingVote
    && voteWrite.kind === 'set'
    && voteWrite.data?.userId === actor.user.uid
    && voteWrite.data?.requestId === requestId
}

async function applyWrites(client: PoolClient, actor: Actor, writes: WriteOperation[], transaction: boolean): Promise<void> {
  if (!writes.length || writes.length > 500) fail(400, 'Invalid number of writes')
  const uniquePaths = [...new Set(writes.map(write => write.path))].sort()
  const currentByPath = new Map<string, JsonRecord | null>()
  for (const path of uniquePaths) currentByPath.set(path, (await readStored(client, path, true))?.data ?? null)
  const nextByPath = new Map<string, JsonRecord | null>(currentByPath)
  for (const operation of writes) {
    const current = nextByPath.get(operation.path) ?? null
    nextByPath.set(operation.path, applyWrite(current, operation))
  }
  for (const operation of writes) {
    const initial = currentByPath.get(operation.path) ?? null
    const next = nextByPath.get(operation.path) ?? null
    if (!await canWrite(client, actor, operation, initial, next, writes, transaction)) fail(403, 'Write is not allowed')
  }
  for (const operation of writes) {
    const parsed = documentPath(operation.path)
    const next = nextByPath.get(operation.path) ?? null
    if (!next) {
      await client.query('DELETE FROM app_documents WHERE collection_path = $1 AND document_id = $2', [parsed.collectionPath, parsed.id])
    } else {
      await client.query(
        `INSERT INTO app_documents (collection_path, document_id, data, revision, updated_at)
         VALUES ($1, $2, $3::jsonb, 1, NOW())
         ON CONFLICT (collection_path, document_id) DO UPDATE SET data = EXCLUDED.data,
           revision = app_documents.revision + 1, updated_at = NOW()`,
        [parsed.collectionPath, parsed.id, JSON.stringify(next)],
      )
    }
  }
}

async function handle(request: Request): Promise<Response> {
  try {
    const body = await parseBody(request)
    const operation = body.operation
    if (operation === 'get') {
      const parsed = documentPath((body.reference as JsonRecord | undefined)?.path)
      return await withDatabaseTransaction(async client => {
        const user = await getAppUser(request)
        const actor = await actorFor(client, user)
        const stored = await readStored(client, parsed.parts.join('/'))
        if (!stored || !await readable(client, actor, stored.path, stored.data)) return json({ document: null })
        return json({ document: stored })
      })
    }
    if (operation === 'query') {
      const user = await getAppUser(request)
      return await withDatabaseTransaction(async client => {
        const actor = await actorFor(client, user)
        const documents = await queryDocuments(client, actor, body.collectionPath, body.constraints)
        return json({ documents })
      })
    }
    if (operation !== 'write' && operation !== 'transaction') fail(400, 'Unknown operation')
    if (!isSameOriginWrite(request)) fail(403, 'Invalid request origin')
    const user = await getAppUser(request)
    if (!user) fail(401, 'Sign-in required')
    const writesRaw = body.writes
    if (!Array.isArray(writesRaw)) fail(400, 'Invalid writes')
    const writes = writesRaw.map(parseWrite)
    return await withDatabaseTransaction(async client => {
      const actor = await actorFor(client, user)
      if (operation === 'transaction') {
        if (!Array.isArray(body.reads) || body.reads.length > 500) fail(400, 'Invalid transaction reads')
        const reads = body.reads.map(read => {
          if (!isRecord(read)) fail(400, 'Invalid transaction read')
          const parsed = documentPath(read.path)
          return { path: parsed.parts.join('/'), revision: read.revision }
        }).sort((a, b) => a.path.localeCompare(b.path))
        for (const read of reads) {
          const stored = await readStored(client, read.path, true)
          const revision = stored?.revision ?? null
          if (revision !== read.revision) fail(409, 'Transaction conflict; retry the operation')
        }
      }
      await applyWrites(client, actor, writes, operation === 'transaction')
      return json({ ok: true })
    })
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status)
    return json({ error: 'Data service is temporarily unavailable' }, 503)
  }
}

export async function POST(request: Request): Promise<Response> { return handle(request) }
