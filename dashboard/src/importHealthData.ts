import { fetchHealthData, fetchLegacyHealthData, uploadEncryptedAttachment, uploadEncryptedHealthData, type ClientEncryptedRecords } from './api';
import {
  decryptRecords, deriveVaultKey, encryptRecordsWithKey, encryptWithVaultKey, prepareVaultKey, validateVaultPassphrase,
} from './cryptoVault';
import { base64ToBytes, type PendingAttachment } from './medicalAttachments';
import { buildMergedPreview, buildScannedPreview, recordsTotal, type ImportPreview } from './importPreview';
import { parseNHIJson } from './parsers/nhi-parser';
import { emptyRecords, flattenRecords, normalizeStoredRecords, RECORD_TYPES, type MergeStats, type StoredRecords } from './recordStore';
import { PatientConfirmationRequired, inspectImportIdentity, mergeNHIJson, mergePreparedImport } from './recordImport';
import { extractImportFile, scanImportFile, type LargeImportSink } from './streamImport';
import { createVaultSession, uploadShardWith } from './vaultSession';

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

/** Shared tail: encrypt the merged records, ship attachments, then replace the vault index. */
async function commitRecords(
  records: StoredRecords,
  pendingAttachments: readonly PendingAttachment[],
  stats: MergeStats,
  previous: ClientEncryptedRecords | null,
  passphrase: string,
  signal?: AbortSignal,
) {
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

export async function importHealthData(json: object, passphrase: string, confirmPatient = false, signal?: AbortSignal) {
  const { records: existing, previous } = await currentRecords(passphrase, signal);
  const { records, stats, pendingAttachments } = await mergeNHIJson(existing, json, { confirmPatient });
  return commitRecords(records, pendingAttachments, stats, previous, passphrase, signal);
}

export interface PreparedJsonImport {
  json: object;
  existing: StoredRecords;
  previous: ClientEncryptedRecords | null;
  records: StoredRecords;
  stats: MergeStats;
  pendingAttachments: PendingAttachment[];
  needsConfirmation: boolean;
  preview: ImportPreview;
}

/**
 * Dry run for files small enough to hold in memory: merge without writing anything so the
 * user can review dates, counts and attachments before the vault is touched.
 */
export async function prepareJsonImport(
  json: object,
  passphrase: string,
  file: File,
  signal?: AbortSignal,
): Promise<PreparedJsonImport> {
  const { records: existing, previous } = await currentRecords(passphrase, signal);
  signal?.throwIfAborted();
  const identity = inspectImportIdentity(existing, json);
  // confirmPatient: true keeps the dry run side-effect free; the real gate is the preview checkbox.
  const { records, stats, pendingAttachments } = await mergeNHIJson(existing, json, { confirmPatient: true });
  signal?.throwIfAborted();
  const data = parseNHIJson(flattenRecords(records));
  const preview = buildMergedPreview({
    fileName: file.name,
    fileSize: file.size,
    format: identity.format,
    needsConfirmation: identity.needsConfirmation,
    stats,
    records,
    data,
    warnings: [],
  });
  return { json, existing, previous, records, stats, pendingAttachments, needsConfirmation: identity.needsConfirmation, preview };
}

/** Commits a previewed in-memory import; the preview itself wrote nothing. */
export async function commitPreparedJsonImport(
  prepared: PreparedJsonImport,
  passphrase: string,
  confirmPatient = false,
  signal?: AbortSignal,
) {
  if (prepared.needsConfirmation && !confirmPatient) throw new PatientConfirmationRequired();
  signal?.throwIfAborted();
  return commitRecords(prepared.records, prepared.pendingAttachments, prepared.stats, prepared.previous, passphrase, signal);
}

export interface LargeImportPreview {
  file: File;
  existing: StoredRecords;
  previous: ClientEncryptedRecords | null;
  format: 'NHI' | 'FHIR';
  needsConfirmation: boolean;
  preview: ImportPreview;
}

/** First pass over a multi-gigabyte file: validate its shape without storing anything. */
export async function prepareLargeImport(
  file: File,
  passphrase: string,
  signal?: AbortSignal,
  onProgress?: (ratio: number) => void,
): Promise<LargeImportPreview> {
  const { records: existing, previous } = await currentRecords(passphrase, signal);
  const { format, needsConfirmation, summary } = await scanImportFile(file, existing, signal, onProgress);
  const preview = buildScannedPreview({
    fileName: file.name,
    fileSize: file.size,
    format,
    needsConfirmation,
    summary,
    existingTotal: recordsTotal(existing),
  });
  return { file, existing, previous, format, needsConfirmation, preview };
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
