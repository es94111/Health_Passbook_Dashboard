export type DocumentData = Record<string, any>
export type Unsubscribe = () => void
export type Firestore = { readonly kind: 'postgres-document-store' }
export const db: Firestore = Object.freeze({ kind: 'postgres-document-store' })

export class Timestamp {
  private readonly milliseconds: number

  constructor(seconds: number, nanoseconds = 0) {
    this.milliseconds = seconds * 1000 + nanoseconds / 1_000_000
  }

  static now(): Timestamp { return Timestamp.fromDate(new Date()) }
  static fromDate(date: Date): Timestamp { return Timestamp.fromMillis(date.getTime()) }
  static fromMillis(milliseconds: number): Timestamp { return new Timestamp(Math.floor(milliseconds / 1000), (milliseconds % 1000) * 1_000_000) }
  toDate(): Date { return new Date(this.milliseconds) }
  toMillis(): number { return this.milliseconds }
  toJSON(): { __type: 'timestamp'; milliseconds: number } { return { __type: 'timestamp', milliseconds: this.milliseconds } }
}

export interface DocumentReference<_T = DocumentData> {
  readonly kind: 'document'
  readonly collectionPath: string
  readonly id: string
  readonly path: string
}

export interface CollectionReference<_T = DocumentData> {
  readonly kind: 'collection'
  readonly path: string
}

interface FilterConstraint { type: 'where'; field: string; operator: string; value: unknown }
interface OrderConstraint { type: 'orderBy'; field: string; direction: 'asc' | 'desc' }
interface LimitConstraint { type: 'limit'; count: number }
interface CursorConstraint { type: 'startAfter'; id: string; value?: unknown }
type Constraint = FilterConstraint | OrderConstraint | LimitConstraint | CursorConstraint

export interface Query<_T = DocumentData> {
  readonly kind: 'query'
  readonly collectionPath: string
  readonly constraints: Constraint[]
}
export type QueryConstraint = Constraint

export interface DocumentSnapshot<T = DocumentData> {
  readonly id: string
  readonly ref: DocumentReference<T>
  readonly metadata: { fromCache: boolean; hasPendingWrites: boolean }
  exists(): boolean
  data(): T | undefined
  get(field: string): unknown
}

export interface QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  exists(): true
  data(): T
  readonly queryOrderField?: string
  readonly version?: number
}

export interface QuerySnapshot<T = DocumentData> {
  readonly docs: QueryDocumentSnapshot<T>[]
  readonly size: number
  readonly empty: boolean
  forEach(callback: (snapshot: QueryDocumentSnapshot<T>) => void): void
}

export interface Transaction {
  get<T = DocumentData>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T>>
  set<T = DocumentData>(reference: DocumentReference<T>, data: T, options?: { merge?: boolean }): this
  update(reference: DocumentReference, data: DocumentData): this
  delete(reference: DocumentReference): this
}

const marker = (operation: string, value?: unknown) => ({ __operation: operation, ...(value === undefined ? {} : { value }) })
export const serverTimestamp = () => marker('serverTimestamp')
export const increment = (value: number) => marker('increment', value)
export const deleteField = () => marker('deleteField')

function segments(...parts: string[]): string[] {
  return parts.flatMap(part => part.split('/')).filter(Boolean)
}

function makeDocument(path: string): DocumentReference {
  const parts = segments(path)
  if (parts.length < 2 || parts.length % 2 !== 0) throw new Error(`Invalid document path: ${path}`)
  const id = parts[parts.length - 1]
  return { kind: 'document', collectionPath: parts.slice(0, -1).join('/'), id, path: parts.join('/') }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().replaceAll('-', '')
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

export function collection(parent: Firestore | DocumentReference | CollectionReference, ...path: string[]): CollectionReference {
  const base = 'kind' in parent && parent.kind === 'document' ? parent.path : ''
  const fullPath = segments(base, ...path).join('/')
  if (!fullPath || segments(fullPath).length % 2 !== 1) throw new Error(`Invalid collection path: ${fullPath}`)
  return { kind: 'collection', path: fullPath }
}

export function doc(parent: Firestore | DocumentReference | CollectionReference, ...path: string[]): DocumentReference {
  if (parent.kind === 'document' && path.length === 0) return parent as DocumentReference
  const base = parent.kind === 'document' || parent.kind === 'collection' ? parent.path : ''
  const joined = segments(base, ...path).join('/')
  if (parent.kind === 'collection' && path.length === 0) return makeDocument(`${joined}/${randomId()}`)
  return makeDocument(joined)
}

export function query<T = DocumentData>(reference: CollectionReference<T> | Query<T>, ...constraints: QueryConstraint[]): Query<T> {
  const existing = reference.kind === 'query' ? reference.constraints : []
  return { kind: 'query', collectionPath: reference.kind === 'query' ? reference.collectionPath : reference.path, constraints: [...existing, ...constraints] }
}

export function where(field: string, operator: string, value: unknown): QueryConstraint {
  return { type: 'where', field, operator, value }
}
export function orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): QueryConstraint {
  return { type: 'orderBy', field, direction }
}
export function limit(count: number): QueryConstraint {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid query limit')
  return { type: 'limit', count }
}
export function startAfter(snapshot: QueryDocumentSnapshot): QueryConstraint {
  const order = snapshot.queryOrderField
  return { type: 'startAfter', id: snapshot.id, ...(order ? { value: snapshot.get(order) } : {}) }
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.__type === 'timestamp' && typeof record.milliseconds === 'number') return Timestamp.fromMillis(record.milliseconds)
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, revive(item)]))
  }
  return value
}

function fieldValue(data: unknown, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, data)
}

function documentSnapshot<T>(record: { id: string; path: string; data?: T; revision?: number }, orderField?: string): QueryDocumentSnapshot<T> {
  const ref = makeDocument(record.path) as DocumentReference<T>
  const data = revive(record.data) as T
  const snapshot = {
    id: record.id,
    ref,
    metadata: { fromCache: false, hasPendingWrites: false },
    queryOrderField: orderField,
    version: record.revision,
    exists: () => record.data !== undefined,
    data: () => data,
    get: (field: string) => fieldValue(data, field),
  }
  return snapshot as QueryDocumentSnapshot<T>
}

function missingSnapshot<T>(reference: DocumentReference<T>): DocumentSnapshot<T> {
  return {
    id: reference.id,
    ref: reference,
    metadata: { fromCache: false, hasPendingWrites: false },
    exists: () => false,
    data: () => undefined,
    get: () => undefined,
  }
}

function querySnapshot<T>(documents: QueryDocumentSnapshot<T>[]): QuerySnapshot<T> {
  return {
    docs: documents,
    size: documents.length,
    empty: documents.length === 0,
    forEach: callback => documents.forEach(callback),
  }
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/data', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new Error(result.error || `Data request failed (${response.status})`)
  return result
}

function referencePayload(reference: DocumentReference): { path: string; collectionPath: string; id: string } {
  return { path: reference.path, collectionPath: reference.collectionPath, id: reference.id }
}

export async function getDoc<T = DocumentData>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const result = await post<{ document: { id: string; path: string; data: T; revision: number } | null }>({
    operation: 'get', reference: referencePayload(reference),
  })
  return result.document ? documentSnapshot<T>(result.document) : missingSnapshot(reference)
}

export async function getDocs<T = DocumentData>(reference: CollectionReference<T> | Query<T>): Promise<QuerySnapshot<T>> {
  const queryRef = reference.kind === 'query' ? reference : query(reference)
  const order = queryRef.constraints.find(item => item.type === 'orderBy') as OrderConstraint | undefined
  const result = await post<{ documents: Array<{ id: string; path: string; data: T; revision: number }> }>({
    operation: 'query', collectionPath: queryRef.collectionPath, constraints: queryRef.constraints,
  })
  return querySnapshot(result.documents.map(record => documentSnapshot<T>(record, order?.field)))
}

async function write(operations: Array<Record<string, unknown>>): Promise<void> {
  await post({ operation: 'write', writes: operations })
}

export async function setDoc<T = DocumentData>(reference: DocumentReference<T>, data: T, options: { merge?: boolean } = {}): Promise<void> {
  await write([{ kind: 'set', ...referencePayload(reference), data, merge: options.merge === true }])
}
export async function updateDoc(reference: DocumentReference, data: DocumentData): Promise<void> {
  await write([{ kind: 'update', ...referencePayload(reference), data }])
}
export async function deleteDoc(reference: DocumentReference): Promise<void> {
  await write([{ kind: 'delete', ...referencePayload(reference) }])
}
export async function addDoc<T = DocumentData>(reference: CollectionReference<T>, data: T): Promise<DocumentReference<T>> {
  const document = doc(reference) as DocumentReference<T>
  await setDoc(document, data)
  return document
}

export interface WriteBatch {
  set(reference: DocumentReference, data: DocumentData, options?: { merge?: boolean }): WriteBatch
  update(reference: DocumentReference, data: DocumentData): WriteBatch
  delete(reference: DocumentReference): WriteBatch
  commit(): Promise<void>
}

export function writeBatch(_database: Firestore): WriteBatch {
  const writes: Array<Record<string, unknown>> = []
  const batch: WriteBatch = {
    set(reference, data, options = {}) { writes.push({ kind: 'set', ...referencePayload(reference), data, merge: options.merge === true }); return batch },
    update(reference, data) { writes.push({ kind: 'update', ...referencePayload(reference), data }); return batch },
    delete(reference) { writes.push({ kind: 'delete', ...referencePayload(reference) }); return batch },
    async commit() { if (writes.length) await write(writes) },
  }
  return batch
}

export async function runTransaction<T>(_database: Firestore, update: (transaction: Transaction) => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const reads = new Map<string, { reference: DocumentReference; revision: number | null }>()
    const writes: Array<Record<string, unknown>> = []
    const transaction: Transaction = {
      async get<TData = DocumentData>(reference: DocumentReference<TData>) {
        const snapshot = await getDoc(reference)
        const version = (snapshot as DocumentSnapshot<TData> & { version?: number }).version
        reads.set(reference.path, { reference, revision: snapshot.exists() ? version ?? 1 : null })
        return snapshot
      },
      set(reference, data, options = {}) { writes.push({ kind: 'set', ...referencePayload(reference), data, merge: options.merge === true }); return transaction },
      update(reference, data) { writes.push({ kind: 'update', ...referencePayload(reference), data }); return transaction },
      delete(reference) { writes.push({ kind: 'delete', ...referencePayload(reference) }); return transaction },
    }
    const result = await update(transaction)
    try {
      await post({ operation: 'transaction', reads: [...reads.values()].map(({ reference, revision }) => ({ ...referencePayload(reference), revision })), writes })
      return result
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Transaction conflict') || attempt === maxAttempts - 1) throw error
    }
  }
  throw new Error('Transaction failed')
}

export function onSnapshot<T = DocumentData>(
  reference: DocumentReference<T>,
  callback: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: Error) => void,
): Unsubscribe
export function onSnapshot<T = DocumentData>(
  reference: DocumentReference<T>,
  options: { includeMetadataChanges?: boolean },
  callback: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: Error) => void,
): Unsubscribe
export function onSnapshot<T = DocumentData>(
  reference: CollectionReference<T> | Query<T>,
  callback: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: Error) => void,
): Unsubscribe
export function onSnapshot<T = DocumentData>(
  reference: CollectionReference<T> | Query<T>,
  options: { includeMetadataChanges?: boolean },
  callback: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: Error) => void,
): Unsubscribe
export function onSnapshot<T = DocumentData>(
  reference: DocumentReference<T> | CollectionReference<T> | Query<T>,
  callbackOrOptions: ((...args: never[]) => void) | { includeMetadataChanges?: boolean },
  callbackOrError?: (...args: never[]) => void,
  errorCallback?: (error: Error) => void,
): Unsubscribe {
  const callback = typeof callbackOrOptions === 'function'
    ? callbackOrOptions as (snapshot: DocumentSnapshot<T> | QuerySnapshot<T>) => void
    : callbackOrError as ((snapshot: DocumentSnapshot<T> | QuerySnapshot<T>) => void)
  const onError = typeof callbackOrOptions === 'function' ? callbackOrError as ((error: Error) => void) | undefined : errorCallback
  if (!callback) throw new Error('A snapshot callback is required')
  let active = true
  let previous = ''
  const refresh = async () => {
    try {
      const snapshot = reference.kind === 'document'
        ? await getDoc(reference)
        : await getDocs(reference.kind === 'query' ? reference : query(reference))
      const key = JSON.stringify(snapshot, (_property, value) => value instanceof Timestamp ? value.toMillis() : value)
      if (!active || key === previous) return
      previous = key
      callback(snapshot)
    } catch (error) {
      if (active) onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 5000)
  return () => { active = false; clearInterval(timer) }
}
