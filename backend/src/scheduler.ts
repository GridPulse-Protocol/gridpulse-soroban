/**
 * Background job runner.
 *
 * Two independent timers keep the grid moving without any human in the loop:
 *  - the *flush* job drains the reading queue to the chain in batches, and
 *  - the *settle* job closes a settlement window on a fixed cadence.
 *
 * Each job is guarded against re-entry (a slow run won't overlap itself), and
 * both are exposed for manual triggering through the HTTP API as well.
 */

import type { FastifyBaseLogger } from 'fastify';

import { ContractError } from './chain.js';
import type { AppConfig } from './config.js';
import { Relayer } from './relayer.js';
import type { FlushResult } from './relayer.js';

export interface SchedulerStatus {
  running: boolean;
  queue_size: number;
  batch_interval_seconds: number;
  settle_interval_seconds: number;
  last_flush_at: string | null;
  last_settle_at: string | null;
  last_flush: FlushResult | null;
  last_settle_error: string | null;
}

export class RelayScheduler {
  private flushTimer?: NodeJS.Timeout;
  private settleTimer?: NodeJS.Timeout;
  private flushBusy = false;
  private settleBusy = false;
  private lastFlushAt: Date | null = null;
  private lastSettleAt: Date | null = null;
  private lastFlush: FlushResult | null = null;
  private lastSettleError: string | null = null;

  constructor(
    private readonly relayer: Relayer,
    private readonly cfg: AppConfig,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    if (this.flushTimer) return;

    this.flushTimer = setInterval(
      () => void this.flush(),
      this.cfg.batchIntervalSeconds * 1000,
    );
    if (this.cfg.autoSettle) {
      this.settleTimer = setInterval(
        () => void this.settle(),
        this.cfg.settleIntervalSeconds * 1000,
      );
    }

    // Kick off an initial flush + settle shortly after boot.
    setTimeout(() => void this.flush(), 1_000);
    if (this.cfg.autoSettle) setTimeout(() => void this.settle(), 1_000);
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.settleTimer) clearInterval(this.settleTimer);
    this.flushTimer = undefined;
    this.settleTimer = undefined;
  }

  async flush(): Promise<FlushResult> {
    if (this.flushBusy) {
      return { submitted: 0, dropped: 0, remaining: this.relayer.queueSize() };
    }
    this.flushBusy = true;
    try {
      const result = await this.relayer.flush(this.cfg.batchSize);
      this.lastFlushAt = new Date();
      this.lastFlush = result;
      if (result.submitted > 0 || result.dropped > 0) {
        this.log.info(result, 'flushed reading batch');
      }
      return result;
    } finally {
      this.flushBusy = false;
    }
  }

  async settle(): Promise<void> {
    if (this.settleBusy) return;
    this.settleBusy = true;
    try {
      if (this.relayer.meterCount() === 0) {
        return; // nothing registered yet — nothing to do
      }
      await this.relayer.settle();
      this.lastSettleAt = new Date();
      this.lastSettleError = null;
      this.log.info('settlement window closed');
    } catch (err) {
      if (err instanceof ContractError && err.code === 9) {
        // NothingToSettle is expected between windows — not an error.
        this.lastSettleError = null;
        this.log.debug('nothing to settle yet');
      } else {
        this.lastSettleError = err instanceof Error ? err.message : 'settle failed';
        this.log.warn({ err }, 'settle failed');
      }
    } finally {
      this.settleBusy = false;
    }
  }

  status(): SchedulerStatus {
    return {
      running: Boolean(this.flushTimer),
      queue_size: this.relayer.queueSize(),
      batch_interval_seconds: this.cfg.batchIntervalSeconds,
      settle_interval_seconds: this.cfg.settleIntervalSeconds,
      last_flush_at: this.lastFlushAt?.toISOString() ?? null,
      last_settle_at: this.lastSettleAt?.toISOString() ?? null,
      last_flush: this.lastFlush,
      last_settle_error: this.lastSettleError,
    };
  }
}
