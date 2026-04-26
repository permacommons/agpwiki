import { randomUUID } from 'node:crypto';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';

import NotificationDelivery from '../models/notification-delivery.js';
import NotificationJob from '../models/notification-job.js';

export type NotificationJobStatus = 'pending' | 'processing' | 'processed' | 'failed';

export type NotificationJobRecord<TPayload = Record<string, unknown>> = {
  id: string;
  type: string;
  payload: TPayload;
  status: NotificationJobStatus;
  availableAt: Date;
  lockedAt: Date | null;
  lockToken: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: Date;
  processedAt: Date | null;
};

export const enqueueNotificationJob = async <TPayload extends Record<string, unknown>>(
  type: string,
  payload: TPayload,
  options: { availableAt?: Date } = {}
) =>
  NotificationJob.create({
    type,
    payload,
    status: 'pending',
    availableAt: options.availableAt ?? new Date(),
    attemptCount: 0,
    createdAt: new Date(),
  });

const toNotificationJobRecord = (
  row: Record<string, unknown>
): NotificationJobRecord<Record<string, unknown>> => ({
  id: row.id as string,
  type: row.type as string,
  payload: (row.payload as Record<string, unknown> | null) ?? {},
  status: row.status as NotificationJobStatus,
  availableAt: row.available_at as Date,
  lockedAt: (row.locked_at as Date | null) ?? null,
  lockToken: (row.lock_token as string | null) ?? null,
  attemptCount: Number(row.attempt_count) || 0,
  lastError: (row.last_error as string | null) ?? null,
  createdAt: row.created_at as Date,
  processedAt: (row.processed_at as Date | null) ?? null,
});

export const claimPendingNotificationJobs = async (
  dal: DataAccessLayer,
  limit: number,
  now = new Date()
) => {
  const lockToken = randomUUID();
  const result = await dal.query(
    `WITH claimed AS (
       SELECT id
       FROM ${NotificationJob.tableName}
       WHERE status = 'pending'
         AND available_at <= $1
       ORDER BY available_at ASC, created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ${NotificationJob.tableName} jobs
     SET status = 'processing',
         locked_at = $1,
         lock_token = $3
     FROM claimed
     WHERE jobs.id = claimed.id
     RETURNING jobs.*`,
    [now, limit, lockToken]
  );

  return {
    lockToken,
    jobs: result.rows.map(row => toNotificationJobRecord(row as Record<string, unknown>)),
  };
};

export const resetProcessingNotificationJobs = async (dal: DataAccessLayer) => {
  const result = await dal.query(
    `UPDATE ${NotificationJob.tableName}
     SET status = 'pending',
         locked_at = NULL,
         lock_token = NULL
     WHERE status = 'processing'
       AND locked_at IS NOT NULL
     RETURNING id`,
    []
  );

  return result.rows.length;
};

export const markNotificationJobProcessed = async (jobId: string) => {
  const job = await NotificationJob.filterWhere({ id: jobId }).first();
  if (!job) return;
  job.status = 'processed';
  job.processedAt = new Date();
  job.lockedAt = null;
  job.lockToken = null;
  await job.save();
};

export const markNotificationJobPendingRetry = async (
  jobId: string,
  lastError: string,
  availableAt: Date
) => {
  const job = await NotificationJob.filterWhere({ id: jobId }).first();
  if (!job) return;
  job.status = 'pending';
  job.availableAt = availableAt;
  job.attemptCount = (job.attemptCount ?? 0) + 1;
  job.lastError = lastError;
  job.lockedAt = null;
  job.lockToken = null;
  await job.save();
};

export const markNotificationJobFailed = async (jobId: string, lastError: string) => {
  const job = await NotificationJob.filterWhere({ id: jobId }).first();
  if (!job) return;
  job.status = 'failed';
  job.attemptCount = (job.attemptCount ?? 0) + 1;
  job.lastError = lastError;
  job.lockedAt = null;
  job.lockToken = null;
  await job.save();
};

export const recordNotificationDelivery = async ({
  jobId,
  userId,
  channel,
  status,
  error,
}: {
  jobId: string;
  userId: string;
  channel: string;
  status: string;
  error?: string | null;
}) => {
  const existing = await NotificationDelivery.filterWhere({ jobId, userId, channel }).first();
  if (existing) {
    if (existing.status === 'sent' && status !== 'sent') {
      return existing;
    }
    existing.status = status;
    existing.error = error ?? null;
    existing.attemptedAt = new Date();
    await existing.save();
    return existing;
  }

  return NotificationDelivery.create({
    jobId,
    userId,
    channel,
    status,
    error: error ?? null,
    attemptedAt: new Date(),
  });
};

export const listDeliveredUserIds = async (jobId: string, channel: string) => {
  const deliveries = await NotificationDelivery.filterWhere({
    jobId,
    channel,
    status: 'sent',
  }).run();
  return new Set(deliveries.map(delivery => delivery.userId));
};
