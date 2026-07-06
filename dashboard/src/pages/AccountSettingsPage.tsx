import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UserProfile, LoginLog } from '../api';
import {
  updateDisplayName,
  fetchLoginLogs,
  deleteLoginLogs,
  linkGoogle,
  unlinkGoogle,
  deleteAccount,
  setPassword,
  changePassword,
} from '../api';
import { useTheme } from '../ThemeContext';
import { useUserStore, HIDEABLE_SECTIONS } from '../UserStore';
import { DATE_RANGE_OPTIONS } from '../lib/keySummary';

const PASSWORD_MIN_LENGTH = 12;

interface Props {
  profile: UserProfile;
  googleClientId: string | null;
  onLogout: () => void;
  onProfileUpdate: (patch: Partial<UserProfile>) => void;
}

// ── Theme section ─────────────────────────────────────────────────────────────

function ThemeSection() {
  const { theme, setTheme } = useTheme();
  const [saving, setSaving] = useState(false);

  async function handleChange(mode: 'light' | 'dark' | 'system') {
    setSaving(true);
    try {
      await setTheme(mode);
    } finally {
      setSaving(false);
    }
  }

  const options: { value: 'light' | 'dark' | 'system'; label: string }[] = [
    { value: 'light', label: '淺色' },
    { value: 'dark', label: '深色' },
    { value: 'system', label: '跟隨系統' },
  ];

  return (
    <section className="card">
      <h2 className="section-title">外觀主題</h2>
      <div className="flex gap-3 mt-3">
        {options.map((opt) => (
          <button
            key={opt.value}
            disabled={saving}
            onClick={() => handleChange(opt.value)}
            className={`px-4 py-2 rounded-lg border text-sm transition-colors ${
              theme === opt.value
                ? 'bg-teal-600 text-white border-teal-600'
                : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-teal-400'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </section>
  );
}

// ── Dashboard preferences section ─────────────────────────────────────────────

function DashboardPreferencesSection() {
  const store = useUserStore();

  return (
    <section className="card">
      <h2 className="section-title">儀表板偏好</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
        設定申報項目圖表的預設日期範圍，並選擇要在首頁顯示的區塊。
      </p>

      {/* Default date range */}
      <div className="mt-4">
        <span className="label">預設日期範圍（申報項目圖表）</span>
        <div className="flex flex-wrap gap-2 mt-1">
          {DATE_RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => store.setDefaultDateRange(opt.value)}
              className={`px-3 py-1.5 rounded-lg border text-sm transition-colors cursor-pointer ${
                store.preferences.defaultDateRange === opt.value
                  ? 'bg-teal-600 text-white border-teal-600'
                  : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-teal-400'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Visible sections */}
      <div className="mt-4">
        <span className="label">首頁顯示區塊</span>
        <div className="mt-1 divide-y divide-gray-100 dark:divide-gray-700">
          {HIDEABLE_SECTIONS.map((s) => {
            const visible = !store.isSectionHidden(s.key);
            return (
              <label key={s.key} className="flex items-center justify-between py-2 cursor-pointer select-none">
                <span className="text-sm text-gray-700 dark:text-gray-300">{s.label}</span>
                <span className="relative flex items-center">
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={() => store.toggleSection(s.key)}
                    className="sr-only peer"
                    aria-label={`${visible ? '隱藏' : '顯示'} ${s.label}`}
                  />
                  <div className="w-9 h-5 bg-gray-200 dark:bg-gray-600 rounded-full peer-checked:bg-teal-500 transition-colors" />
                  <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform" />
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── Display name section ──────────────────────────────────────────────────────

function DisplayNameSection({ profile, onProfileUpdate }: Pick<Props, 'profile' | 'onProfileUpdate'>) {
  const [name, setName] = useState(profile.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) { setError('顯示名稱不能空白'); return; }
    if (trimmed.length > 50) { setError('最多 50 個字元'); return; }
    setError('');
    setSaving(true);
    try {
      const res = await updateDisplayName(trimmed);
      onProfileUpdate({ displayName: res.displayName });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2 className="section-title">帳號資訊</h2>
      <div className="mt-3 space-y-3">
        <div>
          <span className="label">帳號</span>
          <p className="text-gray-700 dark:text-gray-300 text-sm">{profile.username}</p>
        </div>
        <div>
          <label htmlFor="display-name" className="label">顯示名稱</label>
          <div className="flex gap-2 mt-1">
            <input
              id="display-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={50}
              className="input flex-1"
              placeholder="輸入顯示名稱"
              autoComplete="nickname"
              aria-describedby={error ? 'display-name-error' : undefined}
            />
            <button onClick={handleSave} disabled={saving} className="btn-primary">
              {saving ? '儲存中…' : '儲存'}
            </button>
          </div>
          {error && (
            <p id="display-name-error" className="text-red-500 text-xs mt-1 msg-fade" role="alert">{error}</p>
          )}
          {success && (
            <p className="text-green-600 dark:text-green-400 text-xs mt-1 msg-fade" aria-live="polite">已儲存</p>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Password section ──────────────────────────────────────────────────────────

function PasswordSection({ profile }: Pick<Props, 'profile'>) {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleSubmit() {
    if (!newPw || newPw.length < PASSWORD_MIN_LENGTH) { setError(`密碼至少 ${PASSWORD_MIN_LENGTH} 個字元`); return; }
    setError('');
    setSaving(true);
    try {
      if (profile.hasPassword) {
        if (!currentPw) { setError('請輸入目前密碼'); setSaving(false); return; }
        await changePassword(currentPw, newPw);
      } else {
        await setPassword(newPw);
      }
      setCurrentPw('');
      setNewPw('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card">
      <h2 className="section-title">{profile.hasPassword ? '變更密碼' : '設定密碼'}</h2>
      {!profile.hasPassword && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          目前僅能使用 Google 登入，設定密碼後可啟用帳號密碼登入。
        </p>
      )}
      <div className="mt-3 space-y-2">
        {profile.hasPassword && (
          <input
            id="current-password"
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            className="input w-full"
            placeholder="目前密碼"
            autoComplete="current-password"
            aria-label="目前密碼"
          />
        )}
        <input
          id="new-password"
          type="password"
          value={newPw}
          onChange={(e) => setNewPw(e.target.value)}
          className="input w-full"
          placeholder={`新密碼（至少 ${PASSWORD_MIN_LENGTH} 個字元）`}
          autoComplete="new-password"
          aria-label="新密碼"
          minLength={PASSWORD_MIN_LENGTH}
        />
        <button onClick={handleSubmit} disabled={saving} className="btn-primary">
          {saving ? '儲存中…' : profile.hasPassword ? '變更密碼' : '設定密碼'}
        </button>
        {error && <p className="text-red-500 text-xs msg-fade" role="alert">{error}</p>}
        {success && <p className="text-green-600 dark:text-green-400 text-xs msg-fade" aria-live="polite">密碼已更新</p>}
      </div>
    </section>
  );
}

// ── Google link section ───────────────────────────────────────────────────────

function GoogleSection({ profile, googleClientId, onProfileUpdate }: Pick<Props, 'profile' | 'googleClientId' | 'onProfileUpdate'>) {
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [unlinking, setUnlinking] = useState(false);

  useEffect(() => {
    if (profile.hasGoogle || !googleClientId || !googleBtnRef.current || !window.google) return;

    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: async (resp: { credential: string }) => {
        setError('');
        try {
          const res = await linkGoogle(resp.credential);
          onProfileUpdate({ hasGoogle: true, googleEmail: res.googleEmail, avatarUrl: res.avatarUrl });
        } catch (e) {
          setError((e as Error).message);
        }
      },
    });
    window.google.accounts.id.renderButton(googleBtnRef.current, {
      theme: 'outline',
      size: 'medium',
      text: 'signin_with',
      locale: 'zh-TW',
    });
  }, [profile.hasGoogle, googleClientId, onProfileUpdate]);

  async function handleUnlink() {
    if (!confirm('確定要解除 Google 帳號綁定？')) return;
    setUnlinking(true);
    setError('');
    try {
      await unlinkGoogle();
      onProfileUpdate({ hasGoogle: false, googleEmail: null, avatarUrl: null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUnlinking(false);
    }
  }

  if (!googleClientId) return null;

  return (
    <section className="card">
      <h2 className="section-title">Google 帳號</h2>
      <div className="mt-3">
        {profile.hasGoogle ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-700 dark:text-gray-300">
                已綁定：{profile.googleEmail}
              </p>
            </div>
            <button
              onClick={handleUnlink}
              disabled={unlinking || !profile.hasPassword}
              className="btn-danger text-sm"
              title={!profile.hasPassword ? '請先設定密碼才能解除 Google 綁定' : ''}
            >
              {unlinking ? '解除中…' : '解除綁定'}
            </button>
          </div>
        ) : (
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
              綁定 Google 帳號後，可使用 Google 快速登入。
            </p>
            <div ref={googleBtnRef} />
          </div>
        )}
        {!profile.hasPassword && profile.hasGoogle && (
          <p className="text-xs text-amber-600 mt-2">
            須先設定密碼才能解除 Google 綁定，以確保帳號可登入。
          </p>
        )}
        {error && <p className="text-red-500 text-xs mt-2">{error}</p>}
      </div>
    </section>
  );
}

// ── Login logs section ────────────────────────────────────────────────────────

function LoginLogsSection() {
  const [logs, setLogs] = useState<LoginLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchLoginLogs()
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

  async function handleDelete() {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      await deleteLoginLogs([...selected]);
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
        <h2 className="section-title">登入記錄</h2>
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
                <th className="pb-2 pr-3 w-6" />
                <th className="pb-2 pr-3">時間</th>
                <th className="pb-2 pr-3">方式</th>
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
                  <td className="py-1.5 pr-3 text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleString('zh-TW')}
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

// ── Danger zone section ───────────────────────────────────────────────────────

function DangerZoneSection({ profile, onLogout }: Pick<Props, 'profile' | 'onLogout'>) {
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');

  async function handleDelete() {
    setDeleting(true);
    setError('');
    try {
      await deleteAccount(profile.hasPassword ? password : undefined);
      onLogout();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="card border-red-200 dark:border-red-900">
      <h2 className="section-title text-red-600 dark:text-red-400">危險操作</h2>
      {!showConfirm ? (
        <button
          onClick={() => setShowConfirm(true)}
          className="mt-3 btn-danger"
        >
          刪除帳號
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            此操作無法復原，所有健康資料與帳號設定將永久刪除。
          </p>
          {profile.hasPassword && (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input w-full"
              placeholder="請輸入密碼確認"
            />
          )}
          <div className="flex gap-2">
            <button onClick={handleDelete} disabled={deleting} className="btn-danger">
              {deleting ? '刪除中…' : '確認刪除帳號'}
            </button>
            <button onClick={() => { setShowConfirm(false); setError(''); }} className="btn-secondary">
              取消
            </button>
          </div>
          {error && <p className="text-red-500 text-xs">{error}</p>}
        </div>
      )}
    </section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AccountSettingsPage({ profile, googleClientId, onLogout, onProfileUpdate }: Props) {
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
        <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">帳號設定</h1>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <ThemeSection />
        <DashboardPreferencesSection />
        <DisplayNameSection profile={profile} onProfileUpdate={onProfileUpdate} />
        <PasswordSection profile={profile} />
        <GoogleSection profile={profile} googleClientId={googleClientId} onProfileUpdate={onProfileUpdate} />
        <LoginLogsSection />
        <DangerZoneSection profile={profile} onLogout={onLogout} />
      </main>
    </div>
  );
}
