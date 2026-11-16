import { Pool, type PoolClient } from 'pg'
import { resolveSecret } from '@/src/server/ai-self-secrets'

const DEFAULT_DATABASE_URL_PATH = 'kv/apps/mediprisma/database/url'
let pool: Pool | undefined
let poolUrl: string | undefined
let schemaReady: Promise<void> | undefined

export async function getDatabasePool(): Promise<Pool> {
  const connectionString = await resolveSecret(
    process.env.OPENBAO_DATABASE_URL_PATH || DEFAULT_DATABASE_URL_PATH,
    'DATABASE_URL',
  )
  if (!connectionString) throw new Error('PostgreSQL connection string is not configured')
  if (!pool || poolUrl !== connectionString) {
    const previous = pool
    pool = new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX || 10) })
    poolUrl = connectionString
    schemaReady = undefined
    if (previous) void previous.end().catch(() => {})
  }
  return pool
}

export async function ensureDatabaseSchema(): Promise<void> {
  const database = await getDatabasePool()
  if (!schemaReady) {
    schemaReady = database.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        uid TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        display_name TEXT,
        photo_url TEXT,
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY,
        uid TEXT NOT NULL REFERENCES app_users(uid) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS app_sessions_uid_idx ON app_sessions(uid);
      CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS app_documents (
        collection_path TEXT NOT NULL,
        document_id TEXT NOT NULL,
        data JSONB NOT NULL,
        revision BIGINT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (collection_path, document_id)
      );
      CREATE INDEX IF NOT EXISTS app_documents_path_idx ON app_documents(collection_path);
    `).then(() => undefined).catch((error) => {
      schemaReady = undefined
      throw error
    })
  }
  await schemaReady
}

export async function withDatabaseTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await ensureDatabaseSchema()
  const client = await (await getDatabasePool()).connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
