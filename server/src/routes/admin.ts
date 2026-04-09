import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { getUsers, deleteUser, getRecords, flattenRecords } from '../store.js';

const router = Router();

// All admin routes require admin role
router.use(requireAdmin);

// GET /api/admin/users  — list all users
router.get('/users', async (_req, res) => {
  const users = await getUsers();
  // Never expose passwordHash
  const safe = users.map(({ id, username, isAdmin, createdAt }) => ({
    id,
    username,
    isAdmin,
    createdAt,
  }));
  res.json(safe);
});

// DELETE /api/admin/users/:id  — delete a user and their data
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  // Prevent self-deletion
  if (id === req.user!.userId) {
    res.status(400).json({ error: '不能刪除自己的帳號' });
    return;
  }
  const deleted = await deleteUser(id);
  if (!deleted) {
    res.status(404).json({ error: '使用者不存在' });
    return;
  }
  res.json({ message: '使用者已刪除' });
});

// GET /api/admin/users/:id/data  — view a specific user's health data
router.get('/users/:id/data', async (req, res) => {
  const { id } = req.params;
  const stored = await getRecords(id);
  res.json(flattenRecords(stored));
});

export default router;