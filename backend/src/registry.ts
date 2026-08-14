/**
 * Local meter registry.
 *
 * The contract itself is the source of truth for meter state, but it does not
 * expose a "list all meters" view. The relayer keeps a small local registry of
 * the meters it is responsible for, persisted as JSON, so it can enumerate
 * them for `settle` and for the dashboard. Meters are added here whenever they
 * are registered through this service's admin endpoint.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RegistryMeter {
  id: bigint;
  owner: string;
  /** Hex-encoded Ed25519 device public key. */
  signer: string;
  registeredAt: string;
}

interface RegistryFile {
  meters: Array<{
    id: string;
    owner: string;
    signer: string;
    registeredAt: string;
  }>;
}

export class MeterRegistry {
  private readonly path: string;
  private meters: RegistryMeter[] = [];

  constructor(dataDir: string) {
    this.path = join(dataDir, 'registry.json');
  }

  load(): void {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      this.meters = (parsed.meters ?? []).map((m) => ({
        id: BigInt(m.id),
        owner: m.owner,
        signer: m.signer,
        registeredAt: m.registeredAt,
      }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.meters = [];
        return;
      }
      throw err;
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload: RegistryFile = {
      meters: this.meters.map((m) => ({
        id: m.id.toString(),
        owner: m.owner,
        signer: m.signer,
        registeredAt: m.registeredAt,
      })),
    };
    writeFileSync(this.path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  }

  list(): RegistryMeter[] {
    return [...this.meters];
  }

  get(id: bigint): RegistryMeter | undefined {
    return this.meters.find((m) => m.id === id);
  }

  add(meter: RegistryMeter): void {
    const existing = this.get(meter.id);
    if (existing) {
      existing.owner = meter.owner;
      existing.signer = meter.signer;
      return;
    }
    this.meters.push(meter);
  }

  /** Remove meters that the contract no longer knows about. */
  reconcile(knownIds: bigint[]): void {
    const set = new Set(knownIds.map((id) => id.toString()));
    this.meters = this.meters.filter((m) => set.has(m.id.toString()));
  }
}
