import { ApiError, fetchHealthData, fetchLegacyHealthData, uploadEncryptedAttachment, uploadEncryptedHealthData, type ClientEncryptedRecords } from './api';
import {
  decryptRecords, deriveVaultKey, encryptRecordsWithKey, encryptWithVaultKey, prepareVaultKey, validateVaultPassphrase, type VaultKey,
} from './cryptoVault';
import { base64ToBytes } from './medicalAttachments';
import { emptyRecords, normalizeStoredRecords, RECORD_TYPES, type StoredRecords } from './recordStore';
import { PatientConfirmationRequired, inspectImportIdentity, mergeNHIJson, mergePreparedImport } from './recordImport';
import { extractImportFile, scanImportFile, type LargeImportSink } from './streamImport';
import { createVaultSession } from './vaultSession';
import type { RecordShardUpload } from './recordShards';

async function currentRecords(passphrase: string, signal?: AbortSignal, onProgress?: (ratio: number) => void) {
  validateVaultPassphrase(passphrase);
  signal?.throwIfAborted();
  const current = await fetchHealthData(signal);
  const records = current.envelope ? await decryptRecords(current.envelope, passphrase, undefined, onProgress)
    : current.needsClientEncryptionMigration ? normalizeStoredRecords((await fetchLegacyHealthData(signal)).records) : emptyRecords();
  return { records, previous: current.envelope };
}

export async function unlockHealthData(passphrase: string, signal?: AbortSignal, onProgress?: (ratio: number) => void) {
  const { records, previous } = await currentRecords(passphrase, signal, onProgress);
  if (!previous) throw new Error('尚未建立瀏覽器端加密資料，請先匯入或遷移既有資料');
  const key = await deriveVaultKey(passphrase, base64ToBytes(previous.salt), previous.iterations);
  return { data: createVaultSession(records, previous, key), envelope: previous };
}

/** Shards are content-addressed, so a 409 means the identical ciphertext is already stored. */
function uploadShardWith(prepared: VaultKey, signal?: AbortSignal) {
  return async ({ id, bytes }: RecordShardUpload) => {
    const envelope = await encryptWithVaultKey(bytes, prepared.key, prepared);
    signal?.throwIfAborted();
    try {
      await uploadEncryptedAttachment(id, envelope, signal);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
  };
}

export async function importHealthData(json: object, passphrase: string, confirmPatient = false, signal?: AbortSignal) {
  const { records: existing, previous } = await currentRecords(passphrase, signal);
  const { records, stats, pendingAttachments } = await mergeNHIJson(existing, json, { confirmPatient });
  const prepared = await prepareVaultKey(passphrase, previous);
  const envelope = await encryptRecordsWithKey(records, prepared, { previous, signal, uploadShard: uploadShardWith(prepared, signal) });
  const key = prepared.key;
  // Parse the complete candidate before any write; failed parsing must not replace a working vault.
  const data = createVaultSession(records, envelope, key);
  for (const attachment of pendingAttachments) {
    const encrypted = await encryptWithVaultKey(base64ToBytes(attachment.data), key, envelope);
    signal?.throwIfAborted();
    await uploadEncryptedAttachment(attachment.id, encrypted, signal);
  }
  signal?.throwIfAborted();
  const result = await uploadEncryptedHealthData(envelope, stats, previous?.revision ?? null, signal);
  return { data, envelope, result };
}

export interface LargeImportPreview {
  file: File;
  existing: StoredRecords;
  previous: ClientEncryptedRecords | null;
  format: 'NHI' | 'FHIR';
  needsConfirmation: boolean;
}

/** First pass over a multi-gigabyte file: validate its shape without storing anything. */
export async function prepareLargeImport(
  file: File,
  passphrase: string,
  signal?: AbortSignal,
  onProgress?: (ratio: number) => void,
): Promise<LargeImportPreview> {
  const { records: existing, previous } = await currentRecords(passphrase, signal);
  const { format, needsConfirmation } = await scanImportFile(file, existing, signal, onProgress);
  return { file, existing, previous, format, needsConfirmation };
}

/** Second pass: stream, encrypt and upload the raw source plus every attachment, then commit the index. */
export async function commitLargeImport(
  preview: LargeImportPreview,
  passphrase: string,
  confirmPatient = false,
  signal?: AbortSignal,
  onProgress?: (ratio: number) => void,
) {
  const { file, existing, previous, format } = preview;
  // Refuse before spending a full streaming pass and orphaning encrypted chunks.
  if (preview.needsConfirmation && !confirmPatient) throw new PatientConfirmationRequired();
  const prepared = await prepareVaultKey(passphrase, previous);
  signal?.throwIfAborted();
  const sink: LargeImportSink = {
    async uploadSourceChunk({ id, bytes }) {
      const envelope = await encryptWithVaultKey(bytes, prepared.key, prepared);
      signal?.throwIfAborted();
      await uploadEncryptedAttachment(id, envelope, signal);
    },
    async uploadAttachment(attachment) {
      const envelope = await encryptWithVaultKey(base64ToBytes(attachment.data), prepared.key, prepared);
      signal?.throwIfAborted();
      await uploadEncryptedAttachment(attachment.id, envelope, signal);
    },
  };
  const extracted = await extractImportFile(file, format, existing, sink, signal, onProgress);
  signal?.throwIfAborted();
  const identity = inspectImportIdentity(existing, extracted.json);
  if (identity.needsConfirmation && !confirmPatient) throw new PatientConfirmationRequired();
  const { records, stats } = await mergePreparedImport(existing, {
    json: extracted.json,
    format: identity.format,
    needsConfirmation: identity.needsConfirmation,
    attachments: extracted.attachments,
    warnings: extracted.warnings,
    sourceId: extracted.sourceId,
    chunks: extracted.chunks,
  }, { confirmPatient });
  // Everything that can fail has run before the vault is replaced.
  const envelope = await encryptRecordsWithKey(records, prepared, { previous, signal, uploadShard: uploadShardWith(prepared, signal) });
  const data = createVaultSession(records, envelope, prepared.key);
  signal?.throwIfAborted();
  const result = await uploadEncryptedHealthData(envelope, stats, previous?.revision ?? null, signal);
  return { data, envelope, result };
}

export async function migrateHealthData(passphrase: string, signal?: AbortSignal, onProgress?: (ratio: number) => void) {
  const { records, previous } = await currentRecords(passphrase, signal, onProgress);
  if (previous) return unlockHealthData(passphrase, signal, onProgress);
  const prepared = await prepareVaultKey(passphrase);
  const envelope: ClientEncryptedRecords = await encryptRecordsWithKey(records, prepared, { signal, uploadShard: uploadShardWith(prepared, signal) });
  const key = await deriveVaultKey(passphrase, base64ToBytes(envelope.salt), envelope.iterations);
  const data = createVaultSession(records, envelope, key);
  const stats = Object.fromEntries(RECORD_TYPES.map(type => [type, { added: Object.keys(records[type]).length, skipped: 0, updated: 0 }]));
  signal?.throwIfAborted();
  await uploadEncryptedHealthData(envelope, stats, null, signal);
  return { data, envelope };
}
