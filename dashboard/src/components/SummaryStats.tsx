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
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-1">
      {stats.map(({ label, value }) => (
        <div
          key={label}
          className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-4 text-center shadow-sm hover:shadow-md hover:border-teal-200 dark:hover:border-teal-700 transition-all duration-200"
        >
          <dd className="text-2xl font-bold text-teal-600 dark:text-teal-400 tabular-nums">
            {value}
          </dd>
          <dt className="text-sm text-gray-500 dark:text-gray-400 mt-1">{label}</dt>
        </div>
      ))}
    </dl>
  );
}
