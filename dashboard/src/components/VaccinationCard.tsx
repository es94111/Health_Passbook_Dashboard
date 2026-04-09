import type { Vaccination } from '../parsers/types';

interface Props {
  vaccinations: Vaccination[];
}

export default function VaccinationCard({ vaccinations }: Props) {
  const sorted = [...vaccinations].sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">疫苗接種紀錄</h2>
      {sorted.length === 0 ? (
        <p className="text-gray-400 text-sm">無接種紀錄</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2 font-medium">日期</th>
                <th className="pb-2 font-medium">疫苗</th>
                <th className="pb-2 font-medium">接種地點</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((v, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="py-2 text-gray-600 whitespace-nowrap">
                    {v.date.toLocaleDateString('zh-TW')}
                  </td>
                  <td className="py-2 text-gray-800">{v.vaccine}</td>
                  <td className="py-2 text-gray-500">{v.location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
