import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from '../src/errors.js';
import { bytesToHex, hexToBytes, parseU64 } from '../src/types.js';

test('parseU64 accepts valid non-negative decimals', () => {
  assert.equal(parseU64('0', 'x'), 0n);
  assert.equal(parseU64('42', 'x'), 42n);
  assert.equal(parseU64('00123', 'x'), 123n); // leading zeros are fine
  assert.equal(parseU64('18446744073709551615', 'x'), 0xffffffffffffffffn); // max u64
});

test('parseU64 rejects out-of-range and malformed input with 400', () => {
  for (const bad of ['18446744073709551616', '-1', '12.5', '1e3', 'abc', '', '0x10']) {
    assert.throws(() => parseU64(bad, 'field'), (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal((err as HttpError).statusCode, 400);
      return true;
    });
  }
  // undefined (e.g. a missing JSON field) is also a 400, not a 500.
  assert.throws(() => parseU64(undefined, 'field'), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal((err as HttpError).statusCode, 400);
    return true;
  });
});

test('hexToBytes decodes with or without a 0x prefix', () => {
  assert.deepEqual([...hexToBytes('deadbeef')], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual([...hexToBytes('0xdeadbeef')], [0xde, 0xad, 0xbe, 0xef]);
});

test('hexToBytes rejects empty, odd-length, and non-hex input with 400', () => {
  for (const bad of ['', 'abc', '0x', '0xzz', '0x1']) {
    assert.throws(() => hexToBytes(bad), (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal((err as HttpError).statusCode, 400);
      return true;
    });
  }
});

test('bytesToHex round-trips through hexToBytes', () => {
  const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);
  const hex = bytesToHex(bytes);
  assert.equal(hex, '0001feff');
  assert.deepEqual([...hexToBytes(hex)], [...bytes]);
});
