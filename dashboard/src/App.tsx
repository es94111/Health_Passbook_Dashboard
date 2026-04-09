import { useReducer } from 'react';
import type { NHIData } from './parsers/types';
import FileLoader from './components/FileLoader';
import SummaryStats from './components/SummaryStats';
import VisitTimeline from './components/VisitTimeline';
import LabTrendCharts from './components/LabTrendCharts';
import BilledItemsChart from './components/BilledItemsChart';
import VaccinationCard from './components/VaccinationCard';
import CheckupReportList from './components/CheckupReportList';

// NHIData lives in the reducer — data state only, no UI state here
type Action =
  | { type: 'LOAD'; data: NHIData }
  | { type: 'CLEAR' };

function nhiReducer(_state: NHIData | null, action: Action): NHIData | null {
  switch (action.type) {
    case 'LOAD': return action.data;
    case 'CLEAR': return null;
    default: return _state;
  }
}

export default function App() {
  const [nhiData, dispatch] = useReducer(nhiReducer, null);

  if (!nhiData) {
    return <FileLoader onLoad={(data) => dispatch({ type: 'LOAD', data })} />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-teal-100 px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-teal-700">健康存摺儀表板</h1>
        <button
          onClick={() => dispatch({ type: 'CLEAR' })}
          className="text-sm text-gray-500 hover:text-gray-700 underline"
        >
          載入其他檔案
        </button>
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
      </main>
    </div>
  );
}
