/**
 * The relayer: the trust-minimizing glue between IoT meters and Soroban.
 *
 * It never fabricates energy — it only forwards readings whose Ed25519
 * signature verifies against the device public key registered on-chain, after
 * checking replay protection and timestamp monotonicity locally.
 *
 * Readings are validated and **queued** first, then drained to the chain in
 * batches by the scheduler (or `POST /api/flush`). This keeps ingest cheap and
 * fast while on-chain submission is amortized, rate-limited, and retryable.
 */

import { ContractError, GridPulse } from './chain.js';
import { ReadingQueue } from './queue.js';
import type { QueuedReading } from './queue.js';
import { MeterRegistry } from './registry.js';
import { verifyReadingSignature } from './signature.js';
import type { ReadingFields } from './signature.js';
import { bytesToHex, hexToBytes, parseU64 } from './types.js';
import type { GridOverviewDto, MeterWithPositionDto, ReportDto } from './types.js';
import { configToDto, meterToDto } from './types.js';

/** Thrown for client-fixable errors (4xx) versus infrastructure errors (5xx). */
export class RelayerError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'RelayerError';
    this.statusCode = statusCode;
  }
}

/** Wire-format of a signed reading accepted by POST /readings. */
export interface ReadingInput {
  meter_id: string;
  timestamp: string;
  generation_wh: string;
  consumption_wh: string;
  nonce: string;
  signature: string; // 128 hex chars (64 bytes)
}

export interface QueuedReadingDto {
  meter_id: string;
  timestamp: string;
  generation_wh: string;
  consumption_wh: string;
  nonce: string;
  signature: string;
  enqueued_at: string;
}

export interface FlushResult {
  submitted: number;
  dropped: number;
  remaining: number;
}

export class Relayer {
  constructor(
    readonly chain: GridPulse,
    private readonly registry: MeterRegistry,
    private readonly queue: ReadingQueue,
  ) {}

  queueSize(): number {
    return this.queue.size();
  }

  meterCount(): number {
    return this.registry.list().length;
  }

  queueList(): QueuedReadingDto[] {
    return this.queue.list().map(toDto);
  }

  /** Full dashboard snapshot: config + every registered meter with net position. */
  async overview(): Promise<GridOverviewDto> {
    const config = await this.chain.config();
    const meters: MeterWithPositionDto[] = [];

    for (const entry of this.registry.list()) {
      const meter = await this.chain.meter(entry.id);
      if (!meter) continue;
      const net = await this.chain.netPosition(entry.id);
      meters.push({ ...meterToDto(meter), net_wh: net.toString() });
    }

    return {
      contract_id: this.chain.contractId,
      config: configToDto(config),
      meters,
    };
  }

  /**
   * Validate a signed reading locally and enqueue it for batch submission.
   *
   * Local checks mirror the contract's own (active, nonce, timestamp,
   * signature) plus a queue-level nonce check, so an invalid or duplicate
   * reading is rejected for free instead of paying for a doomed transaction.
   */
  async enqueueReading(raw: ReadingInput): Promise<{ meter_id: string; queue_size: number }> {
    const reading = await this.validate(raw);

    this.queue.enqueue({
      meterId: reading.fields.meterId,
      timestamp: reading.fields.timestamp,
      generationWh: reading.fields.generationWh,
      consumptionWh: reading.fields.consumptionWh,
      nonce: reading.fields.nonce,
      signature: reading.signature,
      enqueuedAt: new Date().toISOString(),
    });

    return { meter_id: reading.fields.meterId.toString(), queue_size: this.queue.size() };
  }

  /**
   * Submit up to `batchSize` queued readings to the chain in FIFO order.
   *
   * A contract rejection (stale nonce, inactive meter, …) is dropped — it can
   * never succeed later. Any other error is treated as transient: the batch
   * stops and the remaining readings stay queued for the next flush.
   */
  async flush(batchSize: number): Promise<FlushResult> {
    const batch = this.queue.peek(batchSize);
    let submitted = 0;
    let dropped = 0;

    for (const item of batch) {
      try {
        await this.chain.submitReading({
          meter_id: item.meterId,
          timestamp: item.timestamp,
          generation_wh: item.generationWh,
          consumption_wh: item.consumptionWh,
          nonce: item.nonce,
          signature: item.signature,
        });
        submitted += 1;
      } catch (err) {
        if (err instanceof ContractError) {
          // Permanently rejected by the contract — drop it and keep going.
          dropped += 1;
          continue;
        }
        // Transient (RPC/network) — stop and leave the rest queued.
        break;
      }
    }

    this.queue.removeFirst(submitted + dropped);
    return { submitted, dropped, remaining: this.queue.size() };
  }

  /** Settle a set of meters (defaults to the whole local registry). */
  async settle(meterIds?: string[]): Promise<{ report: ReportDto; tx_hash: string }> {
    const ids = meterIds
      ? meterIds.map((id) => parseU64(id, 'meter_ids[]'))
      : this.registry.list().map((m) => m.id);

    if (ids.length === 0) {
      throw new RelayerError(400, 'no meters to settle — register at least one meter first');
    }

    const { hash, report } = await this.chain.settle(ids);
    return { report, tx_hash: hash };
  }

  /**
   * Parse + validate a reading against the chain and the local queue. Returns
   * the parsed fields and signature on success.
   */
  private async validate(raw: ReadingInput): Promise<{ fields: ReadingFields; signature: Uint8Array }> {
    const meterId = parseU64(raw.meter_id, 'meter_id');
    const timestamp = parseU64(raw.timestamp, 'timestamp');
    const generationWh = parseU64(raw.generation_wh, 'generation_wh');
    const consumptionWh = parseU64(raw.consumption_wh, 'consumption_wh');
    const nonce = parseU64(raw.nonce, 'nonce');

    const signature = hexToBytes(raw.signature);
    if (signature.length !== 64) {
      throw new RelayerError(400, 'signature must be 64 bytes (128 hex chars)');
    }

    const meter = await this.chain.meter(meterId);
    if (!meter) throw new RelayerError(404, `meter ${meterId} is not registered`);
    if (!meter.active) throw new RelayerError(409, `meter ${meterId} is inactive`);
    if (nonce <= meter.nonce) {
      throw new RelayerError(409, `stale nonce ${nonce} (last accepted ${meter.nonce})`);
    }
    const queuedNonce = this.queue.lastQueuedNonce(meterId);
    if (nonce <= queuedNonce) {
      throw new RelayerError(409, `nonce ${nonce} already queued (highest queued ${queuedNonce})`);
    }
    if (timestamp < meter.last_ts) {
      throw new RelayerError(409, `stale timestamp ${timestamp} (last ${meter.last_ts})`);
    }

    const fields: ReadingFields = { meterId, timestamp, generationWh, consumptionWh, nonce };
    if (!verifyReadingSignature(fields, signature, meter.signer)) {
      throw new RelayerError(400, 'invalid device signature');
    }

    return { fields, signature };
  }
}

function toDto(r: QueuedReading): QueuedReadingDto {
  return {
    meter_id: r.meterId.toString(),
    timestamp: r.timestamp.toString(),
    generation_wh: r.generationWh.toString(),
    consumption_wh: r.consumptionWh.toString(),
    nonce: r.nonce.toString(),
    signature: bytesToHex(r.signature),
    enqueued_at: r.enqueuedAt,
  };
}
