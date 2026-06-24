import 'dotenv/config';
import { z } from 'zod';

/**
 * Strict env loader.
 * Strips stray quotes / inline `# comments` from every value before validation,
 * so badly-quoted .env lines can never break the app silently.
 */

function sanitize(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  let v = String(value).trim();
  const hashIdx = v.indexOf('#');
  if (hashIdx >= 0) v = v.slice(0, hashIdx).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  v = v.replace(/["']/g, '').trim();
  return v.length === 0 ? undefined : v;
}

const raw: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(process.env)) raw[k] = sanitize(v);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Postgres
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().int().positive().default(5432),
  PGUSER: z.string().default('postgres'),
  PGPASSWORD: z.string().default(''),
  PGDATABASE: z.string().default('AI_POC'),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  REDIS_TLS_REJECT_UNAUTHORIZED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  REDIS_TLS_CA: z.string().optional(),
  REDIS_TLS_SERVERNAME: z.string().optional(),

  // Storage
  STORAGE_DRIVER: z.enum(['local', 'gcs']).default('local'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),
  GCS_BUCKET_NAME: z.string().optional(),
  GCS_BASE_URL: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  // AI — CLIP embedder
  CLIP_MODEL_NAME: z.string().default('Xenova/clip-vit-base-patch32'),

  // AI — Vision provider (pluggable)
  VISION_PROVIDER: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),

  // Gemini
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_VISION_MODEL: z.string().default('gemini-2.5-flash'),

  // Anthropic Claude (default)
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_VISION_MODEL: z.string().default('claude-sonnet-4-5'),
  ANTHROPIC_API_URL: z.string().default('https://api.anthropic.com/v1/messages'),
  ANTHROPIC_VERSION: z.string().default('2023-06-01'),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().max(8192).default(600),

  // OpenAI (fallback — keep the wiring so you can flip back via VISION_PROVIDER)
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_VISION_MODEL: z.string().default('gpt-4o'),
  OPENAI_API_URL: z.string().default('https://api.openai.com/v1/chat/completions'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),

  // Rule engine — cosine similarity (0..1)
  CLEANING_SIMILARITY_PASS_THRESHOLD: z.coerce.number().min(-1).max(1).default(0.85),
  CLEANING_SIMILARITY_FAIL_THRESHOLD: z.coerce.number().min(-1).max(1).default(0.65),
  // Vision cleanliness score thresholds (0..100)
  CLEANING_VISION_PASS_SCORE: z.coerce.number().int().min(0).max(100).default(80),
  CLEANING_VISION_FAIL_SCORE: z.coerce.number().int().min(0).max(100).default(50),
  CLEANING_VISION_REVIEW_SCORE: z.coerce.number().int().min(0).max(100).default(65),
  // Overall score weights: overall = SCENE_WEIGHT * scene% + CLEANLINESS_WEIGHT * cleanliness%
  CLEANING_SCENE_WEIGHT: z.coerce.number().min(0).max(1).default(0.3),
  CLEANING_CLEANLINESS_WEIGHT: z.coerce.number().min(0).max(1).default(0.7),

  // Scene / task matching — reject wrong-area photos (corridor vs kitchen)
  SCENE_MATCH_ENFORCE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  SCENE_MATCH_MIN_SIMILARITY: z.coerce.number().min(-1).max(1).default(0.88),
  SCENE_MATCH_STRICT_TEMPLATE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),

  // Worker
  RUN_WORKER_IN_API: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // Image preprocessing (sharp)
  IMG_MAX_DIMENSION: z.coerce.number().int().min(224).max(8192).default(1024),
  IMG_OUTPUT_FORMAT: z.enum(['jpeg', 'webp']).default('jpeg'),
  IMG_OUTPUT_QUALITY: z.coerce.number().int().min(1).max(100).default(80),
  // Hard cap on decoded pixel count (defence against decompression-bomb DoS).
  IMG_DECODE_PIXEL_LIMIT: z.coerce.number().int().positive().default(50_000_000),
  // Accept HEIC/HEIF input (iPhone photos). Sharp transcodes to JPEG/WebP.
  IMG_ALLOW_HEIC: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  IMG_MAX_UPLOAD_MB: z.coerce.number().int().positive().max(50).default(15),

  // Image quality gate
  IMG_QUALITY_ENFORCE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  IMG_QUALITY_MIN_DIMENSION: z.coerce.number().int().positive().default(480),
  IMG_QUALITY_MIN_MEGAPIXELS: z.coerce.number().positive().default(0.3),
  IMG_QUALITY_MIN_SHARPNESS: z.coerce.number().min(0).default(1),
  IMG_QUALITY_MIN_BRIGHTNESS: z.coerce.number().min(0).max(255).default(25),
  IMG_QUALITY_MAX_BRIGHTNESS: z.coerce.number().min(0).max(255).default(235),
  IMG_QUALITY_MIN_ENTROPY: z.coerce.number().min(0).default(2.5),
  IMG_QUALITY_MIN_BYTES: z.coerce.number().int().positive().default(15_000),
});

const parsed = schema.safeParse(raw);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
