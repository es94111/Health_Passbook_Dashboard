import type { RecordOrigin } from '../parsers/types';
import { originLabel, rawResourceText } from '../lib/clinicalRecords';

export function RecordOrigins({ origins = [] }: { origins?: RecordOrigin[] }) {
  const labels = [...new Set(origins.map(originLabel))];
  return labels.length > 0 ? (
    <ul className="space-y-1 text-xs text-gray-500 dark:text-gray-400 break-all">
      {labels.map(label => <li key={label}>{label}</li>)}
    </ul>
  ) : null;
}

export default function ClinicalRecordDetails({ id, origins, relatedResources = [], rawResource }: {
  id: string;
  origins?: RecordOrigin[];
  relatedResources?: string[];
  rawResource: Record<string, unknown>;
}) {
  return (
    <details className="mt-3 text-sm text-gray-600 dark:text-gray-300">
      <summary className="cursor-pointer text-teal-700 dark:text-teal-400">原始資源與來源</summary>
      <div className="mt-2 space-y-2">
        <p className="break-all">資源 ID：<span className="font-mono">{id || '未提供'}</span></p>
        <RecordOrigins origins={origins} />
        {relatedResources.length > 0 && (
          <div>
            <p className="font-medium">關聯資源</p>
            <ul className="list-disc pl-5 font-mono text-xs break-all">
              {[...new Set(relatedResources)].map(reference => <li key={reference}>{reference}</li>)}
            </ul>
          </div>
        )}
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50 dark:bg-gray-900 p-3 text-xs font-mono">{rawResourceText(rawResource)}</pre>
      </div>
    </details>
  );
}
