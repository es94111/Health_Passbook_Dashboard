import { useEffect, useState } from 'react';
import { listUsers, deleteUser, type UserInfo } from '../api';

interface Props {
  currentUserId: string;
  onClose: () => void;
}

export default function AdminPanel({ currentUserId, onClose }: Props) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setUsers(await listUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入失敗');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function handleDelete(user: UserInfo) {
    if (!window.confirm(`確定要刪除使用者「${user.username}」及其所有資料？`)) return;
    setDeleting(user.id);
    try {
      await deleteUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : '刪除失敗');
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-800">使用者管理</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <p className="text-red-600 text-sm">{error}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 text-xs border-b border-gray-100">
                  <th className="pb-2 font-medium">帳號</th>
                  <th className="pb-2 font-medium">角色</th>
                  <th className="pb-2 font-medium">註冊日期</th>
                  <th className="pb-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-3 font-medium text-gray-800">
                      {user.username}
                      {user.id === currentUserId && (
                        <span className="ml-2 text-xs text-gray-400">(您)</span>
                      )}
                    </td>
                    <td className="py-3">
                      {user.isAdmin ? (
                        <span className="inline-block bg-teal-100 text-teal-700 text-xs px-2 py-0.5 rounded-full">管理員</span>
                      ) : (
                        <span className="inline-block bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full">一般</span>
                      )}
                    </td>
                    <td className="py-3 text-gray-400 text-xs">
                      {new Date(user.createdAt).toLocaleDateString('zh-TW')}
                    </td>
                    <td className="py-3 text-right">
                      {user.id !== currentUserId && (
                        <button
                          onClick={() => void handleDelete(user)}
                          disabled={deleting === user.id}
                          className="text-xs text-red-500 hover:text-red-700 disabled:opacity-40"
                        >
                          {deleting === user.id ? '刪除中…' : '刪除'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-6 py-3 border-t border-gray-100">
          <p className="text-xs text-gray-400">共 {users.length} 位使用者</p>
        </div>
      </div>
    </div>
  );
}