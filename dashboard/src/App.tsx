import { useReducer, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { NHIData } from './parsers/types';
import type { ClientEncryptedRecords, UserProfile } from './api';
import { me, fetchHealthData, fetchConfig, logout } from './api';
import { ThemeProvider } from './ThemeContext';
import { UserStoreProvider, useUserStore, SECTION_KEY, tabSectionKey } from './UserStore';
import LoginScreen from './components/LoginScreen';
import FileLoader from './components/FileLoader';
import KeySummary from './components/KeySummary';
import SummaryStats from './components/SummaryStats';
import VisitTimeline from './components/VisitTimeline';
import LabTrendCharts from './components/LabTrendCharts';
import BilledItemsChart from './components/BilledItemsChart';
import VaccinationCard from './components/VaccinationCard';
import CheckupReportList from './components/CheckupReportList';
import DentalVisitList from './components/DentalVisitList';
import HospitalizationList from './components/HospitalizationList';
import AccountSettingsPage from './pages/AccountSettingsPage';
import AdminSettingsPage from './pages/AdminSettingsPage';

// ── Data reducer ──────────────────────────────────────────────────────────────

type DataAction = { type: 'LOAD'; data: NHIData } | { type: 'CLEAR' };

function dataReducer(_state: NHIData | null, action: DataAction): NHIData | null {
  switch (action.type) {
    case 'LOAD': return action.data;
    case 'CLEAR': return null;
    default: return _state;
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type Tab = '門診' | '住院' | '檢驗' | '牙科' | '預防保健';
const TABS: Tab[] = ['門診', '住院', '檢驗', '牙科', '預防保健'];

// ── Dashboard page ────────────────────────────────────────────────────────────

interface DashboardProps {
  profile: UserProfile;
  nhiData: NHIData | null;
  storedEnvelope: ClientEncryptedRecords | null;
  dispatch: React.Dispatch<DataAction>;
  onEnvelopeSaved: (envelope: ClientEncryptedRecords) => void;
  onLogout: () => void;
}

function DashboardPage({ profile, nhiData, storedEnvelope, dispatch, onEnvelopeSaved, onLogout }: DashboardProps) {
  const navigate = useNavigate();
  const store = useUserStore();
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const last = store.preferences.lastActiveTab;
    return last && (TABS as string[]).includes(last) ? (last as Tab) : '門診';
  });

  if (!nhiData) {
    return (
      <>
        <div className="fixed top-0 inset-x-0 z-10 bg-white dark:bg-gray-800 border-b border-teal-100 dark:border-gray-700 px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-teal-700 dark:text-teal-400">健康存摺儀表板</h1>
          <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
            <button
              onClick={() => navigate('/settings/account')}
              className="underline hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer"
            >
              {profile.displayName ?? profile.username}
              {profile.isAdmin && <span className="ml-1 text-xs text-teal-600">管理員</span>}
            </button>
            <button onClick={onLogout} className="underline hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer">登出</button>
          </div>
        </div>
        <div className="pt-14">
          <FileLoader
            storedEnvelope={storedEnvelope}
            onEnvelopeSaved={onEnvelopeSaved}
            onLoad={(data) => dispatch({ type: 'LOAD', data })}
          />
        </div>
      </>
    );
  }

  const visibleTabs = TABS.filter((t) => !store.isSectionHidden(tabSectionKey(t)));
  const currentTab: Tab = visibleTabs.includes(activeTab) ? activeTab : (visibleTabs[0] ?? '門診');

  function selectTab(tab: Tab) {
    setActiveTab(tab);
    store.setLastActiveTab(tab);
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b border-teal-100 dark:border-gray-700 px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-teal-700 dark:text-teal-400">健康存摺儀表板</h1>
        <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
          <button
            onClick={() => navigate('/settings/account')}
            className="underline hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer"
          >
            {profile.displayName ?? profile.username}
            {profile.isAdmin && <span className="ml-1 text-xs text-teal-600">管理員</span>}
          </button>
          {profile.isAdmin && (
            <button
              onClick={() => navigate('/settings/admin')}
              className="text-sm text-teal-600 hover:text-teal-800 dark:text-teal-400 underline"
            >
              管理員設定
            </button>
          )}
          <button
            onClick={() => dispatch({ type: 'CLEAR' })}
            className="underline hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer"
          >
            匯入新資料
          </button>
          <button onClick={onLogout} className="underline hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer">登出</button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {!store.isSectionHidden(SECTION_KEY.keySummary) && <KeySummary data={nhiData} />}

        {!store.isSectionHidden(SECTION_KEY.summaryStats) && <SummaryStats data={nhiData} />}

        {/* Tab navigation */}
        {visibleTabs.length > 0 && (
          <div
            role="tablist"
            aria-label="資料分類"
            className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 w-fit"
          >
            {visibleTabs.map((tab) => (
              <button
                key={tab}
                role="tab"
                aria-selected={currentTab === tab}
                onClick={() => selectTab(tab)}
                className={`px-4 py-1.5 text-sm rounded-md transition-colors duration-150 cursor-pointer ${
                  currentTab === tab
                    ? 'bg-white dark:bg-gray-700 text-teal-700 dark:text-teal-400 font-medium shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        )}

        {/* Tab content */}
        {currentTab === '門診' && (
          <div className="space-y-6">
            <VisitTimeline visits={nhiData.visits} />
            <BilledItemsChart visits={nhiData.visits} defaultRange={store.preferences.defaultDateRange} />
          </div>
        )}
        {currentTab === '檢驗' && (
          <LabTrendCharts labResults={nhiData.labResults} />
        )}
        {currentTab === '住院' && (
          <HospitalizationList hospitalizations={nhiData.hospitalizations} />
        )}
        {currentTab === '牙科' && (
          <DentalVisitList dentalVisits={nhiData.dentalVisits} />
        )}
        {currentTab === '預防保健' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <VaccinationCard vaccinations={nhiData.vaccinations} />
            <CheckupReportList reports={nhiData.checkupReports} />
          </div>
        )}
      </main>
    </div>
  );
}

// ── App root (with auth + data state) ────────────────────────────────────────

function AppRoot() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [nhiData, dispatch] = useReducer(dataReducer, null);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [storedEnvelope, setStoredEnvelope] = useState<ClientEncryptedRecords | null>(null);

  // Fetch server config (Google Client ID, etc.)
  useEffect(() => {
    fetchConfig().then((cfg) => setGoogleClientId(cfg.googleClientId)).catch(() => {});
  }, []);

  // On mount: check HttpOnly cookie session and remember encrypted health data if present.
  useEffect(() => {
    me()
      .then(async (user) => {
        setProfile(user);
        try {
          const { envelope } = await fetchHealthData();
          setStoredEnvelope(envelope);
        } catch {
          // No data yet
        }
      })
      .catch(() => {})
      .finally(() => setAuthLoading(false));
  }, []);

  function handleAuth(_username: string, _isAdmin: boolean) {
    me()
      .then(async (user) => {
        setProfile(user);
        try {
          const { envelope } = await fetchHealthData();
          setStoredEnvelope(envelope);
        } catch {
          // No data yet
        }
      })
      .catch(() => {});
  }

  function handleLogout() {
    void logout().catch(() => {});
    setProfile(null);
    setStoredEnvelope(null);
    dispatch({ type: 'CLEAR' });
  }

  function handleProfileUpdate(patch: Partial<UserProfile>) {
    setProfile((prev) => prev ? { ...prev, ...patch } : prev);
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!profile) {
    return <LoginScreen onAuth={handleAuth} />;
  }

  return (
    <ThemeProvider initialTheme={profile.themeMode}>
      <UserStoreProvider profile={profile} onProfileUpdate={handleProfileUpdate}>
        <Routes>
          <Route
            path="/"
            element={
              <DashboardPage
                profile={profile}
                nhiData={nhiData}
                storedEnvelope={storedEnvelope}
                dispatch={dispatch}
                onEnvelopeSaved={setStoredEnvelope}
                onLogout={handleLogout}
              />
            }
          />
          <Route
            path="/settings/account"
            element={
              <AccountSettingsPage
                profile={profile}
                googleClientId={googleClientId}
                onLogout={handleLogout}
                onProfileUpdate={handleProfileUpdate}
              />
            }
          />
          {profile.isAdmin && (
            <Route
              path="/settings/admin"
              element={<AdminSettingsPage currentUserId={profile.userId} />}
            />
          )}
          {/* Fallback: any unknown route → home */}
          <Route
            path="*"
            element={
              <DashboardPage
                profile={profile}
                nhiData={nhiData}
                storedEnvelope={storedEnvelope}
                dispatch={dispatch}
                onEnvelopeSaved={setStoredEnvelope}
                onLogout={handleLogout}
              />
            }
          />
        </Routes>
      </UserStoreProvider>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoot />
    </BrowserRouter>
  );
}
