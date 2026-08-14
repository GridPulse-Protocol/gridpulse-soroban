# GridPulse Frontend

The **dashboard** for GridPulse — a [Next.js](https://nextjs.org) (App Router,
TypeScript) app that visualizes the solar microgrid and lets a home participate
in settlement.

## What it does

- **Grid overview** — clearing price, operator fee, contract id, and the live
  net energy position of every registered meter (fetched from the backend API).
- **Settle** — triggers an atomic P2P settlement window through the relayer.
- **Submit reading** — a demo form to hand-relay a signed reading for testing.
- **Wallet** — connects [Freighter](https://freighter.app) and approves the
  GridPulse contract as a SEP-41 spender on USDC, which is the one-time step a
  home must take before settlement can pull its USDC.

## Setup

```bash
cp .env.local.example .env.local
# NEXT_PUBLIC_API_URL → where the backend runs (default http://localhost:4000)
npm install
npm run dev
```

Open http://localhost:3000. The dashboard expects the backend to be running —
see [`../backend`](../backend) for how to start it.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Backend REST API base URL |
| `NEXT_PUBLIC_NETWORK` | `testnet` | Stellar network for wallet interactions |

## Notes

- All on-chain integers are surfaced as decimal strings (the backend converts
  `u64`/`i128` values so the UI never risks JSON number precision loss).
- The wallet approve flow builds the SEP-41 `approve` invocation directly with
  `@stellar/stellar-sdk` and signs it through Freighter; the browser never sees
  a secret key.
