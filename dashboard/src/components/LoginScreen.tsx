import { useState, useEffect, useRef } from 'react';
import { login, register, loginWithGoogle } from '../api';

interface Props {
  onAuth: (token: string, username: string, isAdmin: boolean) => void;
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

export default function LoginScreen({ onAuth }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  // Initialise Google Identity Services once the GSI script is ready
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    function initGoogle() {
      if (!window.google?.accounts?.id || !googleBtnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID!,
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

    // GSI script may load after component mount
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
  }, []);

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
    <div className="min-h-screen bg-gradient-to-br from-teal-50 to-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <svg viewBox="0 0 40 40" className="w-12 h-12 mb-3" fill="none">
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
          <h1 className="text-2xl font-bold text-teal-700">健康存摺儀表板</h1>
          <p className="text-sm text-gray-500 mt-1">個人健康資料管理系統</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">

          {/* Google SSO button */}
          {GOOGLE_CLIENT_ID && (
            <>
              <div ref={googleBtnRef} className="w-full" />
              <div className="flex items-center gap-3 my-5">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-xs text-gray-400">或使用帳號密碼</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>
            </>
          )}

          {/* Mode toggle */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 mb-6">
            <button
              type="button"
              onClick={() => { setMode('login'); setError(null); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                mode === 'login'
                  ? 'bg-teal-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              登入
            </button>
            <button
              type="button"
              onClick={() => { setMode('register'); setError(null); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                mode === 'register'
                  ? 'bg-teal-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              註冊
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">帳號</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
                placeholder="輸入帳號"
                autoComplete={mode === 'login' ? 'username' : 'new-password'}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">密碼</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
                placeholder={mode === 'register' ? '至少 6 個字元' : '輸入密碼'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
            >
              {loading ? '處理中…' : mode === 'login' ? '登入' : '建立帳號'}
            </button>
          </form>

          {mode === 'register' && (
            <p className="text-xs text-gray-400 mt-4 text-center">
              第一位註冊的使用者將成為管理員
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
