import { useMemo } from 'react';
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

const TOP_N = 20;

export default function BilledItemsChart({ visits }: Props) {
  const { top, totalDrugs, totalProcedures } = useMemo(() => {
    const freq: Record<string, { name: string; code: string; count: number; type: 'drug' | 'procedure' | 'unknown' }> = {};
    let drugs = 0;
    let procs = 0;

    for (const visit of visits) {
      for (const proc of visit.procedures) {
        if (!proc.code) continue;
        const type = classifyCode(proc.code);
        if (type === 'drug') drugs++;
        else if (type === 'procedure') procs++;

        if (freq[proc.code]) {
          freq[proc.code].count++;
        } else {
          freq[proc.code] = { name: proc.name, code: proc.code, count: 1, type };
        }
      }
    }

    const top = Object.values(freq)
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_N);

    return { top, totalDrugs: drugs, totalProcedures: procs };
  }, [visits]);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-semibold text-gray-800">常見申報項目 (Top {TOP_N})</h2>
        <span className="text-xs text-gray-400">藥品 {totalDrugs} 筆 / 處置 {totalProcedures} 筆</span>
      </div>
      <ResponsiveContainer width="100%" height={420}>
        <BarChart
          data={top}
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
              `${val} 次 (${(props.payload as { type: string }).type === 'drug' ? '藥品' : '處置'})`,
              (props.payload as { code: string }).code,
            ]}
          />
          <Bar
            dataKey="count"
            fill="#8b5cf6"
            radius={[0, 3, 3, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
