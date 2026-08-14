/**
 * Operator-only operations. These mutate configuration and meter registration,
 * which the contract gates behind `require_auth` on the configured admin
 * account. They therefore run through a separate `GridPulse` client that signs
 * with `ADMIN_SECRET` rather than the relayer key.
 */

import type { ChainClient } from './chain.js';
import { HttpError } from './errors.js';
import { MeterRegistry } from './registry.js';
import { bytesToHex, hexToBytes, parseU64 } from './types.js';

export class AdminUnavailableError extends HttpError {
  constructor() {
    super(403, 'admin operations are disabled: set ADMIN_SECRET to enable them');
    this.name = 'AdminUnavailableError';
  }
}

export class Admin {
  constructor(
    private readonly chain: ChainClient | null,
    private readonly registry: MeterRegistry,
  ) {}

  private requireChain(): ChainClient {
    if (!this.chain) throw new AdminUnavailableError();
    return this.chain;
  }

  async registerMeter(owner: string, signerHex: string): Promise<{ meter_id: string; tx_hash: string }> {
    const chain = this.requireChain();
    const signer = hexToBytes(signerHex);
    if (signer.length !== 32) {
      throw new HttpError(400, 'signer must be 32 bytes (64 hex chars)');
    }

    const { hash, meterId } = await chain.registerMeter(owner, signer);
    this.registry.add({
      id: meterId,
      owner,
      signer: bytesToHex(signer),
      registeredAt: new Date().toISOString(),
    });
    this.registry.save();

    return { meter_id: meterId.toString(), tx_hash: hash };
  }

  async setMeterActive(meterIdRaw: string, active: boolean): Promise<{ tx_hash: string }> {
    const chain = this.requireChain();
    const meterId = parseU64(meterIdRaw, 'meter_id');
    const { hash } = await chain.setMeterActive(meterId, active);
    return { tx_hash: hash };
  }

  async setPrice(priceRaw: string): Promise<{ tx_hash: string }> {
    const chain = this.requireChain();
    const price = parseU64(priceRaw, 'price');
    const { hash } = await chain.setPrice(price);
    return { tx_hash: hash };
  }

  async setFeeBps(feeBps: number): Promise<{ tx_hash: string }> {
    const chain = this.requireChain();
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
      throw new HttpError(400, 'fee_bps must be an integer between 0 and 10000');
    }
    const { hash } = await chain.setFeeBps(feeBps);
    return { tx_hash: hash };
  }
}
