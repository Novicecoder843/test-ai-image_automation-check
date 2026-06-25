import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { GoogleGenAI } from '@google/genai';

// Vision service for cleanliness verification

export interface VisionResult {
  passed: boolean;
  score: number;        // 0..100
  confidence: number;   // 0..100
  issues: string[];
  raw?: unknown;
  provider?: 'anthropic' | 'openai' | 'gemini';
  model?: string;
}

const SYSTEM_PROMPT = `You are an AI inspector for facility cleanliness verification.
You will be shown a REFERENCE image (a clean, expected state) and an UPLOADED
image (a janitor's completion photo). Decide whether the uploaded image meets
the cleanliness standard set by the reference.

Look specifically for: trash, stains, spills, dirt, dust, scattered items,
overflowing bins, broken/displaced fixtures, water on floors, floor stains,
wet patches, dirt trails, unclean grout, mud, and debris. Pay special
attention to floor and surface cleanliness — a visible floor stain must
lower the score significantly even when the rest of the room looks tidy.
Do NOT penalise benign lighting or angle differences.

You MUST respond with a single JSON object and NOTHING else, using EXACTLY
this schema:

{
  "passed": boolean,
  "score": integer 0-100,
  "confidence": integer 0-100,
  "issues": string[]
}

Rules:
- "passed" = true only when the uploaded image looks clean and comparable to
  the reference.
- "score" = overall cleanliness (100 = spotless, 0 = filthy). Use the full
  0-100 range proportionally — minor dust might score 75-85, visible floor
  stains should score below 50, moderate mess 50-70.
- "confidence" = how sure you are about the verdict.
- "issues" = short list of concrete problems (empty array when passed).
- Do not add any prose, markdown fences, or commentary outside the JSON.`;

const USER_INSTRUCTION =
  'Reference image (target clean state) is first; uploaded janitor image is second. ' +
  'Verify cleanliness and respond with the required JSON.';

// Shared helpers

function parseStrictJson(content: string): Record<string, unknown> | null {
  if (!content) return null;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalize(raw: Record<string, unknown> | null): VisionResult {
  if (!raw) {
    return { passed: false, score: 0, confidence: 0, issues: ['no_vision_response'], raw };
  }
  const issuesRaw = (raw as { issues?: unknown }).issues;
  const issues: string[] = Array.isArray(issuesRaw)
    ? issuesRaw.map((x) => String(x)).filter(Boolean)
    : [];
  return {
    passed: Boolean((raw as { passed?: unknown }).passed),
    score: clampInt((raw as { score?: unknown }).score, 0, 100, 0),
    confidence: clampInt((raw as { confidence?: unknown }).confidence, 0, 100, 0),
    issues,
    raw,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

const ALLOWED_VISION_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// Fetch image as base64 for API upload
async function fetchImageAsBase64(
  imageUrl: string,
  timeoutMs: number
): Promise<{ base64: string; mediaType: string }> {
  const res = await fetchWithTimeout(imageUrl, { method: 'GET' }, timeoutMs);
  if (!res.ok) {
    throw new Error(`Failed to fetch image (${res.status} ${res.statusText}): ${imageUrl}`);
  }
  const contentTypeHeader = (res.headers.get('content-type') ?? '').toLowerCase();
  const mime = contentTypeHeader.split(';')[0]?.trim() || guessMimeFromUrl(imageUrl);
  if (!ALLOWED_VISION_MIME.has(mime)) {
    throw new Error(
      `Vision provider rejected mime type "${mime}" for ${imageUrl}. ` +
        `Allowed: ${Array.from(ALLOWED_VISION_MIME).join(', ')}`
    );
  }

  const contentLength = Number(res.headers.get('content-length') || '0');
  const MAX_BYTES = 15 * 1024 * 1024; // 15MB
  if (contentLength > MAX_BYTES) {
    throw new Error(`Image size ${contentLength} exceeds maximum allowed 15MB`);
  }

  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_BYTES) {
    throw new Error(`Image buffer size ${arrayBuffer.byteLength} exceeds maximum allowed 15MB`);
  }

  const buf = Buffer.from(arrayBuffer);
  return { base64: buf.toString('base64'), mediaType: mime };
}

function guessMimeFromUrl(url: string): string {
  const lower = url.toLowerCase().split('?')[0] ?? '';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

// Provider: Anthropic Claude

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

async function analyzeWithAnthropic(
  referenceImageUrl: string,
  uploadedImageUrl: string
): Promise<VisionResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  // Fetch images as base64
  const [reference, uploaded] = await Promise.all([
    fetchImageAsBase64(referenceImageUrl, env.ANTHROPIC_TIMEOUT_MS),
    fetchImageAsBase64(uploadedImageUrl, env.ANTHROPIC_TIMEOUT_MS),
  ]);

  const body = {
    model: env.ANTHROPIC_VISION_MODEL,
    max_tokens: env.ANTHROPIC_MAX_TOKENS,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: USER_INSTRUCTION },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: reference.mediaType,
              data: reference.base64,
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: uploaded.mediaType,
              data: uploaded.base64,
            },
          },
        ],
      },
    ],
  };

  const startedAt = Date.now();
  let json: AnthropicMessagesResponse | undefined;
  let attempts = 0;
  const maxAttempts = 5;
  const baseDelayMs = 2000;

  while (attempts < maxAttempts) {
    try {
      const response = await fetchWithTimeout(
        env.ANTHROPIC_API_URL,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': env.ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
        },
        env.ANTHROPIC_TIMEOUT_MS
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      json = (await response.json()) as AnthropicMessagesResponse;
      if (json.error) {
        throw new Error(`Anthropic error: ${json.error.type ?? 'unknown'} ${json.error.message ?? ''}`);
      }
      break;
    } catch (error: any) {
      attempts++;
      const errorMessage = error?.message?.toLowerCase() || '';
      const isRateLimited =
        errorMessage.includes('503') ||
        errorMessage.includes('429') ||
        errorMessage.includes('overloaded') ||
        errorMessage.includes('too many requests') ||
        errorMessage.includes('http 429') ||
        errorMessage.includes('http 503') ||
        errorMessage.includes('http 529');

      if (!isRateLimited || attempts >= maxAttempts) {
        logger.error({ attempt: attempts, err: error.message }, 'anthropic vision failed');
        throw new Error(`Anthropic vision call failed: ${error.message}`);
      }

      const delayMs = baseDelayMs * Math.pow(2, attempts - 1);
      logger.warn(
        { attempt: attempts, err: error.message, delayMs },
        'Anthropic API is currently overloaded. Retrying shortly...'
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const text =
    (json!.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .trim() ?? '';

  const result: VisionResult = {
    ...normalize(parseStrictJson(text)),
    provider: 'anthropic',
    model: env.ANTHROPIC_VISION_MODEL,
  };

  logger.info(
    {
      provider: 'anthropic',
      model: env.ANTHROPIC_VISION_MODEL,
      durationMs: Date.now() - startedAt,
      stopReason: json!.stop_reason,
      usage: json!.usage,
      passed: result.passed,
      score: result.score,
      confidence: result.confidence,
      issueCount: result.issues.length,
    },
    'vision analysis complete'
  );

  return result;
}

// Provider: OpenAI GPT-4o

function buildOpenAiUserContent(referenceUrl: string, uploadedUrl: string) {
  return [
    { type: 'text', text: USER_INSTRUCTION },
    { type: 'image_url', image_url: { url: referenceUrl, detail: 'high' } },
    { type: 'image_url', image_url: { url: uploadedUrl, detail: 'high' } },
  ];
}

async function analyzeWithOpenAi(
  referenceImageUrl: string,
  uploadedImageUrl: string
): Promise<VisionResult> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');

  const [reference, uploaded] = await Promise.all([
    fetchImageAsBase64(referenceImageUrl, env.OPENAI_TIMEOUT_MS || 30000),
    fetchImageAsBase64(uploadedImageUrl, env.OPENAI_TIMEOUT_MS || 30000),
  ]);

  const body = {
    model: env.OPENAI_VISION_MODEL,
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 400,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { 
        role: 'user', 
        content: [
          { type: 'text', text: USER_INSTRUCTION },
          { type: 'image_url', image_url: { url: `data:${reference.mediaType};base64,${reference.base64}`, detail: 'high' } },
          { type: 'image_url', image_url: { url: `data:${uploaded.mediaType};base64,${uploaded.base64}`, detail: 'high' } },
        ] 
      },
    ],
  };

  const startedAt = Date.now();
  let json: { choices?: Array<{ message?: { content?: string } }> } | undefined;
  let attempts = 0;
  const maxAttempts = 5;
  const baseDelayMs = 2000;

  while (attempts < maxAttempts) {
    try {
      const response = await fetchWithTimeout(
        env.OPENAI_API_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify(body),
        },
        env.OPENAI_TIMEOUT_MS
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      break;
    } catch (error: any) {
      attempts++;
      const errorMessage = error?.message?.toLowerCase() || '';
      const isRateLimited =
        errorMessage.includes('503') ||
        errorMessage.includes('429') ||
        errorMessage.includes('overloaded') ||
        errorMessage.includes('too many requests') ||
        errorMessage.includes('http 429') ||
        errorMessage.includes('http 503') ||
        errorMessage.includes('http 529');

      if (!isRateLimited || attempts >= maxAttempts) {
        logger.error({ attempt: attempts, err: error.message }, 'openai vision failed');
        throw new Error(`OpenAI vision call failed: ${error.message}`);
      }

      const delayMs = baseDelayMs * Math.pow(2, attempts - 1);
      logger.warn(
        { attempt: attempts, err: error.message, delayMs },
        'OpenAI API is currently overloaded. Retrying shortly...'
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const content = json?.choices?.[0]?.message?.content ?? '';

  const result: VisionResult = {
    ...normalize(parseStrictJson(content)),
    provider: 'openai',
    model: env.OPENAI_VISION_MODEL,
  };

  logger.info(
    {
      provider: 'openai',
      model: env.OPENAI_VISION_MODEL,
      durationMs: Date.now() - startedAt,
      passed: result.passed,
      score: result.score,
      confidence: result.confidence,
      issueCount: result.issues.length,
    },
    'vision analysis complete'
  );

  return result;
}

// Provider: Google Gemini

async function analyzeWithGemini(
  referenceImageUrl: string,
  uploadedImageUrl: string
): Promise<VisionResult> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  // Fetch images as base64
  const [reference, uploaded] = await Promise.all([
    fetchImageAsBase64(referenceImageUrl, env.ANTHROPIC_TIMEOUT_MS),
    fetchImageAsBase64(uploadedImageUrl, env.ANTHROPIC_TIMEOUT_MS),
  ]);

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const startedAt = Date.now();
  
  let responseText = '';
  let attempts = 0;
  const maxAttempts = 5;
  const baseDelayMs = 2000;
  
  // Retry loop
  while (attempts < maxAttempts) {
    try {
      const response = await ai.models.generateContent({
        model: env.GEMINI_VISION_MODEL,
        contents: [
          SYSTEM_PROMPT,
          USER_INSTRUCTION,
          {
            inlineData: {
              mimeType: reference.mediaType,
              data: reference.base64,
            }
          },
          {
            inlineData: {
              mimeType: uploaded.mediaType,
              data: uploaded.base64,
            }
          }
        ],
        config: {
          responseMimeType: 'application/json',
          temperature: 0,
        }
      });
      
      responseText = response?.text || '';
      break; // Success
      
    } catch (error: any) {
      attempts++;
      const errorMessage = error?.message?.toLowerCase() || '';
      const isRateLimited = 
        errorMessage.includes('503') || 
        errorMessage.includes('429') || 
        errorMessage.includes('overloaded') || 
        errorMessage.includes('too many requests');

      if (!isRateLimited || attempts >= maxAttempts) {
        throw error;
      }
      
      // Exponential backoff
      const delayMs = baseDelayMs * Math.pow(2, attempts - 1);
      logger.warn(
        { attempt: attempts, err: error.message, delayMs }, 
        'Gemini API is currently overloaded. Retrying shortly...'
      );
      
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Normalize response
  const result: VisionResult = {
    ...normalize(parseStrictJson(responseText)),
    provider: 'gemini',
    model: env.GEMINI_VISION_MODEL,
  };

  logger.info(
    {
      provider: 'gemini',
      model: env.GEMINI_VISION_MODEL,
      durationMs: Date.now() - startedAt,
      passed: result.passed,
      score: result.score,
      confidence: result.confidence,
      issueCount: result.issues.length,
    },
    'Vision analysis complete'
  );

  return result;
}

// Public entrypoint

export async function analyzeCleanliness(
  referenceImageUrl: string,
  uploadedImageUrl: string
): Promise<VisionResult> {
  if (!referenceImageUrl || !uploadedImageUrl) {
    throw new Error('Both referenceImageUrl and uploadedImageUrl are required');
  }
  if (env.VISION_PROVIDER === 'gemini') {
    return analyzeWithGemini(referenceImageUrl, uploadedImageUrl);
  }
  if (env.VISION_PROVIDER === 'openai') {
    return analyzeWithOpenAi(referenceImageUrl, uploadedImageUrl);
  }
  return analyzeWithAnthropic(referenceImageUrl, uploadedImageUrl);
}

