/**
 * Environment-driven configuration for the GridPulse relayer/API.
 *
 * Everything the service needs is read from the environment (or a `.env`
 * file loaded by `dotenv`), validated eagerly so misconfiguration fails fast
 * at boot instead of halfway through a relay.
 */

import 'dotenv/config';

export interface AppConfig {
  host: string;
  port: number;
  /** Soroban RPC endpoint. */
  rpcUrl: string;
  /** Stellar network passphrase (must match the RPC endpoint's network). */
  networkPassphrase: string;
  /** Deployed GridPulse contract id. */
  contractId: string;
  /** Secret key of the account that signs + funds relay/settle transactions. */
  relayerSecret: string;
  /** Optional operator secret key for admin endpoints (register, price, fee). */
  adminSecret: string | null;
  /** Directory for the local meter registry (JSON). */
  dataDir: string;
}

const TESTNET = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  passphrase: 'Test SDF Network ; September 2015',
};

const MAINNET = {
  rpcUrl: 'https://mainnet.sorobanrpc.com',
  passphrase: 'Public Global Stellar Network ; September 2015',
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const network = (env.NETWORK ?? 'testnet').toLowerCase();
  const preset = network === 'mainnet' ? MAINNET : TESTNET;

  const config: AppConfig = {
    host: env.HOST?.trim() || '0.0.0.0',
    port: Number(env.PORT ?? 4000),
    // `|| preset` (not `??`) so an empty string from a container env var is
    // treated as unset and falls back to the network preset.
    rpcUrl: env.RPC_URL?.trim() || preset.rpcUrl,
    networkPassphrase: env.NETWORK_PASSPHRASE?.trim() || preset.passphrase,
    contractId: required(env, 'CONTRACT_ID'),
    relayerSecret: required(env, 'RELAYER_SECRET'),
    adminSecret: env.ADMIN_SECRET?.trim() || null,
    dataDir: env.DATA_DIR?.trim() || './data',
  };

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`Invalid PORT: ${config.port}`);
  }

  return config;
}
