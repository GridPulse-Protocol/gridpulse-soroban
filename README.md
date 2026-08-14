# GridPulse · Soroban

Decentralized Physical Infrastructure Network (DePIN) for residential solar
microgrids on [Stellar](https://stellar.org). Low-cost IoT smart meters on
rooftop solar read generation and consumption in real time, sign on-chain
state updates, and let neighbors wheel surplus power to each other with an
**atomic USDC payment swap** settled in seconds on Soroban — no centralized
utility database in the loop.

## How it works

```
 ┌────────────┐  signed readings   ┌────────────────────────────┐
 │ IoT meter  │ ─────────────────▶ │  GridPulse contract        │
 │ (Ed25519)  │                    │  - register meters         │
 └────────────┘                    │  - verify signed readings  │
                                   │  - net energy per window   │
 ┌────────────┐  approve USDC      │  - settle: P2P USDC swap   │
 │  home A/C  │ ─────────────────▶ │    consumer → producer     │
 └────────────┘                    │    + operator fee          │
                                   └──────────────┬─────────────┘
                                                  │ transfer_from (SEP-41)
                                                  ▼
                                        ┌──────────────────┐
                                        │  USDC (SAC / SEP-41) │
                                        └──────────────────┘
```

1. A grid operator registers meters, each bound to an owner account and the
   Ed25519 public key baked into the physical device.
2. Each meter signs a canonical 40-byte payload `(meter_id, timestamp,
   generation_wh, consumption_wh, nonce)` and posts it as a reading. The
   contract verifies the signature, enforces nonce replay protection and
   timestamp monotonicity, and accumulates a per-meter **net** position
   (`generation - consumption`) in watt-hours.
3. Anyone (a relayer, the operator, or a participant) calls `settle`, which
   closes the window: net surplus meters are **producers**, net deficit
   meters are **consumers**. The contract wheels `min(surplus, deficit)`
   and, in one invocation, executes `transfer_from` for each consumer →
   producer leg plus the operator fee. Homes pre-approve the contract as a
   SEP-41 spender, so the whole swap is atomic and trustless.

## Settlement math

Units: energy in **watt-hours (Wh)**, money in **token base units**
(`1 USDC = 10^6` base units for 6-decimal USDC). `price` is configured in
base units per **kWh** (1000 Wh).

For a window with total surplus `S`, total deficit `D`, and wheeled
`T = min(S, D)`:

* consumer pays `matched_wh · price / 1000`, where
  `matched_wh = deficit · T / D`;
* the operator fee is `fee_bps` of consumer payments;
* producers split the remaining pool pro-rata to `surplus · T / S`.

Because producer payouts are carved from the *actual* collected amount and
rounding is folded into the operator fee, the books always balance exactly:

```
Σ consumer payments == Σ producer payouts + operator fee
```

If a home exports more than the grid imports (or vice versa), the longer side
is curtailed pro-rata, so the market always clears.

## Repository layout

The repo is a three-layer monorepo: the Soroban **contract**, a Node **backend**
(relayer + REST API), and a Next.js **frontend** dashboard.

```
Cargo.toml / Makefile           # contract workspace + build targets
contracts/gridpulse/            # ── Smart contract (Soroban) ──
  src/
    lib.rs                      # crate root, re-exports
    contract.rs                 # #[contractimpl] public functions
    meter.rs                    # signed reading submission + payload layout
    settle.rs                   # settlement engine (P2P swap + fee)
    types.rs                    # contracttype structs + storage keys
    error.rs                    # contracterror enum
    events.rs                   # contractevent structs
    storage.rs                  # storage access + TTL management
    test.rs                     # unit tests (mock token, Ed25519, math)
backend/                        # ── Relayer + REST API (Fastify/TS) ──
  src/
    index.ts / server.ts        # entrypoint + wiring
    config.ts                   # env config
    chain.ts                    # typed Soroban client wrapper
    relayer.ts                  # verify + relay readings, settle
    admin.ts                    # operator-only mutations
    signature.ts                # canonical payload + Ed25519 verify
    registry.ts                 # local meter registry (JSON)
    routes.ts                   # HTTP routes
frontend/                       # ── Dashboard (Next.js/TS) ──
  src/
    app/                        # App Router pages + styles
    components/                 # dashboard, wallet, submit-reading
    lib/                        # API client, types, Stellar wallet helpers
```

On-chain storage is namespaced by lifetime: meter registrations live in
**persistent** storage (with TTL refresh), per-window net positions in
**temporary** storage (cleared on settle), and the grid config in **instance**
storage.

## Requirements

* [Rust](https://rustup.rs) 1.84+ (`rust-toolchain.toml` pins the channel)
* [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)
  (`stellar`) — it owns the `wasm32v1-none` target and the build settings the
  Soroban runtime requires.
* [Node.js](https://nodejs.org) 20+ for the backend and frontend.

## Running the full stack

1. **Build & deploy the contract** (see *Deploy & try it* below), then note the
   contract id and the USDC SAC address.
2. **Start the backend** — a funded relayer account signs the permissionless
   `submit_reading`/`settle` calls; optionally an `ADMIN_SECRET` enables the
   operator endpoints:

   ```bash
   cd backend
   cp .env.example .env     # set CONTRACT_ID, RELAYER_SECRET, (ADMIN_SECRET)
   npm install && npm run dev
   ```

3. **Start the frontend**:

   ```bash
   cd frontend
   cp .env.local.example .env.local
   npm install && npm run dev   # http://localhost:3000
   ```

See `backend/README.md` and `frontend/README.md` for the API surface and
wallet/approve flow.

## Run with Docker

The backend and frontend ship with multi-stage Dockerfiles and a root
`docker-compose.yml` that runs them together:

```bash
cp .env.example .env       # fill in CONTRACT_ID and RELAYER_SECRET
docker compose up -d --build
```

* Backend → http://localhost:4000 (`/health` to confirm it is up)
* Frontend → http://localhost:3000

The frontend waits for the backend to report healthy before starting, and the
meter registry persists in a named volume (`gridpulse-data`). The API URL is
baked into the frontend image at build time (default `http://localhost:4000`);
set `NEXT_PUBLIC_API_URL` in `.env` and rebuild if the backend is reachable
from a different host.

## Build, test, lint

```bash
make build      # stellar contract build → target/wasm32v1-none/release/gridpulse.wasm
make test       # cargo test
make clippy     # cargo clippy --all-targets -- -D warnings
make fmt        # cargo fmt
```

> Build contracts with `stellar contract build`, **not** `cargo build` — the
> Soroban runtime only supports the `wasm32v1-none` target.

## Deploy & try it

```bash
stellar contract build

stellar contract deploy \
  --wasm target/wasm32v1-none/release/gridpulse.wasm \
  --network testnet \
  --source-account alice \
  -- \
  --admin <operator> \
  --token <usdc-sac-address> \
  --price 1000000 \
  --fee-bps 100
```

`--price 1000000` is `1.00` USDC per kWh for 6-decimal USDC; `--fee-bps 100`
is a 1% operator fee.

## Signature scheme (for meter firmware / relays)

A reading is valid only if the device signs, with Ed25519, the 40-byte
big-endian concatenation of five `u64` fields:

```
meter_id ‖ timestamp ‖ generation_wh ‖ consumption_wh ‖ nonce
```

There is no domain-separation prefix — device firmware and relays must sign
these exact bytes. The contract verifies with `env.crypto().ed25519_verify`;
an invalid signature reverts the invocation before any state changes.

Pseudocode for the device:

```
payload = be64(meter_id) ++ be64(timestamp) ++ be64(gen_wh) ++ be64(cons_wh) ++ be64(nonce)
signature = ed25519_sign(device_secret_key, payload)
```

## Interface

| Function | Access | Purpose |
| --- | --- | --- |
| `register_meter(owner, signer)` | admin | register a meter, returns id |
| `set_meter_active(id, active)` | admin | pause/resume a meter |
| `update_meter_owner(id, owner)` | admin | reassign a meter |
| `set_price(price)` | admin | update clearing price (per kWh) |
| `set_fee_bps(fee_bps)` | admin | update operator fee (≤ 10000) |
| `submit_reading(...)` | anyone | verify + accumulate a signed reading |
| `settle(meter_ids)` | anyone | atomically wheel + swap USDC |
| `config()` / `meter(id)` / `net_position(id)` | view | read state |

The settlement token is any SEP-41 token — on Stellar, USDC is the issued
asset exposed through its Stellar Asset Contract, so the same `TokenClient`
calls work unchanged.

## Security notes

* **Replay protection** — every reading carries a strictly increasing nonce;
  replayed or stale nonces revert.
* **Monotonic time** — timestamps may not move backwards per meter.
* **Device binding** — only the registered Ed25519 key can submit readings for
  a meter, so a compromised relayer cannot fabricate energy.
* **Allowance-scoped swaps** — the contract only ever spends what homes have
  explicitly approved; settlement cannot touch unapproved balances.
* **Admin gating** — configuration and registration are host-enforced via
  `require_auth`, so only the operator account (or a multisig/custom account
  in its place) can mutate them.

## Scope & next steps

This is a focused reference implementation. Natural extensions: dynamic
pricing curves, market/order-book matching across multiple microgrids,
meter self-registration with proof-of-device attestation, and an off-chain
oracle/relayer crate that batches signed readings.
