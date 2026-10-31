import { fetchHealthData, fetchLegacyHealthData, uploadEncryptedAttachment, uploadEncryptedHealthData, type ClientEncryptedRecords } from './api';
import { decryptRecords, deriveVaultKey, encryptRecords, encryptWithVaultKey, validateVaultPassphrase } from './cryptoVault';
import { base64ToBytes } from './medicalAttachments';
import { emptyRecords, normalizeStoredRecords, RECORD_TYPES } from './recordStore';
import { mergeNHIJson } from './recordImport';
import { createVaultSession } from './vaultSession';

async function currentRecords(passphrase: string, signal?: AbortSignal) {
  validateVaultPassphrase(passphrase);
  signal?.throwIfAborted();
  const current = await fetchHealthData(signal);
  const records = current.envelope ? await decryptRecords(current.envelope, passphrase)
    : current.needsClientEncryptionMigration ? normalizeStoredRecords((await fetchLegacyHealthData(signal)).records) : emptyRecords();
  return { records, previous: current.envelope };
}

export async function unlockHealthData(passphrase: string, signal?: AbortSignal) {
  const { records, previous } = await currentRecords(passphrase, signal);
  if (!previous) throw new Error('尚未建立瀏覽器端加密資料，請先匯入或遷移既有資料');
  const key = await deriveVaultKey(passphrase, base64ToBytes(previous.salt), previous.iterations);
  return { data: createVaultSession(records, previous, key), envelope: previous };
}

export async function importHealthData(json: object, passphrase: string, confirmPatient = false, signal?: AbortSignal) {
  const { records: existing, previous } = await currentRecords(passphrase, signal);
  const { records, stats, pendingAttachments } = await mergeNHIJson(existing, json, { confirmPatient });
  const envelope = await encryptRecords(records, passphrase, previous);
  const key = await deriveVaultKey(passphrase, base64ToBytes(envelope.salt), envelope.iterations);
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

export async function migrateHealthData(passphrase: string, signal?: AbortSignal) {
  const { records, previous } = await currentRecords(passphrase, signal);
  if (previous) return unlockHealthData(passphrase, signal);
  const envelope: ClientEncryptedRecords = await encryptRecords(records, passphrase);
  const key = await deriveVaultKey(passphrase, base64ToBytes(envelope.salt), envelope.iterations);
  const data = createVaultSession(records, envelope, key);
  const stats = Object.fromEntries(RECORD_TYPES.map(type => [type, { added: Object.keys(records[type]).length, skipped: 0, updated: 0 }]));
  signal?.throwIfAborted();
  await uploadEncryptedHealthData(envelope, stats, null, signal);
  return { data, envelope };
}
