import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ReadingQueue } from '../src/queue.js';
import type { QueuedReading } from '../src/queue.js';

function makeReading(meterId: bigint, nonce: bigint): QueuedReading {
  return {
    meterId,
    timestamp: 100n + nonce,
    generationWh: 10n,
    consumptionWh: 5n,
    nonce,
    signature: new Uint8Array(64),
    enqueuedAt: new Date().toISOString(),
  };
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'gridpulse-queue-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('enqueue/peek/removeFirst maintain FIFO order', () => {
  withDir((dir) => {
    const q = new ReadingQueue(dir);
    q.enqueue(makeReading(1n, 1n));
    q.enqueue(makeReading(1n, 2n));
    q.enqueue(makeReading(2n, 1n));

    assert.equal(q.size(), 3);
    assert.deepEqual(
      q.peek(2).map((r) => r.nonce),
      [1n, 2n],
    );

    q.removeFirst(2);
    assert.equal(q.size(), 1);
    assert.equal(q.peek(1)[0]?.meterId, 2n);
  });
});

test('lastQueuedNonce tracks the highest nonce per meter', () => {
  withDir((dir) => {
    const q = new ReadingQueue(dir);
    assert.equal(q.lastQueuedNonce(1n), 0n);

    q.enqueue(makeReading(1n, 5n));
    q.enqueue(makeReading(1n, 3n));
    q.enqueue(makeReading(2n, 9n));

    assert.equal(q.lastQueuedNonce(1n), 5n);
    assert.equal(q.lastQueuedNonce(2n), 9n);
    assert.equal(q.lastQueuedNonce(3n), 0n);
  });
});

test('list() returns copies so callers cannot mutate the queue', () => {
  withDir((dir) => {
    const q = new ReadingQueue(dir);
    q.enqueue(makeReading(1n, 1n));

    const [first] = q.list();
    first!.signature.fill(0xff);

    assert.notEqual(q.peek(1)[0]?.signature[0], 0xff);
  });
});

test('persists across instances and survives restart', () => {
  withDir((dir) => {
    const q1 = new ReadingQueue(dir);
    q1.enqueue(makeReading(1n, 1n));
    q1.enqueue(makeReading(2n, 7n));

    const q2 = new ReadingQueue(dir);
    q2.load();

    assert.equal(q2.size(), 2);
    assert.deepEqual(
      q2.list().map((r) => [r.meterId, r.nonce, [...r.signature]]),
      [
        [1n, 1n, Array(64).fill(0)],
        [2n, 7n, Array(64).fill(0)],
      ],
    );
  });
});

test('load() is a no-op when the backing file does not exist', () => {
  withDir((dir) => {
    const q = new ReadingQueue(dir);
    q.load(); // no throw
    assert.equal(q.size(), 0);
  });
});

test('clear() empties the queue and persists the empty state', () => {
  withDir((dir) => {
    const q = new ReadingQueue(dir);
    q.enqueue(makeReading(1n, 1n));
    q.clear();
    assert.equal(q.size(), 0);

    const reloaded = new ReadingQueue(dir);
    reloaded.load();
    assert.equal(reloaded.size(), 0);
  });
});
