import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MeterRegistry } from '../src/registry.js';
import type { RegistryMeter } from '../src/registry.js';

function makeMeter(id: bigint, owner = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'): RegistryMeter {
  return { id, owner, signer: 'ab'.repeat(32), registeredAt: new Date().toISOString() };
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'gridpulse-registry-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('add/get/list return and update meters', () => {
  withDir((dir) => {
    const r = new MeterRegistry(dir);
    r.add(makeMeter(1n));
    r.add(makeMeter(2n));

    assert.equal(r.list().length, 2);
    assert.equal(r.get(1n)?.owner, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    assert.equal(r.get(3n), undefined);

    // Adding an existing id updates owner/signer in place.
    r.add(makeMeter(1n, 'GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'));
    assert.equal(r.list().length, 2);
    assert.equal(r.get(1n)?.owner, 'GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
  });
});

test('reconcile removes meters the contract no longer knows', () => {
  withDir((dir) => {
    const r = new MeterRegistry(dir);
    r.add(makeMeter(1n));
    r.add(makeMeter(2n));
    r.add(makeMeter(3n));

    r.reconcile([1n, 3n]);

    assert.deepEqual(r.list().map((m) => m.id), [1n, 3n]);
  });
});

test('persists across instances and survives restart', () => {
  withDir((dir) => {
    const r1 = new MeterRegistry(dir);
    r1.add(makeMeter(1n));
    r1.add(makeMeter(2n, 'GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'));
    r1.save();

    const r2 = new MeterRegistry(dir);
    r2.load();

    assert.equal(r2.list().length, 2);
    assert.equal(r2.get(2n)?.owner, 'GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    assert.equal(r2.get(2n)?.signer, 'ab'.repeat(32));
  });
});

test('load() is a no-op when the backing file does not exist', () => {
  withDir((dir) => {
    const r = new MeterRegistry(dir);
    r.load(); // no throw
    assert.equal(r.list().length, 0);
  });
});
