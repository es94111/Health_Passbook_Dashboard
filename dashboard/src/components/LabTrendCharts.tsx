import { useId, useMemo, useState } from 'react';
import type { LabResult, TextLabResult, Visit } from '../parsers/types';
import { buildLabSeries, labSource } from '../lib/clinicalLabSeries';
import { originLabel } from '../lib/clinicalRecords';
import { listMedications } from '../lib/keySummary';
import { prescriptionDays, type MedicationOverlay } from '../lib/medicationMarkers';
import LabSeriesCard from './LabSeriesCard';
import TextLabResultsTable from './TextLabResultsTable';

interface Props {
  labResults: LabResult[];
  textLabResults?: TextLabResult[];
  visits?: Visit[];
}

const MIN_READINGS = 3;
const NO_VISITS: Visit[] = [];

export default function LabTrendCharts({ labResults, textLabResults = [], visits = NO_VISITS }: Props) {
  const overlayId = useId();
  const [overlayCode, setOverlayCode] = useState('');
  const [search, setSearch] = useState('');
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [showFewReadings, setShowFewReadings] = useState(true);
  const allGroups = useMemo(() => [...new Set([...labResults, ...textLabResults].map(record => record.testGroup))]
    .filter(Boolean).sort((a, b) => a.localeCompare(b)), [labResults, textLabResults]);
  const allSubItemGroups = useMemo(() => buildLabSeries(labResults), [labResults]);
  const medications = useMemo(() => listMedications(visits), [visits]);
  const overlay = useMemo<MedicationOverlay | undefined>(() => {
    const option = medications.find(medication => medication.code === overlayCode);
    return option ? { name: option.name, days: prescriptionDays(visits, option.code) } : undefined;
  }, [medications, overlayCode, visits]);
  const query = search.trim().toLocaleLowerCase();
  const matches = (values: string[]) => values.some(value => value.toLocaleLowerCase().includes(query));
  const groups = allSubItemGroups.filter(series => (showFewReadings || series.records.length >= MIN_READINGS)
    && (selectedGroups.size === 0 || series.testGroups.some(group => selectedGroups.has(group)))
    && matches([...series.subItems, ...series.testGroups, series.code, series.unit, series.hospital, series.source]));
  const textResults = textLabResults.filter(record => (selectedGroups.size === 0 || selectedGroups.has(record.testGroup))
    && matches([record.subItem, record.testGroup, record.text, record.unit ?? '', record.refText ?? '', record.hospital,
      labSource(record), ...(record.origins ?? []).map(originLabel)]));

  function toggleGroup(group: string) {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const hiddenCount = showFewReadings ? 0 : allSubItemGroups.filter(series => series.records.length < MIN_READINGS).length;

  return (
    <section className="card" aria-label="檢驗趨勢與結果">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h2 className="section-title">檢驗趨勢與結果</h2>
        <span className="text-xs text-gray-500 dark:text-gray-400" role="status">
          數值 {groups.length} / {allSubItemGroups.length} 個序列 · 文字 {textResults.length} / {textLabResults.length} 筆
        </span>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">不同代碼、單位、資料來源與院所分開顯示；參考區間以每筆紀錄為準。</p>

      {/* Filter bar */}
      <div className="space-y-2 mb-4">
        {/* Search input */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜尋檢驗項目、代碼、分類或來源…"
          aria-label="搜尋檢驗結果"
          className="input w-full"
        />

        {/* Test group tags */}
        {allGroups.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {allGroups.map((g) => {
              const active = selectedGroups.has(g);
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() => toggleGroup(g)}
                  aria-pressed={active}
                  className={`px-2.5 py-0.5 text-xs rounded-full border transition-colors ${
                    active
                      ? 'bg-teal-700 text-white border-teal-700 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-600'
                      : 'bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:border-teal-400 hover:text-teal-700 dark:hover:text-teal-300'
                  }`}
                >
                  {g}
                </button>
              );
            })}
            {selectedGroups.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedGroups(new Set())}
                className="px-2.5 py-0.5 text-xs rounded-full border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-teal-700 dark:hover:text-teal-300"
              >
                清除篩選
              </button>
            )}
          </div>
        )}

        {/* Medication overlay */}
        {medications.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={overlayId} className="text-xs text-gray-500 dark:text-gray-400">疊加用藥時間點</label>
            <select
              id={overlayId}
              value={overlay ? overlayCode : ''}
              onChange={(e) => setOverlayCode(e.target.value)}
              className="input w-auto max-w-full"
            >
              <option value="">不疊加</option>
              {medications.map(medication => (
                <option key={medication.code} value={medication.code}>{`${medication.name}（${medication.count} 次）`}</option>
              ))}
            </select>
          </div>
        )}

        {/* Sparse readings toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
          <span className="relative flex items-center">
            <input
              type="checkbox"
              checked={showFewReadings}
              onChange={(e) => setShowFewReadings(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-gray-200 dark:bg-gray-700 rounded-full peer-checked:bg-teal-600 peer-focus-visible:ring-2 peer-focus-visible:ring-teal-400 transition-colors" />
            <div className="absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform" />
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            顯示少於 {MIN_READINGS} 筆的項目
            {hiddenCount > 0 && ` (${hiddenCount} 項)`}
          </span>
        </label>
      </div>

      {groups.length === 0 && textResults.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">沒有符合條件的檢驗項目</p>
      ) : (
        <>
          {groups.length > 0 && <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {groups.map(series => <LabSeriesCard key={series.key} series={series} overlay={overlay} />)}
          </div>}
          {textResults.length > 0 && <TextLabResultsTable records={textResults} />}
        </>
      )}
    </section>
  );
}