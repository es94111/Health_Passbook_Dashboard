export const MAX_BACKUP_JSON_BYTES = 20_000_000_000;
export const MAX_BACKUP_VALUE_BYTES = 64 * 1024 * 1024;

export class BackupSizeError extends Error {
  readonly status = 413;
  readonly code = 'BACKUP_TOO_LARGE';
  readonly limitBytes = MAX_BACKUP_JSON_BYTES;

  constructor() {
    super('備份超過 20 GB（20000000000 bytes）的 UTF-8 JSON 上限（包含所有使用者、Base64 加密附件及中繼資料）。請保留現有健康資料；超過上限時，請停止服務後以安全方式離線備份完整加密資料目錄及加密金鑰。');
    this.name = 'BackupSizeError';
  }
}

export function assertBackupByteLength(bytes: number): void {
  if (bytes > MAX_BACKUP_JSON_BYTES) throw new BackupSizeError();
}

export function backupJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
}
