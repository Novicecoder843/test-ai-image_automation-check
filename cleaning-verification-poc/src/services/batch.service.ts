import crypto from 'node:crypto';
import * as verificationRepo from '../repositories/cleaning-verification.repo.js';

export function generateBatchId(): string {
  return crypto.randomUUID();
}

export interface BatchItemResult<T> {
  ok: boolean;
  input_filename: string;
  task_id?: number;
  template_id?: number;
  data?: T;
  error?: { message: string; code?: string; stage?: string };
}

export async function getBatchStatus(
  batchId: string,
  kind: 'reference' | 'completion'
): Promise<{
  batch_id: string;
  kind: string;
  total: number;
  pending: number;
  processing: number;
  pass: number;
  fail: number;
  manual_review: number;
  invalid_task: number;
  error: number;
  items: Array<{ verification_id: number; task_id: number; status: string; rule_reason: string | null }>;
}> {
  if (kind === 'reference') {
    throw new Error('Reference batch tracking is not async; they are resolved synchronously');
  }

  const rows = await verificationRepo.getByBatchId(batchId);
  
  if (rows.length === 0) {
    throw new Error(`No records found for this batch_id: ${batchId}`);
  }

  const result = {
    batch_id: batchId,
    kind,
    total: rows.length,
    pending: 0,
    processing: 0,
    pass: 0,
    fail: 0,
    manual_review: 0,
    invalid_task: 0,
    error: 0,
    items: [] as Array<{ verification_id: number; task_id: number; status: string; rule_reason: string | null }>,
  };

  for (const row of rows) {
    if (row.status === 'PENDING') result.pending++;
    else if (row.status === 'PROCESSING') result.processing++;
    else if (row.status === 'PASS') result.pass++;
    else if (row.status === 'FAIL') result.fail++;
    else if (row.status === 'MANUAL_REVIEW') result.manual_review++;
    else if (row.status === 'INVALID_TASK') result.invalid_task++;
    else if (row.status === 'ERROR') result.error++;

    result.items.push({
      verification_id: row.id,
      task_id: row.task_id,
      status: row.status,
      rule_reason: row.rule_reason,
    });
  }

  return result;
}
