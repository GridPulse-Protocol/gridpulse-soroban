import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ContractError } from '../src/chain.js';
import { HttpError } from '../src/errors.js';
import { ReadingQueue } from '../src/queue.js';
import { MeterRegistry } from '../src/registry.js';
import { Relayer } from '../src/relayer.js';
import type { ReadingInput } from '../src/relayer.js';
import { buildReadingPayload } from '../src/signature.js';
import { bytesToHex } from '../src/types.js';
import { MockChain, makeConfig, makeMeter, makeReport, newDeviceKey } from './helpers.js';

interface Harness {
  relayer: Relayer;
  queue: ReadingQueue;
  registry: MeterRegistry;
  cleanup: () => void;
}

function harness(chain: MockChain, registry?: MeterRegistry, queue?: ReadingQueue): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gridpulse-relayer-'));
  const r = registry ?? new MeterRegistry(dir);
  const q = queue ?? new ReadingQueue(dir);
  const relayer = new Relayer(chain, r, q);
  return { relayer, queue: q, registry: r, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readingInput(device: ReturnType<typeof newDeviceKey>, overrides: Partial<ReadingInput> = {}): ReadingInput {
  const fields = {
    meterId: overrides.meter_id !== undefined ? BigInt(overrides.meter_id) : 1n,
    timestamp: overrides.timestamp !== undefined ? BigInt(overrides.timestamp) : 1_700_000_000n,
    generationWh: overrides.generation_wh !== undefined ? BigInt(overrides.generation_wh) : 1_500n,
    consumptionWh: overrides.consumption_wh !== undefined ? BigInt(overrides.consumption_wh) : 600n,
    nonce: overrides.nonce !== undefined ? BigInt(overrides.nonce) : 1n,
  };
  const signature = device.sign(buildReadingPayload(fields));
  return {
    meter_id: fields.meterId.toString(),
    timestamp: fields.timestamp.toString(),
    generation_wh: fields.generationWh.toString(),
    consumption_wh: fields.consumptionWh.toString(),
    nonce: fields.nonce.toString(),
    signature: bytesToHex(signature),
    ...overrides,
  };
}

test('enqueueReading accepts a valid signature and enqueues it', async () => {
  const device = newDeviceKey();
  const meter = makeMeter({ id: 1n, signer: device.publicKey });
  const chain = new MockChain({ meters: new Map([[1n, meter]]) });
  const { relayer, cleanup } = harness(chain);

  try {
    const result = await relayer.enqueueReading(readingInput(device));

    assert.equal(result.meter_id, '1');
    assert.equal(result.queue_size, 1);
    assert.equal(chain.submitted.length, 0); // queued, not yet submitted
  } finally {
    cleanup();
  }
});

test('enqueueReading rejects a forged signature with 400', async () => {
  const device = newDeviceKey();
  const attacker = newDeviceKey();
  const meter = makeMeter({ id: 1n, signer: device.publicKey });
  const chain = new MockChain({ meters: new Map([[1n, meter]]) });
  const { relayer, cleanup } = harness(chain);

  try {
    await assert.rejects(
      relayer.enqueueReading(readingInput(attacker)),
      (err: unknown) => err instanceof HttpError && err.statusCode === 400 && /signature/.test(err.message),
    );
  } finally {
    cleanup();
  }
});

test('enqueueReading enforces nonce, timestamp, and active state', async () => {
  const device = newDeviceKey();
  const meter = makeMeter({ id: 1n, signer: device.publicKey, nonce: 5n, last_ts: 500n });
  const chain = new MockChain({ meters: new Map([[1n, meter]]) });
  const { relayer, cleanup } = harness(chain);

  try {
    // Stale nonce (<= stored).
    await assert.rejects(
      relayer.enqueueReading(readingInput(device, { nonce: '5' })),
      (e: unknown) => e instanceof HttpError && e.statusCode === 409,
    );
    // Stale timestamp (< stored last_ts).
    await assert.rejects(
      relayer.enqueueReading(readingInput(device, { nonce: '6', timestamp: '400' })),
      (e: unknown) => e instanceof HttpError && e.statusCode === 409,
    );
    // Unknown meter.
    await assert.rejects(
      relayer.enqueueReading(readingInput(device, { meter_id: '999' })),
      (e: unknown) => e instanceof HttpError && e.statusCode === 404,
    );
  } finally {
    cleanup();
  }

  // Inactive meter.
  const inactive = new MockChain({
    meters: new Map([[1n, makeMeter({ id: 1n, signer: device.publicKey, active: false })]]),
  });
  const h = harness(inactive);
  try {
    await assert.rejects(
      h.relayer.enqueueReading(readingInput(device)),
      (e: unknown) => e instanceof HttpError && e.statusCode === 409,
    );
  } finally {
    h.cleanup();
  }
});

test('enqueueReading rejects a nonce already queued out-of-band', async () => {
  const device = newDeviceKey();
  const meter = makeMeter({ id: 1n, signer: device.publicKey });
  const chain = new MockChain({ meters: new Map([[1n, meter]]) });
  const { relayer, cleanup } = harness(chain);

  try {
    await relayer.enqueueReading(readingInput(device, { nonce: '10' }));
    // Same nonce again is rejected even though it is not yet on-chain.
    await assert.rejects(
      relayer.enqueueReading(readingInput(device, { nonce: '10' })),
      (e: unknown) => e instanceof HttpError && e.statusCode === 409,
    );
  } finally {
    cleanup();
  }
});

test('enqueueReading rejects malformed hex signatures with 400', async () => {
  const device = newDeviceKey();
  const meter = makeMeter({ id: 1n, signer: device.publicKey });
  const chain = new MockChain({ meters: new Map([[1n, meter]]) });
  const { relayer, cleanup } = harness(chain);

  try {
    await assert.rejects(
      relayer.enqueueReading(readingInput(device, { signature: 'zz' })),
      (e: unknown) => e instanceof HttpError && e.statusCode === 400,
    );
  } finally {
    cleanup();
  }
});

test('flush submits in FIFO order and drops contract rejections', async () => {
  const device = newDeviceKey();
  const meter = makeMeter({ id: 1n, signer: device.publicKey });
  const chain = new MockChain({
    meters: new Map([[1n, meter]]),
    submitReadingError: (args) => (args.nonce === 2n ? new ContractError('stale', 5) : undefined),
  });
  const { relayer, cleanup } = harness(chain);

  try {
    await relayer.enqueueReading(readingInput(device, { nonce: '1' }));
    await relayer.enqueueReading(readingInput(device, { nonce: '2' }));
    await relayer.enqueueReading(readingInput(device, { nonce: '3' }));

    const result = await relayer.flush(50);

    assert.deepEqual(result, { submitted: 2, dropped: 1, remaining: 0 });
    assert.deepEqual(chain.submitted.map((a) => a.nonce), [1n, 3n]);
  } finally {
    cleanup();
  }
});

test('flush stops on transient errors, leaving the rest queued', async () => {
  const device = newDeviceKey();
  const meter = makeMeter({ id: 1n, signer: device.publicKey });
  const chain = new MockChain({
    meters: new Map([[1n, meter]]),
    submitReadingError: (args) => (args.nonce === 2n ? new Error('RPC timeout') : undefined),
  });
  const { relayer, queue, cleanup } = harness(chain);

  try {
    await relayer.enqueueReading(readingInput(device, { nonce: '1' }));
    await relayer.enqueueReading(readingInput(device, { nonce: '2' }));
    await relayer.enqueueReading(readingInput(device, { nonce: '3' }));

    const result = await relayer.flush(50);

    assert.deepEqual(result, { submitted: 1, dropped: 0, remaining: 2 });
    // Nonces 2 + 3 remain queued for the next attempt.
    assert.deepEqual(queue.list().map((r) => r.nonce), [2n, 3n]);
  } finally {
    cleanup();
  }
});

test('settle returns the report and records the settled ids', async () => {
  const chain = new MockChain({ settleResult: { hash: 'tx-hash', report: makeReport() } });
  const { relayer, cleanup } = harness(chain);

  try {
    const result = await relayer.settle(['1', '2']);

    assert.equal(result.tx_hash, 'tx-hash');
    assert.equal(result.report.traded_wh, '1000');
    assert.deepEqual(chain.settled, [[1n, 2n]]);
  } finally {
    cleanup();
  }
});

test('settle defaults to the local registry and rejects an empty grid with 400', async () => {
  const chain = new MockChain({ settleResult: { hash: 'tx-hash', report: makeReport() } });
  const { relayer, registry, cleanup } = harness(chain);
  registry.add({ id: 1n, owner: 'owner', signer: 'ab'.repeat(32), registeredAt: new Date().toISOString() });

  try {
    await relayer.settle();
    assert.deepEqual(chain.settled, [[1n]]);
  } finally {
    cleanup();
  }

  const empty = harness(new MockChain({ settleResult: { hash: 'x', report: makeReport() } }));
  try {
    await assert.rejects(empty.relayer.settle(), (e: unknown) => e instanceof HttpError && e.statusCode === 400);
  } finally {
    empty.cleanup();
  }
});

test('overview aggregates config and per-meter net positions', async () => {
  const device = newDeviceKey();
  const meter = makeMeter({ id: 1n, signer: device.publicKey, nonce: 3n });
  const chain = new MockChain({
    config: makeConfig({ price: 250n }),
    meters: new Map([[1n, meter]]),
    netPositions: new Map([[1n, 900n]]),
  });
  const { relayer, registry, cleanup } = harness(chain);
  registry.add({ id: 1n, owner: meter.owner, signer: bytesToHex(device.publicKey), registeredAt: new Date().toISOString() });

  try {
    const overview = await relayer.overview();

    assert.equal(overview.config.price, '250');
    assert.equal(overview.meters.length, 1);
    assert.equal(overview.meters[0]?.net_wh, '900');
    assert.equal(overview.meters[0]?.nonce, '3');
  } finally {
    cleanup();
  }
});
