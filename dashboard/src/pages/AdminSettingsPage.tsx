import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AppSettings, UserInfo, LoginLog } from '../api';
import {
  fetchAdminSettings,
  updateAdminSettings,
  listUsers,
  createUser,
  deleteUser,
  fetchAdminLoginLogs,
  deleteAdminLoginLogs,
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

  useEffect(() => {
    fetchUsers();
  }, []);

  function fetchUsers() {
    listUsers()
      .then(setUsers)
      .catch(() => {})
      .finally(() => setLoading(false));
  }

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
        <UserManagementSection currentUserId={currentUserId} />
        <AdminLoginLogsSection />
      </main>
    </div>
  );
}
