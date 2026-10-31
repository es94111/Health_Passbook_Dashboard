import crypto from 'node:crypto';
import type { PreparedBackup } from './backupTransfer.js';

interface Download {
  owner: string;
  backup: PreparedBackup;
  active: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Authenticated, short-lived, resumable native downloads; never expose disk paths. */
export class BackupDownloads {
  private readonly downloads = new Map<string, Download>();
  private readonly preparing = new Set<string>();
  constructor(private readonly ttlMs = 30 * 60 * 1000, private readonly capacity = 4) {}

  private arm(token: string, entry: Download): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.active) this.arm(token, entry);
      else {
        this.downloads.delete(token);
        entry.backup.cleanup().catch(() => undefined);
      }
    }, this.ttlMs);
    entry.timer.unref();
  }

  async prepare(owner: string, create: () => Promise<PreparedBackup>): Promise<{ token: string; backup: PreparedBackup }> {
    if (this.preparing.has(owner) || [...this.downloads.values()].some((entry) => entry.owner === owner && entry.active)) {
      throw Object.assign(new Error('已有備份正在準備或下載，請稍後再試'), { status: 409 });
    }
    this.preparing.add(owner);
    try {
      // Replacing an idle ticket for the same owner must not count against capacity.
      for (const [token, entry] of this.downloads) {
        if (entry.owner === owner) {
          clearTimeout(entry.timer);
          this.downloads.delete(token);
          await entry.backup.cleanup();
        }
      }
      if (this.downloads.size + this.preparing.size > this.capacity) {
        throw Object.assign(new Error('備份暫存已滿，請稍後再試'), { status: 503 });
      }
      const backup = await create();
      const token = crypto.randomBytes(32).toString('hex');
      const entry = { owner, backup, active: 0, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      this.downloads.set(token, entry);
      this.arm(token, entry);
      return { token, backup };
    } finally { this.preparing.delete(owner); }
  }

  acquire(token: string, owner: string): { backup: PreparedBackup; release(): void } | null {
    const entry = this.downloads.get(token);
    if (!entry || entry.owner !== owner) return null;
    entry.active++;
    this.arm(token, entry);
    let released = false;
    return {
      backup: entry.backup,
      release: () => {
        if (released) return;
        released = true;
        entry.active--;
        this.arm(token, entry);
      },
    };
  }

  async dispose(): Promise<void> {
    for (const entry of this.downloads.values()) {
      clearTimeout(entry.timer);
      await entry.backup.cleanup();
    }
    this.downloads.clear();
  }
}
