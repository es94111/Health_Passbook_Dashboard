import { useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { Visit } from '../parsers/types';

interface Props {
  visits: Visit[];
}

// Drug codes start with two uppercase letters (e.g., AA, AC, BC, VC, NC)
// Procedure codes start with a digit
function classifyCode(code: string): 'drug' | 'procedure' | 'unknown' {
  if (/^[A-Z]{2}/.test(code)) return 'drug';
  if (/^\d/.test(code)) return 'procedure';
  return 'unknown';
}

function toDateStr(d: Date): string {
  // Use local date (not UTC) to match how browser date inputs interpret values
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const TOP_N = 20;

type Tab = 'drug' | 'procedure';

export default function BilledItemsChart({ visits }: Props) {
  const [tab, setTab] = useState<Tab>('drug');

  // Date range — derive min/max from data as defaults
  const { minDate, maxDate } = useMemo(() => {
    if (visits.length === 0) return { minDate: '', maxDate: '' };
    const sorted = [...visits].sort((a, b) => a.date.getTime() - b.date.getTime());
    return {
      minDate: toDateStr(sorted[0].date),
      maxDate: toDateStr(sorted[sorted.length - 1].date),
    };
  }, [visits]);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const filteredVisits = useMemo(() => {
    // Use local midnight (T00:00:00) to match parseNHIDate which creates local-time dates.
    // new Date("YYYY-MM-DD") parses as UTC midnight, which is ahead of local midnight
    // in UTC+ zones and would incorrectly exclude visits on the start day.
    const start = startDate ? new Date(startDate + 'T00:00:00') : null;
    const end = endDate ? new Date(endDate + 'T23:59:59') : null;
    return visits.filter((v) => {
      if (start && v.date < start) return false;
      if (end && v.date > end) return false;
      return true;
    });
  }, [visits, startDate, endDate]);

  const { topDrugs, topProcedures, totalDrugs, totalProcedures } = useMemo(() => {
    const freqDrug: Record<string, { name: string; code: string; count: number }> = {};
    const freqProc: Record<string, { name: string; code: string; count: number }> = {};
    let drugs = 0;
    let procs = 0;

    for (const visit of filteredVisits) {
      for (const proc of visit.procedures) {
        if (!proc.code) continue;
        const type = classifyCode(proc.code);
        if (type === 'drug') {
          drugs++;
          if (freqDrug[proc.code]) freqDrug[proc.code].count++;
          else freqDrug[proc.code] = { name: proc.name, code: proc.code, count: 1 };
        } else if (type === 'procedure') {
          procs++;
          if (freqProc[proc.code]) freqProc[proc.code].count++;
          else freqProc[proc.code] = { name: proc.name, code: proc.code, count: 1 };
        }
      }
    }

    const topDrugs = Object.values(freqDrug)
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_N);

    const topProcedures = Object.values(freqProc)
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_N);

    return { topDrugs, topProcedures, totalDrugs: drugs, totalProcedures: procs };
  }, [filteredVisits]);

  const data = tab === 'drug' ? topDrugs : topProcedures;
  const color = tab === 'drug' ? '#0284c7' : '#0f766e';
  const isFiltered = startDate !== '' || endDate !== '';

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-800">
          常見申報項目 (Top {TOP_N})
          {isFiltered && (
            <span className="ml-2 text-xs font-normal text-sky-600">篩選中</span>
          )}
        </h2>
        <span className="text-xs text-gray-400">藥品 {totalDrugs} 筆 / 處置 {totalProcedures} 筆</span>
      </div>

      {/* Date range filter */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <span className="text-gray-500 text-xs">日期範圍</span>
        <input
          type="date"
          value={startDate}
          min={minDate}
          max={endDate || maxDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="border border-gray-200 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-sky-400"
        />
        <span className="text-gray-400 text-xs">—</span>
        <input
          type="date"
          value={endDate}
          min={startDate || minDate}
          max={maxDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="border border-gray-200 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-sky-400"
        />
        {isFiltered && (
          <button
            onClick={() => { setStartDate(''); setEndDate(''); }}
            className="text-xs text-gray-400 hover:text-red-500 underline"
          >
            清除
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-3">
        <button
          onClick={() => setTab('drug')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === 'drug'
              ? 'bg-sky-600 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          藥品
        </button>
        <button
          onClick={() => setTab('procedure')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === 'procedure'
              ? 'bg-teal-700 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          處置
        </button>
      </div>

      {data.length === 0 ? (
        <p className="text-center text-gray-400 text-sm py-16">此範圍無資料</p>
      ) : (
        <ResponsiveContainer width="100%" height={420}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 8, right: 20, top: 4, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey="name"
              width={160}
              tick={{ fontSize: 10 }}
            />
            <Tooltip
              formatter={(val, _name, props) => [
                `${val} 次`,
                (props.payload as { code: string }).code,
              ]}
            />
            <Bar
              dataKey="count"
              fill={color}
              radius={[0, 3, 3, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
