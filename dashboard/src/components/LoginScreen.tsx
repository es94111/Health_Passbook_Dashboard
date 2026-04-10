import { useState, useEffect, useRef } from 'react';
import { login, register, loginWithGoogle, fetchConfig } from '../api';

interface Props {
  onAuth: (token: string, username: string, isAdmin: boolean) => void;
}

export default function LoginScreen({ onAuth }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchConfig()
      .then((cfg) => setGoogleClientId(cfg.googleClientId))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!googleClientId) return;

    function initGoogle() {
      if (!window.google?.accounts?.id || !googleBtnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId!,
        callback: handleGoogleCredential,
        cancel_on_tap_outside: true,
      });
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        width: googleBtnRef.current.offsetWidth || 320,
        locale: 'zh-TW',
      });
    }

    if (window.google?.accounts?.id) {
      initGoogle();
    } else {
      const interval = setInterval(() => {
        if (window.google?.accounts?.id) {
          clearInterval(interval);
          initGoogle();
        }
      }, 200);
      return () => clearInterval(interval);
    }
  }, [googleClientId]);

  async function handleGoogleCredential(response: { credential: string }) {
    setError(null);
    setLoading(true);
    try {
      const res = await loginWithGoogle(response.credential);
      localStorage.setItem('nhi_token', res.token);
      onAuth(res.token, res.username, res.isAdmin);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google 登入失敗');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const fn = mode === 'login' ? login : register;
      const res = await fn(username.trim(), password);
      localStorage.setItem('nhi_token', res.token);
      onAuth(res.token, res.username, res.isAdmin);
    } catch (err) {
      setError(err instanceof Error ? err.message : '發生錯誤');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-teal-50 to-white dark:from-gray-950 dark:to-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <svg viewBox="0 0 40 40" className="w-12 h-12 mb-3" fill="none" aria-hidden="true">
            <rect width="40" height="40" rx="10" fill="#0d9488" />
            <polyline
              points="4,20 10,20 14,10 18,30 22,14 26,26 30,20 36,20"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <h1 className="text-2xl font-bold text-teal-700 dark:text-teal-400">健康存摺儀表板</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">個人健康資料管理系統</p>
        </div>

        {/* Card */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-8">

          {/* Google SSO button */}
          {googleClientId && (
            <>
              <div ref={googleBtnRef} className="w-full" aria-label="使用 Google 帳號繼續" />
              <div className="flex items-center gap-3 my-5" aria-hidden="true">
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                <span className="text-xs text-gray-400 dark:text-gray-500">或使用帳號密碼</span>
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
              </div>
            </>
          )}

          {/* Mode toggle */}
          <div
            className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-600 mb-6"
            role="tablist"
            aria-label="登入或註冊"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              onClick={() => { setMode('login'); setError(null); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors cursor-pointer ${
                mode === 'login'
                  ? 'bg-teal-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              登入
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              onClick={() => { setMode('register'); setError(null); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors cursor-pointer ${
                mode === 'register'
                  ? 'bg-teal-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              註冊
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="login-username" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                帳號
              </label>
              <input
                id="login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent transition-colors"
                placeholder="輸入帳號"
                autoComplete="username"
                required
                minLength={3}
                maxLength={32}
              />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                密碼
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent transition-colors"
                placeholder={mode === 'register' ? '至少 6 個字元' : '輸入密碼'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={mode === 'register' ? 6 : 1}
              />
            </div>

            {error && (
              <p
                className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded-lg px-3 py-2 msg-fade"
                role="alert"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full btn-primary py-2.5 text-base"
            >
              {loading ? '處理中…' : mode === 'login' ? '登入' : '建立帳號'}
            </button>
          </form>

          {mode === 'register' && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-4 text-center">
              第一位註冊的使用者將成為管理員
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
