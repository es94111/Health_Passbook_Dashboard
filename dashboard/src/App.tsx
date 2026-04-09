import { useReducer, useEffect, useState } from 'react';
import type { NHIData } from './parsers/types';
import { parseNHIJson } from './parsers/nhi-parser';
import { me, fetchHealthData } from './api';
import LoginScreen from './components/LoginScreen';
import FileLoader from './components/FileLoader';
import AdminPanel from './components/AdminPanel';
import SummaryStats from './components/SummaryStats';
import VisitTimeline from './components/VisitTimeline';
import LabTrendCharts from './components/LabTrendCharts';
import BilledItemsChart from './components/BilledItemsChart';
import VaccinationCard from './components/VaccinationCard';
import CheckupReportList from './components/CheckupReportList';
import DentalVisitList from './components/DentalVisitList';

// ── Auth state ────────────────────────────────────────────────────────────────

interface AuthState {
  userId: string;
  username: string;
  isAdmin: boolean;
}

// ── Data reducer ──────────────────────────────────────────────────────────────

type DataAction = { type: 'LOAD'; data: NHIData } | { type: 'CLEAR' };

function dataReducer(_state: NHIData | null, action: DataAction): NHIData | null {
  switch (action.type) {
    case 'LOAD': return action.data;
    case 'CLEAR': return null;
    default: return _state;
  }
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [nhiData, dispatch] = useReducer(dataReducer, null);
  const [showAdmin, setShowAdmin] = useState(false);

  // On mount: check if there's a valid stored token and auto-load data
  useEffect(() => {
    const token = localStorage.getItem('nhi_token');
    if (!token) { setAuthLoading(false); return; }

    me()
      .then(async (user) => {
        setAuth({ userId: user.userId, username: user.username, isAdmin: user.isAdmin });
        // Auto-load existing health data from server
        try {
          const raw = await fetchHealthData();
          const hasData = Object.values(raw).some((arr) => arr.length > 0);
          if (hasData) {
            const parsed = parseNHIJson(raw as Record<string, unknown[]>);
            dispatch({ type: 'LOAD', data: parsed });
          }
        } catch {
          // No data yet — that's fine, FileLoader will handle upload
        }
      })
      .catch(() => {
        localStorage.removeItem('nhi_token');
      })
      .finally(() => setAuthLoading(false));
  }, []);

  function handleAuth(token: string, username: string, isAdmin: boolean) {
    // me() call already made inside LoginScreen — just store state
    // We need userId from the token payload
    const payload = JSON.parse(atob(token.split('.')[1])) as { userId: string };
    setAuth({ userId: payload.userId, username, isAdmin });
  }

  function handleLogout() {
    localStorage.removeItem('nhi_token');
    setAuth(null);
    dispatch({ type: 'CLEAR' });
  }

  // ── Loading spinner ──────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Not logged in ────────────────────────────────────────────────────────────

  if (!auth) {
    return <LoginScreen onAuth={handleAuth} />;
  }

  // ── Logged in, no data yet ───────────────────────────────────────────────────

  if (!nhiData) {
    return (
      <>
        <div className="fixed top-0 inset-x-0 z-10 bg-white border-b border-teal-100 px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-teal-700">健康存摺儀表板</h1>
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <span>{auth.username}{auth.isAdmin && <span className="ml-1 text-xs text-teal-600">管理員</span>}</span>
            <button onClick={handleLogout} className="underline hover:text-gray-700">登出</button>
          </div>
        </div>
        <div className="pt-14">
          <FileLoader onLoad={(data) => dispatch({ type: 'LOAD', data })} />
        </div>
      </>
    );
  }

  // ── Dashboard ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      {showAdmin && (
        <AdminPanel currentUserId={auth.userId} onClose={() => setShowAdmin(false)} />
      )}

      <header className="bg-white border-b border-teal-100 px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-teal-700">健康存摺儀表板</h1>
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span>
            {auth.username}
            {auth.isAdmin && <span className="ml-1 text-xs text-teal-600">管理員</span>}
          </span>
          {auth.isAdmin && (
            <button
              onClick={() => setShowAdmin(true)}
              className="text-sm text-teal-600 hover:text-teal-800 underline"
            >
              使用者管理
            </button>
          )}
          <button
            onClick={() => dispatch({ type: 'CLEAR' })}
            className="underline hover:text-gray-700"
          >
            匯入新資料
          </button>
          <button onClick={handleLogout} className="underline hover:text-gray-700">登出</button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        <SummaryStats data={nhiData} />

        <LabTrendCharts labResults={nhiData.labResults} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <VisitTimeline visits={nhiData.visits} />
          <BilledItemsChart visits={nhiData.visits} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <VaccinationCard vaccinations={nhiData.vaccinations} />
          <CheckupReportList reports={nhiData.checkupReports} />
        </div>

        <DentalVisitList dentalVisits={nhiData.dentalVisits} />
      </main>
    </div>
  );
}