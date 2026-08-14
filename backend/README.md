# GridPulse Backend

The **relayer + REST API** for GridPulse. It bridges low-cost IoT smart meters
to the Soroban contract:

- accepts signed meter readings over HTTP, verifies the device's Ed25519
  signature *locally*, then queues them for on-chain submission;
- a background **scheduler** drains the queue to the chain in batches
  (`submit_reading`) and closes settlement windows (`settle`) on a cadence;
- serves the grid state (config, meters, net positions) for the frontend;
- exposes operator-only admin endpoints (register meters, set price/fee).

## Stack

- [Fastify](https://fastify.dev) (Node.js + TypeScript, ESM)
- [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) — uses the
  modern `Client` API that generates typed methods from the contract's on-chain
  WASM spec.
- [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) — local
  signature verification of the canonical 40-byte reading payload.

## Setup

```bash
cp .env.example .env
# fill in CONTRACT_ID and RELAYER_SECRET (and ADMIN_SECRET for admin endpoints)
npm install
npm run dev          # tsx watch
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | liveness + contract id + relayer address |
| `GET` | `/api/overview` | config + every registered meter with net position |
| `GET` | `/api/meters/:id` | one meter + its net position |
| `POST` | `/api/readings` | validate + enqueue a signed reading |
| `POST` | `/api/flush` | drain the queue to the chain now |
| `GET` | `/api/queue` | pending readings |
| `GET` | `/api/jobs` | scheduler status (last flush/settle) |
| `POST` | `/api/settle` | settle all meters (or `{ meter_ids }`) |
| `POST` | `/api/admin/meters` | register a meter (admin) |
| `PATCH` | `/api/admin/meters/:id/active` | pause/resume a meter (admin) |
| `PATCH` | `/api/admin/config` | set `price` and/or `fee_bps` (admin) |

### Posting a reading

`u64` values are decimal strings (JSON numbers cannot safely hold them) and the
signature is hex. The payload signed by the device is the big-endian
concatenation of `meter_id ‖ timestamp ‖ generation_wh ‖ consumption_wh ‖ nonce`
(no domain-separating prefix) — see the contract's `meter.rs`.

```bash
curl -X POST http://localhost:4000/api/readings \
  -H 'content-type: application/json' \
  -d '{
    "meter_id": "1",
    "timestamp": "1723492800",
    "generation_wh": "1500",
    "consumption_wh": "600",
    "nonce": "42",
    "signature": "<128-hex-char ed25519 signature>"
  }'
```

Readings are acknowledged immediately (`{"status":"queued", ...}`) and are
submitted to the chain by the scheduler — or force an immediate drain with
`POST /api/flush`.

## Relayer & scheduling

Ingest and on-chain submission are decoupled:

1. `POST /api/readings` validates the reading (signature, meter state, nonce
   ordering — including against other queued readings) and appends it to a
   **persistent queue** (`$DATA_DIR/readings.json`), so it survives restarts.
2. The scheduler flushes the queue in FIFO order, `BATCH_SIZE` readings at a
   time, every `BATCH_INTERVAL_SECONDS`. A contract rejection (stale nonce,
   inactive meter) is dropped; a transient RPC error stops the batch and leaves
   the rest queued for the next tick.
3. If `AUTO_SETTLE` is enabled, the scheduler also closes a settlement window
   every `SETTLE_INTERVAL_SECONDS`.

| Env var | Default | Purpose |
| --- | --- | --- |
| `SCHEDULER_ENABLED` | `true` | run the background jobs (disable for manual-only) |
| `BATCH_INTERVAL_SECONDS` | `15` | cadence for draining the queue |
| `BATCH_SIZE` | `50` | max readings per flush |
| `AUTO_SETTLE` | `true` | close windows automatically |
| `SETTLE_INTERVAL_SECONDS` | `300` | cadence for settlement |

`GET /api/jobs` reports whether the scheduler is running plus the last flush
result and last settle error.

## Roles

Two keys keep duties separate:

- **`RELAYER_SECRET`** — pays transaction fees and signs the permissionless
  `submit_reading` / `settle` calls. It holds no authority over grid config or
  meter registration.
- **`ADMIN_SECRET`** — the operator account set as the contract's `admin`. Only
  it can register meters and change the clearing price or fee.

The relayer is trust-minimized: it cannot fabricate energy because it only ever
forwards readings whose signature verifies against the device key stored
on-chain, and it cannot steal USDC because settlement spends only what each home
has pre-approved via SEP-41.

## Build

```bash
npm run build    # tsc → dist/
npm start        # node dist/index.js
```

## Docker

A multi-stage `Dockerfile` is included and wired into the root
`docker-compose.yml` — run the whole stack with `docker compose up -d --build`
from the repo root.
