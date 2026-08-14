/**
 * Persistent queue of readings that have been validated locally but not yet
 * submitted on-chain. The relayer drains it in batches on a schedule, so the
 * HTTP ingest path stays fast and cheap while the chain submission is
 * amortized and retryable across restarts.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { bytesToHex, hexToBytes } from './types.js';

export interface QueuedReading {
  meterId: bigint;
  timestamp: bigint;
  generationWh: bigint;
  consumptionWh: bigint;
  nonce: bigint;
  /** 64-byte Ed25519 signature. */
  signature: Uint8Array;
  enqueuedAt: string;
}

interface QueueFile {
  readings: Array<{
    meter_id: string;
    timestamp: string;
    generation_wh: string;
    consumption_wh: string;
    nonce: string;
    signature: string;
    enqueued_at: string;
  }>;
}

export class ReadingQueue {
  private items: QueuedReading[] = [];
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'readings.json');
  }

  load(): void {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as QueueFile;
      this.items = (parsed.readings ?? []).map((r) => ({
        meterId: BigInt(r.meter_id),
        timestamp: BigInt(r.timestamp),
        generationWh: BigInt(r.generation_wh),
        consumptionWh: BigInt(r.consumption_wh),
        nonce: BigInt(r.nonce),
        signature: hexToBytes(r.signature),
        enqueuedAt: r.enqueued_at,
      }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.items = [];
        return;
      }
      throw err;
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload: QueueFile = {
      readings: this.items.map((r) => ({
        meter_id: r.meterId.toString(),
        timestamp: r.timestamp.toString(),
        generation_wh: r.generationWh.toString(),
        consumption_wh: r.consumptionWh.toString(),
        nonce: r.nonce.toString(),
        signature: bytesToHex(r.signature),
        enqueued_at: r.enqueuedAt,
      })),
    };
    writeFileSync(this.path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  }

  size(): number {
    return this.items.length;
  }

  list(): QueuedReading[] {
    return this.items.map((r) => ({ ...r, signature: Uint8Array.from(r.signature) }));
  }

  /** First `limit` items in FIFO order (without removing them). */
  peek(limit: number): QueuedReading[] {
    return this.list().slice(0, limit);
  }

  enqueue(reading: QueuedReading): void {
    this.items.push(reading);
    this.save();
  }

  /** Highest nonce currently queued for a meter (0 if none). */
  lastQueuedNonce(meterId: bigint): bigint {
    let max = 0n;
    for (const r of this.items) {
      if (r.meterId === meterId && r.nonce > max) max = r.nonce;
    }
    return max;
  }

  /** Drop the first `count` items (used after they have been submitted/dropped). */
  removeFirst(count: number): void {
    if (count <= 0) return;
    this.items = this.items.slice(count);
    this.save();
  }

  clear(): void {
    this.items = [];
    this.save();
  }
}
