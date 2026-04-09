import type { Hospitalization } from '../parsers/types';

interface Props {
  hospitalizations: Hospitalization[];
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

export default function HospitalizationList({ hospitalizations }: Props) {
  const sorted = [...hospitalizations].sort(
    (a, b) => b.admitDate.getTime() - a.admitDate.getTime(),
  );

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-800">住院紀錄</h2>
        <span className="text-xs text-gray-400">{sorted.length} 筆</span>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">無住院紀錄</p>
      ) : (
        <ul className="space-y-4">
          {sorted.map((h, i) => {
            const days = daysBetween(h.admitDate, h.dischargeDate);
            const admit = h.admitDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
            const discharge = h.dischargeDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });

            return (
              <li key={i} className="border border-gray-100 rounded-lg p-4">
                {/* Header */}
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div>
                    <div className="text-base font-semibold text-gray-800">{h.hospital}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {admit} ～ {discharge}
                    </div>
                  </div>
                  <div className="shrink-0 text-center bg-teal-50 rounded-lg px-3 py-1.5">
                    <div className="text-xl font-bold text-teal-700">{days}</div>
                    <div className="text-xs text-teal-500">天</div>
                  </div>
                </div>

                {/* Diagnoses */}
                {h.diagnoses.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-gray-400 mb-1.5">診斷</div>
                    <ul className="space-y-1">
                      {h.diagnoses.map((d, j) => (
                        <li key={j} className="flex gap-2 text-sm">
                          <span className="text-gray-400 shrink-0 tabular-nums">{d.code}</span>
                          <span className="text-gray-700">{d.name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}