import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PAYLOAD_LEN,
  buildReadingPayload,
  verifyReadingSignature,
} from '../src/signature.js';
import type { ReadingFields } from '../src/signature.js';
import { newDeviceKey } from './helpers.js';

const FIELDS: ReadingFields = {
  meterId: 7n,
  timestamp: 1_700_000_000n,
  generationWh: 1_500n,
  consumptionWh: 600n,
  nonce: 42n,
};

test('buildReadingPayload produces the canonical 40-byte big-endian layout', () => {
  const payload = buildReadingPayload(FIELDS);

  assert.equal(payload.length, PAYLOAD_LEN);

  // meter_id (bytes 0..8)
  assert.deepEqual([...payload.slice(0, 8)], [0, 0, 0, 0, 0, 0, 0, 7]);
  // timestamp (bytes 8..16) — 1_700_000_000 = 0x6553F100
  assert.deepEqual([...payload.slice(8, 16)], [0, 0, 0, 0, 0x65, 0x53, 0xf1, 0x00]);
  // generation_wh (bytes 16..24) — 1500 = 0x05DC
  assert.deepEqual([...payload.slice(16, 24)], [0, 0, 0, 0, 0, 0, 0x05, 0xdc]);
  // consumption_wh (bytes 24..32) — 600 = 0x0258
  assert.deepEqual([...payload.slice(24, 32)], [0, 0, 0, 0, 0, 0, 0x02, 0x58]);
  // nonce (bytes 32..40)
  assert.deepEqual([...payload.slice(32, 40)], [0, 0, 0, 0, 0, 0, 0, 42]);
});

test('verifyReadingSignature accepts a signature by the registered device key', () => {
  const device = newDeviceKey();
  const signature = device.sign(buildReadingPayload(FIELDS));

  assert.equal(verifyReadingSignature(FIELDS, signature, device.publicKey), true);
});

test('verifyReadingSignature rejects a tampered payload', () => {
  const device = newDeviceKey();
  const signature = device.sign(buildReadingPayload(FIELDS));

  const tampered: ReadingFields = { ...FIELDS, generationWh: FIELDS.generationWh + 1n };
  assert.equal(verifyReadingSignature(tampered, signature, device.publicKey), false);
});

test('verifyReadingSignature rejects a signature by the wrong key', () => {
  const device = newDeviceKey();
  const attacker = newDeviceKey();
  const signature = device.sign(buildReadingPayload(FIELDS));

  assert.equal(verifyReadingSignature(FIELDS, signature, attacker.publicKey), false);
});

test('verifyReadingSignature rejects malformed keys and signatures', () => {
  const device = newDeviceKey();
  const signature = device.sign(buildReadingPayload(FIELDS));

  assert.equal(verifyReadingSignature(FIELDS, signature, new Uint8Array(31)), false);
  assert.equal(verifyReadingSignature(FIELDS, new Uint8Array(63), device.publicKey), false);
});
