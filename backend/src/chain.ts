/**
 * Thin, typed wrapper around the deployed GridPulse contract.
 *
 * The modern `@stellar/stellar-sdk` `Client.from<T>()` API fetches the
 * contract's WASM spec on-chain and generates one method per contract
 * function. We declare `GridPulseContract` so those methods are typed, then
 * expose small async helpers that unwrap Rust `Result`s and translate them
 * into idiomatic thrown errors.
 */

import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import { Client, basicNodeSigner } from '@stellar/stellar-sdk/contract';
import type { AssembledTransaction, Result } from '@stellar/stellar-sdk/contract';

import type { AppConfig } from './config.js';
import type { Config, Meter, Report } from './types.js';
import { reportToDto } from './types.js';
import type { ReportDto } from './types.js';

/** Contract method signatures, keyed by their Rust parameter names. */
export interface GridPulseContract {
  config: () => Promise<AssembledTransaction<Config>>;
  meter: (args: { meter_id: bigint }) => Promise<AssembledTransaction<Result<Meter>>>;
  net_position: (args: { meter_id: bigint }) => Promise<AssembledTransaction<bigint>>;
  submit_reading: (args: {
    meter_id: bigint;
    timestamp: bigint;
    generation_wh: bigint;
    consumption_wh: bigint;
    nonce: bigint;
    signature: Uint8Array;
  }) => Promise<AssembledTransaction<Result<null>>>;
  settle: (args: { meter_ids: bigint[] }) => Promise<AssembledTransaction<Result<Report>>>;
  register_meter: (args: {
    owner: string;
    signer: Uint8Array;
  }) => Promise<AssembledTransaction<Result<bigint>>>;
  set_meter_active: (args: {
    meter_id: bigint;
    active: boolean;
  }) => Promise<AssembledTransaction<Result<null>>>;
  update_meter_owner: (args: {
    meter_id: bigint;
    owner: string;
  }) => Promise<AssembledTransaction<Result<null>>>;
  set_price: (args: { price: bigint }) => Promise<AssembledTransaction<Result<null>>>;
  set_fee_bps: (args: { fee_bps: number }) => Promise<AssembledTransaction<Result<null>>>;
}

/** Human-readable names for the contract's `#[contracterror]` codes. */
export const CONTRACT_ERRORS: Record<number, string> = {
  1: 'NotInitialized',
  2: 'AlreadyInitialized',
  3: 'MeterNotFound',
  4: 'MeterInactive',
  5: 'StaleNonce',
  6: 'StaleTimestamp',
  7: 'BadReading',
  8: 'Overflow',
  9: 'NothingToSettle',
  10: 'BadFee',
};

/** Raised when a contract call returns a Rust `Err(...)`. */
export class ContractError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(code ? `${CONTRACT_ERRORS[code] ?? 'ContractError'} (${code}): ${message}` : message);
    this.name = 'ContractError';
    this.code = code;
  }
}

/** Best-effort decode of a `contracterror` code from the SDK's base64 message. */
function decodeContractErrorCode(messageB64: string): number | null {
  try {
    const scv = xdr.ScVal.fromXDR(messageB64, 'base64');
    if (scv.switch().name !== 'scvError') return null;
    const code = scv.error().contractCode();
    return typeof code === 'number' ? code : null;
  } catch {
    return null;
  }
}

function unwrapOrThrow<T>(result: Result<T>): T {
  if (result.isOk()) return result.unwrap();
  const err = result.unwrapErr();
  throw new ContractError('contract call failed', decodeContractErrorCode(err.message));
}

export class GridPulse {
  readonly contractId: string;
  readonly signerPublicKey: string;
  private readonly networkPassphrase: string;
  private readonly rpcUrl: string;
  private readonly signer: ReturnType<typeof basicNodeSigner>;
  private client?: Promise<Client & GridPulseContract>;

  constructor(cfg: AppConfig, secret: string) {
    this.contractId = cfg.contractId;
    if (!StrKey.isValidContract(cfg.contractId)) {
      throw new Error(`Invalid contract id: ${cfg.contractId}`);
    }

    const signer = Keypair.fromSecret(secret);
    this.signerPublicKey = signer.publicKey();
    this.networkPassphrase = cfg.networkPassphrase;
    this.rpcUrl = cfg.rpcUrl;
    this.signer = basicNodeSigner(signer, cfg.networkPassphrase);
  }

  // The client is created lazily so an unreachable RPC or a spec-fetch failure
  // surfaces as an error on the request that needs it, instead of an unhandled
  // rejection that crashes the whole process at boot.
  private c(): Promise<Client & GridPulseContract> {
    this.client ??= Client.from<GridPulseContract>({
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
      publicKey: this.signerPublicKey,
      ...this.signer,
    });
    return this.client;
  }

  // ---- Views -------------------------------------------------------------

  async config(): Promise<Config> {
    return (await (await this.c()).config()).result;
  }

  /** Return the meter, or null when it is not registered. */
  async meter(meterId: bigint): Promise<Meter | null> {
    const result = (await (await this.c()).meter({ meter_id: meterId })).result;
    return result.isOk() ? result.unwrap() : null;
  }

  async netPosition(meterId: bigint): Promise<bigint> {
    return (await (await this.c()).net_position({ meter_id: meterId })).result;
  }

  // ---- Mutations (relayer-signed) ----------------------------------------

  async submitReading(args: {
    meter_id: bigint;
    timestamp: bigint;
    generation_wh: bigint;
    consumption_wh: bigint;
    nonce: bigint;
    signature: Uint8Array;
  }): Promise<{ hash: string }> {
    const tx = await (await this.c()).submit_reading(args);
    const sent = await tx.signAndSend();
    unwrapOrThrow(sent.result);
    const hash = sent.sendTransactionResponse?.hash;
    if (!hash) throw new Error('transaction sent without a hash');
    return { hash };
  }

  async settle(meterIds: bigint[]): Promise<{ hash: string; report: ReportDto }> {
    const tx = await (await this.c()).settle({ meter_ids: meterIds });
    const sent = await tx.signAndSend();
    const report = unwrapOrThrow(sent.result);
    const hash = sent.sendTransactionResponse?.hash;
    if (!hash) throw new Error('transaction sent without a hash');
    return { hash, report: reportToDto(report) };
  }

  // ---- Mutations (admin-signed) ------------------------------------------

  async registerMeter(owner: string, signer: Uint8Array): Promise<{ hash: string; meterId: bigint }> {
    const tx = await (await this.c()).register_meter({ owner, signer });
    const sent = await tx.signAndSend();
    const meterId = unwrapOrThrow(sent.result);
    const hash = sent.sendTransactionResponse?.hash;
    if (!hash) throw new Error('transaction sent without a hash');
    return { hash, meterId };
  }

  async setMeterActive(meterId: bigint, active: boolean): Promise<{ hash: string }> {
    const tx = await (await this.c()).set_meter_active({ meter_id: meterId, active });
    const sent = await tx.signAndSend();
    unwrapOrThrow(sent.result);
    return { hash: sent.sendTransactionResponse?.hash ?? '' };
  }

  async setPrice(price: bigint): Promise<{ hash: string }> {
    const tx = await (await this.c()).set_price({ price });
    const sent = await tx.signAndSend();
    unwrapOrThrow(sent.result);
    return { hash: sent.sendTransactionResponse?.hash ?? '' };
  }

  async setFeeBps(feeBps: number): Promise<{ hash: string }> {
    const tx = await (await this.c()).set_fee_bps({ fee_bps: feeBps });
    const sent = await tx.signAndSend();
    unwrapOrThrow(sent.result);
    return { hash: sent.sendTransactionResponse?.hash ?? '' };
  }
}
