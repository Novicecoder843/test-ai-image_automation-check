import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../middlewares/error-handler.js';
import * as cleaningService from '../services/cleaning.service.js';

/**
 * Zod schemas — multipart bodies arrive as strings, so coerce to numbers.
 */
const adminUploadBody = z.object({
  facility_id: z.coerce.number().int().positive(),
  template_id: z.coerce.number().int().positive().optional(),
  label: z.string().min(1).max(255).optional(),
  uploaded_by: z.string().max(100).optional(),
});

const janitorUploadBody = z.object({
  task_id: z.coerce.number().int().positive(),
  facility_id: z.coerce.number().int().positive(),
  template_id: env.SCENE_MATCH_ENFORCE
    ? z.coerce.number().int().positive()
    : z.coerce.number().int().positive().optional(),
  janitor_id: z.string().max(100).optional(),
});

const taskParams = z.object({
  taskId: z.coerce.number().int().positive(),
});

const taskQuery = z.object({
  includeHistory: z.enum(['true', 'false']).optional(),
});

/**
 * POST /admin/upload-reference
 */
export async function adminUploadReference(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError('image file is required (form field "image")', { status: 400, stage: 'parse-input' });
    const body = adminUploadBody.safeParse(req.body);
    if (!body.success) {
      throw new AppError('Invalid body', { status: 400, stage: 'parse-input', details: body.error.format() });
    }
    logger.info(
      {
        facility_id: body.data.facility_id,
        template_id: body.data.template_id,
        label: body.data.label,
        file_name: req.file.originalname,
        file_mime: req.file.mimetype,
        file_size: req.file.size,
      },
      'admin upload-reference: incoming'
    );

    const result = await cleaningService.adminUploadReference({
      ...body.data,
      file: req.file,
    });

    logger.info({ referenceId: result.id, dim: result.embedding_dim }, 'admin upload-reference: ok');
    res.status(201).json({ success: true, results: result });
  } catch (err) {
    console.log(err)
    next(err);
  }
}

/**
 * POST /janitor/upload-completion
 */
export async function janitorUploadCompletion(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError('image file is required (form field "image")', { status: 400, stage: 'parse-input' });
    const body = janitorUploadBody.safeParse(req.body);
    if (!body.success) {
      throw new AppError('Invalid body', { status: 400, stage: 'parse-input', details: body.error.format() });
    }
    logger.info(
      {
        task_id: body.data.task_id,
        facility_id: body.data.facility_id,
        template_id: body.data.template_id,
        file_name: req.file.originalname,
        file_size: req.file.size,
      },
      'janitor upload-completion: incoming'
    );

    const result = await cleaningService.janitorUploadCompletion({
      ...body.data,
      file: req.file,
    });

    res.status(202).json({ success: true, results: result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /tasks/:taskId/result?includeHistory=true|false
 */
export async function getTaskResult(req: Request, res: Response, next: NextFunction) {
  try {
    const params = taskParams.safeParse(req.params);
    if (!params.success) {
      throw new AppError('Invalid taskId', { status: 400, stage: 'parse-input', details: params.error.format() });
    }
    const query = taskQuery.safeParse(req.query);
    if (!query.success) {
      throw new AppError('Invalid query', { status: 400, stage: 'parse-input', details: query.error.format() });
    }

    const latest = await cleaningService.getTaskVerificationResult(params.data.taskId);
    if (!latest) {
      throw new AppError('No verification record found for this task', { status: 404, stage: 'lookup' });
    }
    if (query.data.includeHistory === 'true') {
      const history = await cleaningService.getTaskVerificationHistory(params.data.taskId);
      res.json({ success: true, results: { latest, history } });
      return;
    }
    res.json({ success: true, results: latest });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /upload-requirements
 */
export function getUploadRequirements(_req: Request, res: Response) {
  res.json({ success: true, results: cleaningService.fetchUploadRequirements() });
}
