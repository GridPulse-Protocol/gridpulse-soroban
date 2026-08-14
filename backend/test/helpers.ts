/**
 * Test doubles and fixtures. The real `GridPulse` class talks to the Soroban
 * RPC; tests substitute `MockChain` (a plain `ChainClient` implementation) so
 * they run offline and deterministically.
 */

import { getPublicKey, sign, utils } from '@noble/ed25519';

import type { ChainClient, SubmitReadingArgs } from '../src/chain.js';
import type { Config, Meter, ReportDto } from '../src/types.js';

/** A fresh Ed25519 keypair, plus a helper to sign the canonical payload. */
export interface DeviceKey {
  /** 32-byte public key (what the contract stores as `meter.signer`). */
  publicKey: Uint8Array;
  /** 32-byte private key. */
  privateKey: Uint8Array;
  /** Sign the 40-byte canonical payload and return the 64-byte signature. */
  sign(payload: Uint8Array): Uint8Array;
}

export function newDeviceKey(): DeviceKey {
  const privateKey = utils.randomPrivateKey();
  const publicKey = getPublicKey(privateKey);
  return {
    publicKey,
    privateKey,
    sign: (payload: Uint8Array) => sign(payload, privateKey),
  };
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    admin: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    token: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    price: 100n,
    fee_bps: 100,
    ...overrides,
  };
}

export function makeMeter(overrides: Partial<Meter> = {}): Meter {
  return {
    id: 1n,
    owner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    signer: new Uint8Array(32),
    active: true,
    nonce: 0n,
    last_ts: 0n,
    ...overrides,
  };
}

export interface MockChainOptions {
  contractId?: string;
  signerPublicKey?: string;
  config?: Config;
  /** Meter lookup map; a value of `null` means "not registered". */
  meters?: Map<bigint, Meter | null>;
  netPositions?: Map<bigint, bigint>;
  /** Return an error to throw from `submitReading` (undefined = success). */
  submitReadingError?: (args: SubmitReadingArgs) => Error | undefined;
  settleResult?: { hash: string; report: ReportDto };
}

export class MockChain implements ChainClient {
  readonly contractId: string;
  readonly signerPublicKey: string;
  readonly cfg: Config;
  private readonly meters: Map<bigint, Meter | null>;
  private readonly netPositions: Map<bigint, bigint>;
  private readonly submitReadingError?: (args: SubmitReadingArgs) => Error | undefined;
  private readonly settleResult?: { hash: string; report: ReportDto };

  readonly submitted: SubmitReadingArgs[] = [];
  readonly settled: bigint[][] = [];
  readonly registered: Array<{ owner: string; signer: Uint8Array }> = [];

  constructor(options: MockChainOptions = {}) {
    this.contractId = options.contractId ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    this.signerPublicKey = options.signerPublicKey ?? 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    this.cfg = options.config ?? makeConfig();
    this.meters = options.meters ?? new Map();
    this.netPositions = options.netPositions ?? new Map();
    this.submitReadingError = options.submitReadingError;
    this.settleResult = options.settleResult;
  }

  async config(): Promise<Config> {
    return this.cfg;
  }

  async meter(meterId: bigint): Promise<Meter | null> {
    return this.meters.has(meterId) ? this.meters.get(meterId)! : null;
  }

  async netPosition(meterId: bigint): Promise<bigint> {
    return this.netPositions.get(meterId) ?? 0n;
  }

  async submitReading(args: SubmitReadingArgs): Promise<{ hash: string }> {
    const err = this.submitReadingError?.(args);
    if (err) throw err;
    this.submitted.push(args);
    return { hash: 'tx-hash' };
  }

  async settle(meterIds: bigint[]): Promise<{ hash: string; report: ReportDto }> {
    this.settled.push(meterIds);
    if (!this.settleResult) throw new Error('settleResult not configured');
    return this.settleResult;
  }

  async registerMeter(owner: string, signer: Uint8Array): Promise<{ hash: string; meterId: bigint }> {
    this.registered.push({ owner, signer });
    return { hash: 'tx-hash', meterId: BigInt(this.registered.length) };
  }

  async setMeterActive(_meterId: bigint, _active: boolean): Promise<{ hash: string }> {
    return { hash: 'tx-hash' };
  }

  async setPrice(_price: bigint): Promise<{ hash: string }> {
    return { hash: 'tx-hash' };
  }

  async setFeeBps(_feeBps: number): Promise<{ hash: string }> {
    return { hash: 'tx-hash' };
  }
}

export function makeReport(overrides: Partial<ReportDto> = {}): ReportDto {
  return {
    traded_wh: '1000',
    producers: 1,
    consumers: 1,
    paid_out: '90',
    fee: '10',
    ...overrides,
  };
}
