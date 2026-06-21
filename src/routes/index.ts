import { Router } from 'express';
import { uploadImage } from '../middlewares/upload.js';
import {
  adminUploadReference,
  janitorUploadCompletion,
  getTaskResult,
  getUploadRequirements,
  adminUploadReferencesBulk,
  janitorUploadCompletionsBulk,
  getBatchStatus,
} from '../controllers/cleaning.controller.js';
import { getCleaningQueueStats } from '../queue/cleaning.queue.js';
import { pool } from '../db/pool.js';

/**
 * API routes.
 *
 *   POST /api/admin/upload-reference         (multipart, field: image)
 *   POST /api/janitor/upload-completion      (multipart, field: image)
 *   GET  /api/upload-requirements          (minimum phone photo + AI config)
 *   GET  /api/tasks/:taskId/result           [?includeHistory=true|false]
 *
 * Plus operational endpoints:
 *   GET /api/health         (db + redis ping)
 *   GET /api/queue-stats    (BullMQ counts)
 */
const router = Router();

router.post(
  '/admin/upload-reference',
  uploadImage.single('image'),
  adminUploadReference
);

router.post(
  '/admin/upload-references/bulk',
  uploadImage.array('images'),
  adminUploadReferencesBulk
);

router.post(
  '/janitor/upload-completion',
  uploadImage.single('image'),
  janitorUploadCompletion
);

router.post(
  '/janitor/upload-completions/bulk',
  uploadImage.array('images'),
  janitorUploadCompletionsBulk
);

router.get('/janitor/batches/:batchId/status', getBatchStatus);

router.get('/tasks/:taskId/result', getTaskResult);

router.get('/upload-requirements', getUploadRequirements);

router.get('/queue-stats', async (_req, res, next) => {
  try {
    const stats = await getCleaningQueueStats();
    res.json({ success: true, results: stats });
  } catch (err) {
    next(err);
  }
});

router.get('/health', async (_req, res) => {
  const result: Record<string, unknown> = { db: 'unknown', timestamp: new Date().toISOString() };
  try {
    await pool.query('SELECT 1');
    result.db = 'ok';
  } catch (err) {
    result.db = `error: ${(err as Error).message}`;
  }
  res.json({ success: true, results: result });
});

export default router;
