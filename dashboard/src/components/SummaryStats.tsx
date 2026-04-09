import type { NHIData } from '../parsers/types';

interface Props {
  data: NHIData;
}

export default function SummaryStats({ data }: Props) {
  const allDates = [
    ...data.visits.map((v) => v.date),
    ...data.labResults.map((l) => l.date),
  ].filter((d) => !isNaN(d.getTime()));

  const minYear = allDates.length ? Math.min(...allDates.map((d) => d.getFullYear())) : 0;
  const maxYear = allDates.length ? Math.max(...allDates.map((d) => d.getFullYear())) : 0;
  const yearsCovered = maxYear > 0 ? `${minYear}–${maxYear}` : '—';

  const uniqueHospitals = new Set([
    ...data.visits.map((v) => v.hospital),
    ...data.hospitalizations.map((h) => h.hospital),
  ]).size;

  const uniqueLabTests = new Set(data.labResults.map((l) => l.subItem)).size;

  const stats = [
    { label: '門診次數', value: data.visits.length },
    { label: '住院紀錄', value: data.hospitalizations.length },
    { label: '疫苗接種', value: data.vaccinations.length },
    { label: '檢驗項目', value: data.labResults.length },
    { label: '不同醫院', value: uniqueHospitals },
    { label: '不同檢驗', value: uniqueLabTests },
    { label: '健檢報告', value: data.checkupReports.length },
    { label: '涵蓋年份', value: yearsCovered },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4">
      {stats.map(({ label, value }) => (
        <div key={label} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{value}</div>
          <div className="text-sm text-gray-500 mt-1">{label}</div>
        </div>
      ))}
    </div>
  );
}
