import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
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

const batchParams = z.object({
  batchId: z.string().min(1),
});

const bulkAdminMetadataSchema = z.array(adminUploadBody);
const bulkJanitorMetadataSchema = z.array(janitorUploadBody);

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

/**
 * POST /admin/upload-references/bulk
 */
export async function adminUploadReferencesBulk(req: Request, res: Response, next: NextFunction) {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) throw new AppError('images are required', { status: 400 });
    const metadataStr = req.body.metadata;
    if (!metadataStr) throw new AppError('metadata field is required', { status: 400 });

    let metadataArr;
    try {
      metadataArr = JSON.parse(metadataStr);
    } catch {
      throw new AppError('metadata must be a valid JSON array', { status: 400 });
    }

    const parsedMeta = bulkAdminMetadataSchema.safeParse(metadataArr);
    if (!parsedMeta.success) {
      throw new AppError('Invalid metadata', { status: 400, details: parsedMeta.error.format() });
    }

    if (parsedMeta.data.length !== files.length) {
      throw new AppError('metadata length must match number of uploaded files', { status: 400 });
    }

    const batch_id = crypto.randomUUID();
    const results = [];

    // Process sequentially to avoid memory spikes with embeddings
    for (let i = 0; i < files.length; i++) {
      const result = await cleaningService.adminUploadReference({
        ...parsedMeta.data[i],
        file: files[i],
        batch_id,
      });
      results.push(result);
    }

    res.status(201).json({ success: true, batch_id, results });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /janitor/upload-completions/bulk
 */
export async function janitorUploadCompletionsBulk(req: Request, res: Response, next: NextFunction) {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) throw new AppError('images are required', { status: 400 });
    const metadataStr = req.body.metadata;
    if (!metadataStr) throw new AppError('metadata field is required', { status: 400 });

    let metadataArr;
    try {
      metadataArr = JSON.parse(metadataStr);
    } catch {
      throw new AppError('metadata must be a valid JSON array', { status: 400 });
    }

    const parsedMeta = bulkJanitorMetadataSchema.safeParse(metadataArr);
    if (!parsedMeta.success) {
      throw new AppError('Invalid metadata', { status: 400, details: parsedMeta.error.format() });
    }

    if (parsedMeta.data.length !== files.length) {
      throw new AppError('metadata length must match number of uploaded files', { status: 400 });
    }

    const batch_id = crypto.randomUUID();

    const promises = files.map((file, idx) => {
      const meta = parsedMeta.data[idx];
      return cleaningService.janitorUploadCompletion({
        ...meta,
        file,
        batch_id,
      });
    });

    await Promise.all(promises);

    res.status(202).json({ success: true, batch_id });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /janitor/batches/:batchId/status
 */
export async function getBatchStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const params = batchParams.safeParse(req.params);
    if (!params.success) {
      throw new AppError('Invalid batchId', { status: 400, details: params.error.format() });
    }

    const status = await cleaningService.getBatchVerificationStatus(params.data.batchId);
    res.json({ success: true, results: status });
  } catch (err) {
    next(err);
  }
}

