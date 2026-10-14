import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';

export type JobHandler = (data: any) => Promise<void>;

export interface JobQueue {
  readonly mode: 'bullmq' | 'inline';
  register(name: string, handler: JobHandler): void;
  enqueue(name: string, data: unknown, opts?: { delayMs?: number; jobId?: string }): Promise<void>;
  /** Resolves when all inline jobs scheduled so far have settled (tests). */
  drain(): Promise<void>;
  close(): Promise<void>;
}

const QUEUE = 'branchharbor';

/**
 * Background jobs. With REDIS_URL, uses BullMQ (retries with backoff). Without it, jobs run
 * inline on the next tick in-process — fine for development and tests, logged as degraded.
 */
export async function createJobQueue(cfg: Config, log: FastifyBaseLogger): Promise<JobQueue> {
  const handlers = new Map<string, JobHandler>();
  const run = async (name: string, data: unknown) => {
    const h = handlers.get(name);
    if (!h) return log.warn({ name }, '[jobs] no handler registered');
    await h(data);
  };

  if (cfg.REDIS_URL) {
    const { Queue, Worker } = await import('bullmq');
    const { Redis } = await import('ioredis');
    const connection = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(QUEUE, { connection });
    const worker = cfg.RUN_WORKERS
      ? new Worker(QUEUE, async (job) => run(job.name, job.data), { connection, concurrency: 5 })
      : null;
    worker?.on('failed', (job, err) => log.error({ job: job?.name, err }, '[jobs] job failed'));
    log.info('[jobs] BullMQ queue connected');
    return {
      mode: 'bullmq',
      register: (n, h) => void handlers.set(n, h),
      async enqueue(name, data, opts) {
        await queue.add(name, data, { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, delay: opts?.delayMs, jobId: opts?.jobId, removeOnComplete: 1000, removeOnFail: 5000 });
      },
      drain: async () => {},
      async close() {
        await worker?.close();
        await queue.close();
        connection.disconnect();
      },
    };
  }

  log.warn('[jobs] REDIS_URL not set — running background jobs inline (no retries/persistence)');
  const pending = new Set<Promise<void>>();
  return {
    mode: 'inline',
    register: (n, h) => void handlers.set(n, h),
    async enqueue(name, data, opts) {
      const p: Promise<void> = new Promise<void>((resolve) => setTimeout(resolve, opts?.delayMs && opts.delayMs < 60_000 ? opts.delayMs : 0))
        .then(() => run(name, data))
        .catch((err) => log.error({ err, name }, '[jobs] inline job failed'))
        .finally(() => pending.delete(p));
      pending.add(p);
    },
    async drain() {
      while (pending.size) await Promise.all([...pending]);
    },
    async close() {
      await Promise.allSettled([...pending]);
    },
  };
}
