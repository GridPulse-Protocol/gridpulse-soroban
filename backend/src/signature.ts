/**
 * Reading signature scheme — mirrors `contracts/gridpulse/src/meter.rs`.
 *
 * A reading is valid only if the IoT meter signs, with Ed25519, the 40-byte
 * big-endian concatenation of five `u64` fields:
 *
 *     meter_id ‖ timestamp ‖ generation_wh ‖ consumption_wh ‖ nonce
 *
 * There is no domain-separating prefix. The relayer verifies this locally
 * (using the registered device public key) *before* paying for an on-chain
 * transaction, so forged readings are rejected for free instead of relying on
 * the contract's `ed25519_verify` host trap.
 */

import { verify } from '@noble/ed25519';

export const PAYLOAD_LEN = 40;

export interface ReadingFields {
  meterId: bigint;
  timestamp: bigint;
  generationWh: bigint;
  consumptionWh: bigint;
  nonce: bigint;
}

/** Build the exact 40-byte payload the device must sign. */
export function buildReadingPayload(fields: ReadingFields): Uint8Array {
  const buf = new Uint8Array(PAYLOAD_LEN);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, fields.meterId, false);
  view.setBigUint64(8, fields.timestamp, false);
  view.setBigUint64(16, fields.generationWh, false);
  view.setBigUint64(24, fields.consumptionWh, false);
  view.setBigUint64(32, fields.nonce, false);
  return buf;
}

/** Verify a 64-byte Ed25519 signature over the canonical payload. */
export function verifyReadingSignature(
  fields: ReadingFields,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) {
    return false;
  }
  const payload = buildReadingPayload(fields);
  try {
    return verify(signature, payload, publicKey);
  } catch {
    return false;
  }
}
