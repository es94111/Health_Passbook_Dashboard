import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import type { AppSettings, UserInfo, LoginLog, ImportStats, SystemInfo, SystemUpdateState } from '../api';
import {
  ApiError,
  fetchAdminSettings,
  updateAdminSettings,
  listUsers,
  createUser,
  deleteUser,
  fetchAdminLoginLogs,
  deleteAdminLoginLogs,
  prepareBackup,
  startBackupDownload,
  importBackup,
  readBackupHeader,
  fetchSystemInfo,
  triggerSystemUpdate,
  MAX_BACKUP_BYTES,
} from '../api';

const PASSWORD_MIN_LENGTH = 12;

// ── System settings section ───────────────────────────────────────────────────

function SystemSettingsSection() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Local edit state
  const [publicReg, setPublicReg] = useState(false);
  const [emailList, setEmailList] = useState('');
  const [ipList, setIpList] = useState('');

  useEffect(() => {
    fetchAdminSettings()
      .then((s) => {
        setSettings(s);
        setPublicReg(s.publicRegistration);
        setEmailList(s.allowedRegistrationEmails.join('\n'));
        setIpList(s.adminIpAllowlist.join('\n'));
      })
      .catch(() => setError('無法載入設定'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const updated = await updateAdminSettings({
        publicRegistration: publicReg,
        allowedRegistrationEmails: emailList.split('\n').map((s) => s.trim()).filter(Boolean),
        adminIpAllowlist: ipList.split('\n').map((s) => s.trim()).filter(Boolean),
      });
      setSettings(updated);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="card"><p className="text-sm text-gray-400">載入中…</p></section>;

  return (
    <section className="card">
      <h2 className="section-title">系統設定</h2>
      <div className="mt-3 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">開放公開註冊</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">允許任何人自行建立帳號</p>
          </div>
          <button
            onClick={() => setPublicReg(!publicReg)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              publicReg ? 'bg-teal-500' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                publicReg ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        <div>
          <label className="label">白名單電子郵件（每行一個，限 Google 登入）</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
            設定後，只有這些 email 的 Google 帳號可以自動註冊。留空代表不限制。
          </p>
          <textarea
            value={emailList}
            onChange={(e) => setEmailList(e.target.value)}
            rows={4}
            className="input w-full font-mono text-xs"
            placeholder="user@example.com&#10;another@example.com"
          />
        </div>

        <div>
          <label className="label">管理員 IP 白名單（每行一個）</label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
            限制可存取管理員功能的 IP 位址。留空代表不限制。
          </p>
          <textarea
            value={ipList}
            onChange={(e) => setIpList(e.target.value)}
            rows={3}
            className="input w-full font-mono text-xs"
            placeholder="192.168.1.100&#10;203.0.113.0"
          />
        </div>

        <div className="flex items-center gap-3">
          <button onClick={handleSave} disabled={saving} className="btn-primary">
            {saving ? '儲存中…' : '儲存設定'}
          </button>
          {success && (
            <span className="text-green-600 dark:text-green-400 text-sm msg-fade" aria-live="polite">已儲存</span>
          )}
          {error && (
            <span className="text-red-500 text-sm msg-fade" role="alert">{error}</span>
          )}
        </div>

        {settings && (
          <p className="text-xs text-gray-400">
            目前狀態：{settings.publicRegistration ? '開放公開註冊' : '停用公開註冊'}
            {settings.allowedRegistrationEmails.length > 0 && `、${settings.allowedRegistrationEmails.length} 個白名單 email`}
            {settings.adminIpAllowlist.length > 0 && `、${settings.adminIpAllowlist.length} 個 IP 白名單`}
          </p>
        )}
      </div>
    </section>
  );
}

// ── System update section (Watchtower sidecar) ────────────────────────────────

const UPDATE_STATE_LABEL: Record<SystemUpdateState, string> = {
  idle: '尚無更新紀錄',
  pending: '等待重新啟動',
  restarted: '已重新啟動',
  failed: '更新失敗',
  unknown: '狀態未知',
};

const UPDATE_STATE_STYLE: Record<SystemUpdateState, string> = {
  idle: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  restarted: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  unknown: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

function formatSystemTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-TW', { hour12: false });
}

function SystemUpdateSection() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [updating, setUpdating] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    fetchSystemInfo()
      .then(setInfo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '無法載入系統資訊'))
      .finally(() => setLoading(false));
  }, []);

  async function waitForRestart(baselineStartedAt: string) {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!alive.current) return;
      try {
        const next = await fetchSystemInfo();
        if (!alive.current) return;
        setInfo(next);
        if (next.startedAt !== baselineStartedAt) {
          setNotice(
            next.update.state === 'pending' || next.update.state === 'unknown'
              ? '服務已重新啟動，但更新狀態尚未寫入，請稍後重新整理確認。'
              : '更新完成：服務已重新啟動，請重新整理頁面以載入新版本。',
          );
          return;
        }
      } catch (e) {
        if (!alive.current) return;
        if (e instanceof ApiError && e.status === 401) {
          setError('服務已重新啟動，但登入狀態已失效，請重新整理並重新登入。');
          return;
        }
        setNotice('服務連線中斷，可能正在重新啟動，等待恢復…');
      }
    }
    if (alive.current) {
      setNotice('尚未偵測到服務重新啟動。可能已是最新版本，或 Watchtower 仍在處理，請稍後重新整理確認。');
    }
  }

  async function handleUpdate() {
    if (!info || updating || password.length === 0) return;
    setUpdating(true);
    setError('');
    setNotice('');
    const baselineStartedAt = info.startedAt;
    try {
      const result = await triggerSystemUpdate(password);
      setPassword('');
      setConfirming(false);
      setInfo((prev) => (prev ? { ...prev, update: result.update } : prev));
      setNotice(result.message);
      await waitForRestart(baselineStartedAt);
      if (alive.current) {
        try {
          setInfo(await fetchSystemInfo());
        } catch {
          // The panel keeps the last known state; the notice already explains it.
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新請求失敗');
    } finally {
      if (alive.current) setUpdating(false);
    }
  }

  if (loading) return <section className="card"><p className="text-sm text-gray-400">載入中…</p></section>;

  if (!info) {
    return (
      <section className="card">
        <h2 className="section-title">系統更新</h2>
        <p className="mt-3 text-sm text-red-500" role="alert">{error || '無法載入系統資訊'}</p>
      </section>
    );
  }

  const configured = info.watchtowerConfigured;
  const update = info.update;
  const busy = updating || update.state === 'pending';

  return (
    <section className="card">
      <h2 className="section-title">系統更新</h2>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        透過 Watchtower 從網頁檢查並更新 Docker image。更新期間服務會中斷數十秒，完成後需重新整理頁面。
      </p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-gray-500 dark:text-gray-400">目前版本</dt>
          <dd className="text-sm font-medium text-gray-800 dark:text-gray-200 font-mono">{info.version}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500 dark:text-gray-400">Container Image</dt>
          <dd className="text-sm text-gray-800 dark:text-gray-200 font-mono break-all">{info.image ?? '未設定 APP_IMAGE'}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500 dark:text-gray-400">服務啟動時間</dt>
          <dd className="text-sm text-gray-800 dark:text-gray-200">{formatSystemTime(info.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500 dark:text-gray-400">Watchtower 連線</dt>
          <dd className="mt-0.5">
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              configured
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
            }`}>
              {configured ? '已設定' : '未設定'}
            </span>
          </dd>
        </div>
      </dl>

      {!configured && (
        <div className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-900/20 p-3">
          <p className="text-sm text-amber-800 dark:text-amber-300">尚未設定 Watchtower，無法從網頁更新。</p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            請在伺服器環境變數設定 <code className="font-mono">WATCHTOWER_URL</code> 與{' '}
            <code className="font-mono">WATCHTOWER_TOKEN</code>，並以 HTTP API 模式啟動 Watchtower（詳見 README）。
          </p>
        </div>
      )}

      {update.state !== 'idle' && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <span className={`px-1.5 py-0.5 rounded-full ${UPDATE_STATE_STYLE[update.state]}`}>
            {UPDATE_STATE_LABEL[update.state]}
          </span>
          <span>要求時間：{formatSystemTime(update.requestedAt)}</span>
          {update.requestedBy && <span>操作者：{update.requestedBy}</span>}
          {update.message && <span className="w-full">{update.message}</span>}
        </div>
      )}

      {configured && (
        <div className="mt-4">
          {confirming ? (
            <div className="space-y-2">
              <label className="label" htmlFor="system-update-password">請輸入管理員密碼確認更新</label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="system-update-password"
                  type="password"
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleUpdate(); }}
                  autoComplete="current-password"
                  disabled={updating}
                />
                <button onClick={() => void handleUpdate()} disabled={updating || password.length === 0} className="btn-danger">
                  {updating ? '更新中…' : '確認更新'}
                </button>
                <button
                  onClick={() => { setConfirming(false); setPassword(''); }}
                  disabled={updating}
                  className="btn-secondary"
                >
                  取消
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                更新會重新啟動服務，進行中的操作將被中斷。
              </p>
            </div>
          ) : (
            <button onClick={() => setConfirming(true)} disabled={busy} className="btn-primary">
              {busy ? '等待服務重新啟動…' : '更新 Docker Image'}
            </button>
          )}
        </div>
      )}

      {notice && (
        <p className="mt-3 text-sm text-teal-600 dark:text-teal-400" aria-live="polite">{notice}</p>
      )}
      {error && (
        <p className="mt-3 text-sm text-red-500" role="alert">{error}</p>
      )}
    </section>
  );
}

// ── Create user section ───────────────────────────────────────────────────────

function CreateUserSection({ onCreated }: { onCreated: (user: UserInfo) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function handleCreate() {
    if (!username || username.length < 3 || username.length > 32) {
      setError('帳號長度需在 3-32 字元之間');
      return;
    }
    if (!password || password.length < PASSWORD_MIN_LENGTH) {
      setError(`密碼至少 ${PASSWORD_MIN_LENGTH} 個字元`);
      return;
    }
    setError('');
    setCreating(true);
    try {
      const user = await createUser(username, password, isAdmin);
      onCreated(user);
      setUsername('');
      setPassword('');
      setIsAdmin(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="card">
      <h2 className="section-title">新增使用者</h2>
      <div className="mt-3 space-y-2">
        <input
          id="new-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="input w-full"
          placeholder="帳號（3-32 字元）"
          autoComplete="off"
          aria-label="新使用者帳號"
          minLength={3}
          maxLength={32}
        />
        <input
          id="new-user-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input w-full"
          placeholder={`密碼（至少 ${PASSWORD_MIN_LENGTH} 個字元）`}
          autoComplete="new-password"
          aria-label="新使用者密碼"
          minLength={PASSWORD_MIN_LENGTH}
        />
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => setIsAdmin(e.target.checked)}
          />
          設為管理員
        </label>
        <button onClick={handleCreate} disabled={creating} className="btn-primary">
          {creating ? '建立中…' : '建立帳號'}
        </button>
        {error && <p className="text-red-500 text-xs msg-fade" role="alert">{error}</p>}
      </div>
    </section>
  );
}

// ── User management section ───────────────────────────────────────────────────

function UserManagementSection({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function fetchUsers() {
    listUsers()
      .then(setUsers)
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchUsers();
  }, []);

  function handleCreated(user: UserInfo) {
    setUsers((prev) => [...prev, user]);
  }

  async function handleDelete(id: string, username: string) {
    if (!confirm(`確定要刪除使用者「${username}」？此操作無法復原。`)) return;
    setDeletingId(id);
    try {
      await deleteUser(id);
      setUsers((prev) => prev.filter((u) => u.id !== id));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <CreateUserSection onCreated={handleCreated} />
      <section className="card">
        <h2 className="section-title">使用者管理</h2>
        {loading ? (
          <p className="text-sm text-gray-400 mt-3">載入中…</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b dark:border-gray-700">
                  <th className="pb-2 pr-3">帳號</th>
                  <th className="pb-2 pr-3">顯示名稱</th>
                  <th className="pb-2 pr-3">角色</th>
                  <th className="pb-2 pr-3">登入方式</th>
                  <th className="pb-2 pr-3">建立時間</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b dark:border-gray-700 last:border-0">
                    <td className="py-1.5 pr-3 text-gray-800 dark:text-gray-200">{u.username}</td>
                    <td className="py-1.5 pr-3 text-gray-500 dark:text-gray-400">
                      {u.displayName ?? '—'}
                    </td>
                    <td className="py-1.5 pr-3">
                      {u.isAdmin ? (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400">
                          管理員
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">一般</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-gray-500 dark:text-gray-400">
                      {[u.hasPassword && '密碼', u.hasGoogle && 'Google'].filter(Boolean).join(' / ') || '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-gray-400 whitespace-nowrap">
                      {new Date(u.createdAt).toLocaleDateString('zh-TW')}
                    </td>
                    <td className="py-1.5">
                      {u.id !== currentUserId && (
                        <button
                          onClick={() => handleDelete(u.id, u.username)}
                          disabled={deletingId === u.id}
                          className="text-red-500 hover:text-red-700 text-xs"
                        >
                          {deletingId === u.id ? '刪除中…' : '刪除'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ── Admin login logs section ──────────────────────────────────────────────────

function AdminLoginLogsSection() {
  const [logs, setLogs] = useState<LoginLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchAdminLoginLogs()
      .then(setLogs)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === logs.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(logs.map((l) => l.id)));
    }
  }

  async function handleDelete() {
    if (selected.size === 0) return;
    if (!confirm(`確定刪除 ${selected.size} 筆登入記錄？`)) return;
    setDeleting(true);
    try {
      await deleteAdminLoginLogs([...selected]);
      setLogs((prev) => prev.filter((l) => !selected.has(l.id)));
      setSelected(new Set());
    } catch {
      alert('刪除失敗，請重試');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="section-title">全站登入記錄</h2>
        {selected.size > 0 && (
          <button onClick={handleDelete} disabled={deleting} className="btn-danger text-sm">
            {deleting ? '刪除中…' : `刪除 ${selected.size} 筆`}
          </button>
        )}
      </div>
      {loading ? (
        <p className="text-sm text-gray-400 mt-3">載入中…</p>
      ) : logs.length === 0 ? (
        <p className="text-sm text-gray-400 mt-3">尚無登入記錄</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b dark:border-gray-700">
                <th className="pb-2 pr-3 w-6">
                  <input
                    type="checkbox"
                    checked={selected.size === logs.length && logs.length > 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="pb-2 pr-3">時間</th>
                <th className="pb-2 pr-3">帳號</th>
                <th className="pb-2 pr-3">方式</th>
                <th className="pb-2 pr-3">狀態</th>
                <th className="pb-2 pr-3">IP</th>
                <th className="pb-2">地區</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b dark:border-gray-700 last:border-0">
                  <td className="py-1.5 pr-3">
                    <input
                      type="checkbox"
                      checked={selected.has(log.id)}
                      onChange={() => toggleSelect(log.id)}
                    />
                  </td>
                  <td className="py-1.5 pr-3 text-gray-700 dark:text-gray-300 whitespace-nowrap text-xs">
                    {new Date(log.timestamp).toLocaleString('zh-TW')}
                  </td>
                  <td className="py-1.5 pr-3 text-gray-800 dark:text-gray-200">
                    {log.username}
                    {log.isAdmin && (
                      <span className="ml-1 text-xs text-teal-600 dark:text-teal-400">管</span>
                    )}
                    {log.action === 'admin-export' && (
                      <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        備份匯出
                      </span>
                    )}
                    {log.action === 'admin-import' && (
                      <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                        備份還原
                      </span>
                    )}
                    {log.action === 'admin-system-update' && (
                      <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400">
                        系統更新
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                      log.method === 'google'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                    }`}>
                      {log.method === 'google' ? 'Google' : '密碼'}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {log.success ? (
                      <span className="text-xs text-green-600 dark:text-green-400">成功</span>
                    ) : (
                      <span className="text-xs text-red-500" title={log.failReason}>失敗</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-gray-500 dark:text-gray-400 text-xs font-mono">
                    {log.ip}
                  </td>
                  <td className="py-1.5 text-gray-500 dark:text-gray-400 text-xs">
                    {log.country ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Backup section ────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}（${bytes.toLocaleString('en-US')} bytes）`;
}

function BackupSection() {
  // ── Export state ──
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportSuccess, setExportSuccess] = useState('');
  const exportAbortRef = useRef<AbortController | null>(null);

  // ── Import state ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileExportedAt, setFileExportedAt] = useState<string | null>(null);
  const [fileError, setFileError] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<{ message: string; stats: ImportStats } | null>(null);
  const uploadRef = useRef<{ cancel(): void } | null>(null);

  async function handleExport() {
    setExportError('');
    setExportSuccess('');
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setPreparing(true);
    try {
      const result = await prepareBackup(exportPassword, controller.signal);
      startBackupDownload(result);
      setExportSuccess(
        `已開始下載 ${result.filename}（${formatBytes(result.bytes)}）。20 GB 備份需要一段時間，完成前請勿關閉瀏覽器的下載管理員。`,
      );
      setExportPassword('');
      setShowExportConfirm(false);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      exportAbortRef.current = null;
      setPreparing(false);
    }
  }

  function cancelExport() {
    exportAbortRef.current?.abort();
  }

  function resetImport() {
    setFile(null);
    setFileExportedAt(null);
    setConfirmText('');
    setProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFileError('');
    setImportError('');
    setImportResult(null);
    setProgress(null);
    setConfirmText('');
    setFile(null);
    setFileExportedAt(null);

    if (selected.size > MAX_BACKUP_BYTES) {
      setFileError(`備份檔為 ${formatBytes(selected.size)}，超過 20 GB（20,000,000,000 bytes）上限；伺服器不會讀取或變更現有資料。`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (selected.size === 0) {
      setFileError('備份檔是空的');
      return;
    }

    // Preview only; the server validates every record and attachment before writing.
    void readBackupHeader(selected).then((header) => {
      if (header.format !== null && header.format !== 'nhi-dashboard-backup') {
        setFileError('這不是本系統匯出的備份檔');
        return;
      }
      if (header.version !== null && header.version !== 1) {
        setFileError(`備份檔版本不支援（version ${header.version}）`);
        return;
      }
      setFile(selected);
      setFileExportedAt(header.exportedAt);
    }).catch(() => {
      // The head is only a convenience preview — the server still validates the whole file.
      setFile(selected);
    });
  }

  async function handleImport() {
    if (!file || confirmText !== '還原' || importing) return;
    if (!window.confirm('最後確認：還原將完全取代現有所有資料，且無法復原。確定執行？')) return;
    setImportError('');
    setImportResult(null);
    setProgress({ loaded: 0, total: file.size });
    setImporting(true);
    const upload = importBackup(file, (loaded, total) => setProgress({ loaded, total }));
    uploadRef.current = upload;
    try {
      const result = await upload.promise;
      setImportResult(result);
      resetImport();
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      uploadRef.current = null;
      setImporting(false);
    }
  }

  const importingEnabled = Boolean(file) && confirmText === '還原' && !importing;
  const percent = progress && progress.total > 0 ? Math.min(100, Math.floor((progress.loaded / progress.total) * 100)) : 0;
  const uploadFinished = Boolean(progress) && progress!.loaded >= progress!.total;

  return (
    <section className="card">
      <h2 className="section-title">資料備份</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
        匯出完整資料備份（帳號、設定、登入記錄與健康紀錄），或從備份檔還原。
        健康紀錄在備份中保持原有加密狀態，還原後使用者仍可用原「資料加密密碼」解鎖。
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
        單一備份上限 20 GB（20,000,000,000 bytes 的 UTF-8 JSON，含所有帳號、Base64 加密附件與中繼資料）。
        匯出與還原都以串流處理：伺服器只在中繼資料、每筆紀錄與每個附件都驗證通過後才開始還原，
        因此大檔不會被整份載入記憶體，但需要足夠的暫存磁碟空間。
      </p>

      {/* Export */}
      <div className="mt-4 border-t border-gray-100 dark:border-gray-700 pt-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">匯出備份</h3>
        {!showExportConfirm ? (
          <>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
              備份檔包含所有帳號的密碼雜湊與中繼資料，請妥善保管。
            </p>
            <button
              onClick={() => { setShowExportConfirm(true); setExportError(''); setExportSuccess(''); }}
              className="mt-2 btn-primary"
            >
              匯出備份檔
            </button>
          </>
        ) : (
          <div className="mt-2 space-y-2">
            <p className="text-sm text-amber-700 dark:text-amber-400">
              請輸入您的管理員密碼以確認匯出。匯出操作會記錄在登入記錄中。
            </p>
            <input
              type="password"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
              className="input w-full"
              placeholder="管理員密碼"
              autoComplete="new-password"
              aria-label="管理員密碼確認"
              onKeyDown={(e) => { if (e.key === 'Enter' && exportPassword && !preparing) void handleExport(); }}
            />
            <div className="flex gap-2">
              <button onClick={() => void handleExport()} disabled={preparing || !exportPassword} className="btn-primary">
                {preparing ? '準備備份中…' : '確認匯出'}
              </button>
              <button
                onClick={() => { setShowExportConfirm(false); setExportPassword(''); setExportError(''); }}
                className="btn-secondary"
                disabled={preparing}
              >
                取消
              </button>
            </div>
            {preparing && (
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
                <span>伺服器正在暫存並驗證完整備份，20 GB 可能需要數十分鐘。</span>
                <button onClick={cancelExport} className="btn-secondary">中止匯出</button>
              </div>
            )}
          </div>
        )}
        {exportError && <p className="text-red-500 text-xs mt-2 msg-fade" role="alert">{exportError}</p>}
        {exportSuccess && (
          <p className="text-green-600 dark:text-green-400 text-xs mt-2 msg-fade" aria-live="polite">{exportSuccess}</p>
        )}
      </div>

      {/* Import */}
      <div className="mt-4 border-t border-gray-100 dark:border-gray-700 pt-4">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">從備份檔還原</h3>
        <label className="cursor-pointer inline-block btn-secondary mt-2">
          選擇備份檔
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.JSON,application/json"
            className="hidden"
            onChange={handleFileChange}
            aria-label="選擇備份檔"
          />
        </label>

        {fileError && <p className="text-red-500 text-xs mt-2 msg-fade" role="alert">{fileError}</p>}

        {file && (
          <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-sm">
            <p className="text-gray-700 dark:text-gray-300 break-all">{file.name}</p>
            <p className="text-gray-500 dark:text-gray-400 text-xs mt-1">{formatBytes(file.size)}</p>
            {fileExportedAt && (
              <p className="text-gray-500 dark:text-gray-400 text-xs mt-1">
                備份時間：{new Date(fileExportedAt).toLocaleString('zh-TW')}
              </p>
            )}
            <p className="text-gray-500 dark:text-gray-400 text-xs mt-1">
              使用者、紀錄與附件數量由伺服器在還原前完整驗證；驗證失敗時現有資料不會被變更。
            </p>

            <div className="mt-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3">
              <p className="text-sm font-medium text-red-700 dark:text-red-400">
                ⚠️ 還原將「完全取代」現有所有帳號、設定、登入記錄與健康紀錄，且不可復原。
              </p>
              <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                建議在還原前先匯出一份目前資料的備份。還原成功後，若目前登入的帳號已不存在將被自動登出。
              </p>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="input w-full mt-2"
                placeholder='請輸入「還原」以啟用按鈕'
                aria-label="還原確認文字"
                maxLength={2}
                disabled={importing}
              />
              <div className="flex items-center gap-2 mt-2">
                <button onClick={() => void handleImport()} disabled={!importingEnabled} className="btn-danger">
                  {importing ? (uploadFinished ? '驗證與還原中…' : '上傳中…') : '開始還原'}
                </button>
                {importing && (
                  <button onClick={() => uploadRef.current?.cancel()} className="btn-secondary">取消還原</button>
                )}
              </div>
              {progress && (
                <div className="mt-2" aria-live="polite">
                  <div className="h-1.5 w-full rounded-full bg-red-200 dark:bg-red-900 overflow-hidden">
                    <div className="h-full bg-red-600 dark:bg-red-400 transition-all" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                    {uploadFinished
                      ? '上傳完成，伺服器正在驗證並還原，請勿關閉此頁面。'
                      : `已上傳 ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}（${percent}%）`}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {importError && <p className="text-red-500 text-xs mt-2" role="alert">{importError}</p>}

        {importResult && (
          <div className="mt-3 rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/30 p-3 text-sm" role="status">
            <p className="font-medium text-teal-800 dark:text-teal-300">{importResult.message}</p>
            <p className="text-xs text-teal-700 dark:text-teal-400 mt-1">
              清除 {importResult.stats.orphanRecordsDeleted} 個無對應使用者的紀錄檔
            </p>
            {importResult.stats.warnings.length > 0 && (
              <ul className="mt-2 space-y-1">
                {importResult.stats.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-amber-700 dark:text-amber-400">⚠ {w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface Props {
  currentUserId: string;
}

export default function AdminSettingsPage({ currentUserId }: Props) {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate('/')}
          className="text-teal-600 hover:text-teal-800 dark:text-teal-400 dark:hover:text-teal-200 text-sm cursor-pointer flex items-center gap-1"
          aria-label="返回儀表板"
        >
          ← 返回儀表板
        </button>
        <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">管理員設定</h1>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <SystemSettingsSection />
        <SystemUpdateSection />
        <UserManagementSection currentUserId={currentUserId} />
        <BackupSection />
        <AdminLoginLogsSection />
      </main>
    </div>
  );
}
