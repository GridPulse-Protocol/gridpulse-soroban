/**
 * The relayer: the trust-minimizing glue between IoT meters and Soroban.
 *
 * It never fabricates energy — it only forwards readings whose Ed25519
 * signature verifies against the device public key registered on-chain, after
 * checking replay protection and timestamp monotonicity locally. This means
 * invalid readings are rejected for free instead of paying for a doomed
 * transaction.
 */

import { GridPulse } from './chain.js';
import { MeterRegistry } from './registry.js';
import { verifyReadingSignature } from './signature.js';
import type { ReadingFields } from './signature.js';
import { hexToBytes, parseU64 } from './types.js';
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

export interface RelayResult {
  meter_id: string;
  net_wh: string;
  tx_hash: string;
}

export class Relayer {
  constructor(
    readonly chain: GridPulse,
    private readonly registry: MeterRegistry,
  ) {}

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
   * Validate a signed reading locally, then relay it to the contract.
   *
   * Local checks mirror the contract's own (active, nonce, timestamp,
   * signature) so we can give a precise HTTP error instead of an on-chain
   * revert. The contract remains the final authority.
   */
  async relayReading(raw: ReadingInput): Promise<RelayResult> {
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
    if (timestamp < meter.last_ts) {
      throw new RelayerError(409, `stale timestamp ${timestamp} (last ${meter.last_ts})`);
    }

    const fields: ReadingFields = { meterId, timestamp, generationWh, consumptionWh, nonce };
    if (!verifyReadingSignature(fields, signature, meter.signer)) {
      throw new RelayerError(400, 'invalid device signature');
    }

    const { hash } = await this.chain.submitReading({
      meter_id: meterId,
      timestamp,
      generation_wh: generationWh,
      consumption_wh: consumptionWh,
      nonce,
      signature,
    });

    const net = await this.chain.netPosition(meterId);
    return { meter_id: meterId.toString(), net_wh: net.toString(), tx_hash: hash };
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
}
