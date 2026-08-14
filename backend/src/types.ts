/**
 * Shared types for the GridPulse backend.
 *
 * Two layers of types are used on purpose:
 *  - "native" contract types (`Config`, `Meter`, `Report`) match what the
 *    Stellar SDK decodes from the chain (bigint for u64/i128, Uint8Array for
 *    bytes, snake_case field names as declared in the Rust contract).
 *  - DTO types (`*Dto`) are the JSON-safe shapes served over HTTP: every
 *    bigint becomes a decimal string and every byte buffer becomes hex, so
 *    clients never have to worry about JSON's number precision.
 */

import { HttpError } from './errors.js';

/** Native `Config` struct as decoded by the SDK. */
export interface Config {
  admin: string;
  token: string;
  /** Clearing price in token base units per kWh. */
  price: bigint;
  /** Operator fee in basis points (1/10000). */
  fee_bps: number;
}

/** Native `Meter` struct as decoded by the SDK. */
export interface Meter {
  id: bigint;
  owner: string;
  /** Ed25519 public key of the physical device (32 bytes). */
  signer: Uint8Array;
  active: boolean;
  nonce: bigint;
  last_ts: bigint;
}

/** Native `Report` struct returned by `settle`. */
export interface Report {
  traded_wh: bigint;
  producers: number;
  consumers: number;
  paid_out: bigint;
  fee: bigint;
}

// ---- JSON DTOs -----------------------------------------------------------

export interface ConfigDto {
  admin: string;
  token: string;
  price: string;
  fee_bps: number;
}

export interface MeterDto {
  id: string;
  owner: string;
  signer: string;
  active: boolean;
  nonce: string;
  last_ts: string;
}

export interface ReportDto {
  traded_wh: string;
  producers: number;
  consumers: number;
  paid_out: string;
  fee: string;
}

/** A single meter's on-chain state plus its live net position. */
export interface MeterWithPositionDto extends MeterDto {
  net_wh: string;
}

export interface GridOverviewDto {
  contract_id: string;
  config: ConfigDto;
  meters: MeterWithPositionDto[];
}

// ---- Conversion helpers --------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalized.length === 0 || !/^[0-9a-fA-F]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new HttpError(400, `Invalid hex string: ${hex}`);
  }
  return Uint8Array.from(Buffer.from(normalized, 'hex'));
}

/** Parse a decimal string into a non-negative u64 (bigint). */
export function parseU64(input: string | undefined, field: string): bigint {
  if (input === undefined || !/^\d+$/.test(input)) {
    throw new HttpError(400, `${field} must be a non-negative decimal integer`);
  }
  const value = BigInt(input);
  if (value > 0xffffffffffffffffn) {
    throw new HttpError(400, `${field} exceeds u64 range`);
  }
  return value;
}

export function configToDto(config: Config): ConfigDto {
  return {
    admin: config.admin,
    token: config.token,
    price: config.price.toString(),
    fee_bps: config.fee_bps,
  };
}

export function meterToDto(meter: Meter): MeterDto {
  return {
    id: meter.id.toString(),
    owner: meter.owner,
    signer: bytesToHex(meter.signer),
    active: meter.active,
    nonce: meter.nonce.toString(),
    last_ts: meter.last_ts.toString(),
  };
}

export function reportToDto(report: Report): ReportDto {
  return {
    traded_wh: report.traded_wh.toString(),
    producers: report.producers,
    consumers: report.consumers,
    paid_out: report.paid_out.toString(),
    fee: report.fee.toString(),
  };
}
