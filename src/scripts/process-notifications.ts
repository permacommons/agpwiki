import { setTimeout as sleep } from 'node:timers/promises';
import debug from '../../util/debug.js';
import { initializePostgreSQL } from '../db.js';
import {
  notificationJobHandlers,
} from '../services/forum-notification-service.js';
import {
  claimPendingNotificationJobs,
  markNotificationJobFailed,
  markNotificationJobPendingRetry,
  markNotificationJobProcessed,
  resetProcessingNotificationJobs,
} from '../services/notification-queue.js';

const POLL_INTERVAL_MS = 5000;
const EMPTY_POLL_INTERVAL_MS = 15000;
const CLAIM_BATCH_SIZE = 10;
const MAX_ATTEMPTS = 8;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000];

let shouldStop = false;

const getRetryDelayMs = (attemptCount: number) =>
  RETRY_DELAYS_MS[Math.min(attemptCount, RETRY_DELAYS_MS.length - 1)];

const processOneJob = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  job: Awaited<ReturnType<typeof claimPendingNotificationJobs>>['jobs'][number]
) => {
  const handler = notificationJobHandlers[job.type as keyof typeof notificationJobHandlers];
  if (!handler) {
    throw new Error(`Unsupported notification job type: ${job.type}`);
  }
  await handler(dal, job as never);
};

const main = async () => {
  const dal = await initializePostgreSQL();
  const resetCount = await resetProcessingNotificationJobs(dal);
  if (resetCount > 0) {
    debug.app(`Reset ${resetCount} in-flight notification job(s) back to pending on startup.`);
  }

  process.on('SIGINT', () => {
    debug.app('Notification worker received SIGINT, stopping after the current cycle.');
    shouldStop = true;
  });
  process.on('SIGTERM', () => {
    debug.app('Notification worker received SIGTERM, stopping after the current cycle.');
    shouldStop = true;
  });

  while (!shouldStop) {
    const { jobs } = await claimPendingNotificationJobs(dal, CLAIM_BATCH_SIZE);
    if (jobs.length === 0) {
      await sleep(EMPTY_POLL_INTERVAL_MS);
      continue;
    }

    for (const job of jobs) {
      try {
        await processOneJob(dal, job);
        await markNotificationJobProcessed(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug.error(`Notification job ${job.id} failed`, {
          error: error instanceof Error ? error : new Error(message),
        });
        if ((job.attemptCount ?? 0) + 1 >= MAX_ATTEMPTS) {
          await markNotificationJobFailed(job.id, message);
        } else {
          await markNotificationJobPendingRetry(
            job.id,
            message,
            new Date(Date.now() + getRetryDelayMs(job.attemptCount ?? 0))
          );
        }
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
};

main().catch(error => {
  debug.error('Failed to process notifications', { error });
  process.exitCode = 1;
});
