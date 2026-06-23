import multer from 'multer';
import type { Request } from 'express';
import { env } from '../config/env.js';

/**
 * Multer (memoryStorage) — uploads land in `req.file.buffer`, which is what
 * the preprocessing + embedding services expect.
 *
 * Whitelist mirrors what sharp can decode (JPEG / PNG / WebP / HEIC).
 * HEIC is gated by IMG_ALLOW_HEIC so deployments without libheif (rare; the
 * prebuilt sharp binaries ship it) can opt out.
 */

const BASE_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const HEIC_MIME = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];

const ALLOWED_MIME = new Set<string>(env.IMG_ALLOW_HEIC ? [...BASE_MIME, ...HEIC_MIME] : BASE_MIME);

const MAX_FILE_BYTES = env.IMG_MAX_UPLOAD_MB * 1024 * 1024;

export const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const mime = (file.mimetype ?? '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      cb(new Error(`Unsupported mime type: ${mime || 'unknown'}`));
      return;
    }
    cb(null, true);
  },
});

export const uploadImagesBulk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 50 },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const mime = (file.mimetype ?? '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      cb(new Error(`Unsupported mime type: ${mime || 'unknown'}`));
      return;
    }
    cb(null, true);
  },
});

export const ALLOWED_IMAGE_MIME_TYPES = Array.from(ALLOWED_MIME);
