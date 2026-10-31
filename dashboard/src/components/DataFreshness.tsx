import { STALE_DATA_DAYS, type Freshness } from '../lib/freshness';
import { formatDay } from '../lib/keySummary';

interface Props {
  freshness: Freshness;
}

export default function DataFreshness({ freshness }: Props) {
  const { latest, ageDays, stale } = freshness;
  if (!latest || ageDays === null) return null;

  return (
    <div className={`text-xs ${stale ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>
      <p>
        資料最新到 <span className="font-mono">{formatDay(latest)}</span>
        {ageDays === 0 ? '（今天）' : `（距今 ${ageDays} 天）`}
      </p>
      {stale && (
        <p>已超過 {STALE_DATA_DAYS} 天沒有新資料，若近期有就醫，請重新匯出並匯入最新資料。</p>
      )}
    </div>
  );
}
