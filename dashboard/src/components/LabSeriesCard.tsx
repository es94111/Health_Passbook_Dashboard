import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, ReferenceArea,
} from 'recharts';
import { useUserStore } from '../UserStore';
import { usePersonal } from '../personalContext';
import { clinicalDate, keyedRecords } from '../lib/clinicalRecords';
import {
  isLabSeriesPinned, labReadingKey, labReference, labSeriesDescription, labSeriesPinTarget,
  type LabSeries,
} from '../lib/clinicalLabSeries';
import { describeTarget, isOutsideTarget } from '../lib/labTargets';
import { describeMedicationOverlay, placeMedicationMarkers, type MedicationOverlay } from '../lib/medicationMarkers';
import { RecordOrigins } from './ClinicalRecordDetails';
import TargetEditor from './TargetEditor';

const TARGET_LINE_COLOR = '#d97706';
const MARKER_LINE_COLOR = '#3b82f6';

export default function LabSeriesCard({ series, overlay }: { series: LabSeries; overlay?: MedicationOverlay }) {
  const store = useUserStore();
  const { personal } = usePersonal();
  const target = Object.hasOwn(personal.targets, series.key) ? personal.targets[series.key] : undefined;
  const pinned = isLabSeriesPinned(series, store.preferences.pinnedLabItems);
  const description = labSeriesDescription(series);
  const points = keyedRecords(series.records, labReadingKey).map(({ key, record }) => ({
    key, record, date: clinicalDate(record.date), value: record.value,
    outOfRange: (record.refLow !== null && record.value < record.refLow)
      || (record.refHigh !== null && record.value > record.refHigh),
  }));
  const outOfRangeCount = points.filter(point => point.outOfRange).length;
  const targetOutsideCount = target ? points.filter(point => isOutsideTarget(point.value, target)).length : 0;
  const { refLow, refHigh } = series.records[0];
  const placement = overlay
    ? placeMedicationMarkers(overlay.days, points.map(point => ({ date: point.record.date, x: point.date })))
    : null;

  return (
    <article aria-label={`${series.subItem}（${description}${series.code ? ` · ${series.code}` : ''}）`}
      className="min-w-0 border border-gray-200 dark:border-gray-700 rounded-lg p-3">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-start gap-2 min-w-0">
          <button type="button" onClick={() => store.toggleLabPin(labSeriesPinTarget(series, store.preferences.pinnedLabItems))}
            title={pinned ? '取消釘選' : '釘選到重點摘要'}
            aria-label={`${pinned ? '取消釘選' : '釘選'} ${series.subItem}（${description}）`} aria-pressed={pinned}
            className={`shrink-0 text-sm cursor-pointer ${pinned ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500 hover:text-amber-500'}`}>
            {pinned ? '★' : '☆'}
          </button>
          <h3 className="text-sm font-medium text-gray-800 dark:text-gray-100 break-words">{series.subItem}</h3>
        </div>
        {outOfRangeCount > 0 && <span className="text-xs text-red-600 dark:text-red-400 shrink-0">{outOfRangeCount} 次超出參考</span>}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 break-words">{series.testGroups.filter(Boolean).join(' / ')}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2 break-all">{description}</p>
      {series.code && <p className="text-xs text-gray-500 dark:text-gray-400 font-mono mb-2 break-all">代碼：{series.code}</p>}
      <div className="text-teal-700 dark:text-teal-400" aria-hidden="true">
        <ResponsiveContainer width="100%" height={120}>
          <LineChart data={points}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.15} />
            <XAxis dataKey="date" hide />
            <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: 'currentColor' }} width={40} />
            <Tooltip formatter={value => [series.unit ? `${value} ${series.unit}` : value, series.subItem]}
              labelFormatter={label => `日期：${label}`} />
            {series.consistentReference && refLow !== null && refHigh !== null && (
              <ReferenceArea y1={refLow} y2={refHigh} fill="#059669" fillOpacity={0.12} />
            )}
            {series.consistentReference && refLow !== null && <ReferenceLine y={refLow} stroke="#059669" strokeDasharray="3 3" />}
            {series.consistentReference && refHigh !== null && <ReferenceLine y={refHigh} stroke="#059669" strokeDasharray="3 3" />}
            {target?.low !== undefined && (
              <ReferenceLine y={target.low} stroke={TARGET_LINE_COLOR} strokeDasharray="6 3" ifOverflow="extendDomain" />
            )}
            {target?.high !== undefined && (
              <ReferenceLine y={target.high} stroke={TARGET_LINE_COLOR} strokeDasharray="6 3" ifOverflow="extendDomain" />
            )}
            {placement?.lines.map(x => <ReferenceLine key={x} x={x} stroke={MARKER_LINE_COLOR} strokeDasharray="2 2" />)}
            <Line type="linear" dataKey="value" stroke="currentColor" strokeWidth={1.5} isAnimationActive={false}
              dot={props => <circle key={props.payload.key} cx={props.cx} cy={props.cy} r={3}
                fill={props.payload.outOfRange ? '#f87171' : 'currentColor'} stroke="none" />} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-between gap-2 text-xs text-gray-500 dark:text-gray-400 mt-1">
        <span>{points[0]?.date}</span><span>{points[points.length - 1]?.date}</span>
      </div>
      {target && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          個人目標：<span className="font-mono">{describeTarget(target)}</span>{series.unit ? ` ${series.unit}` : ''} · {targetOutsideCount} / {points.length} 筆超出
        </p>
      )}
      {!series.consistentReference && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">參考區間曾變更，不顯示共用參考帶；請查看逐筆紀錄。</p>}
      {overlay && placement && (
        <p className="mt-2 text-xs text-blue-700 dark:text-blue-400 break-words">{describeMedicationOverlay(overlay.name, placement)}</p>
      )}
      <details className="mt-3 text-xs text-gray-600 dark:text-gray-300" open={points.length === 1}>
        <summary className="cursor-pointer text-teal-700 dark:text-teal-400">逐筆檢驗數值（{points.length} 筆）</summary>
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-left">
            <caption className="sr-only">{series.subItem} · {description} · 逐筆檢驗紀錄</caption>
            <thead><tr className="border-b border-gray-200 dark:border-gray-700">
              {['日期', '數值', '單位', '參考區間', '院所／來源'].map(heading => <th key={heading} scope="col" className="p-2 font-medium whitespace-nowrap">{heading}</th>)}
            </tr></thead>
            <tbody>{points.map(point => (
              <tr key={point.key} className="border-b border-gray-100 dark:border-gray-700/60 align-top">
                <td className="p-2 whitespace-nowrap font-mono">{point.date}</td>
                <td className={`p-2 font-mono ${point.outOfRange ? 'text-red-600 dark:text-red-400' : ''}`}>
                  {point.value}{point.outOfRange && <span className="block font-sans">超出參考</span>}
                </td>
                <td className="p-2 font-mono">{point.record.unit || '未提供'}</td>
                <td className="p-2 whitespace-pre-wrap break-words font-mono">{labReference(point.record)}</td>
                <td className="p-2 min-w-32 break-all">
                  <p>{point.record.hospital || '院所未提供'} · {series.source || '來源未提供'}</p>
                  <RecordOrigins origins={point.record.origins} />
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
      <TargetEditor seriesKey={series.key} subItem={series.subItem} unit={series.unit} />
    </article>
  );
}
