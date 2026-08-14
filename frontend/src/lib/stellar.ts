/**
 * Browser-side Stellar helpers: Freighter wallet connection and the SEP-41
 * `approve` call that lets the GridPulse contract spend a home's USDC during
 * settlement.
 *
 * The settle step in the contract pulls USDC from each consumer via
 * `transfer_from`, so a home must approve the GridPulse contract as a spender
 * once before its first settlement. That approval is signed here by the home's
 * Freighter wallet.
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";

export interface NetworkConfig {
  passphrase: string;
  rpcUrl: string;
}

export function getNetworkConfig(): NetworkConfig {
  const network = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet").toLowerCase();
  if (network === "mainnet") {
    return {
      passphrase: Networks.PUBLIC,
      rpcUrl: "https://mainnet.sorobanrpc.com",
    };
  }
  return {
    passphrase: Networks.TESTNET,
    rpcUrl: "https://soroban-testnet.stellar.org",
  };
}

/** Return the connected Freighter public key, or null when not connected. */
export async function walletAddress(): Promise<string | null> {
  try {
    const connected = await isConnected();
    if (!connected.isConnected) return null;
    const { address } = await getAddress();
    return address ?? null;
  } catch {
    return null;
  }
}

/** Request Freighter access and return the granted public key. */
export async function connectWallet(): Promise<string> {
  const { address } = await requestAccess();
  if (!address) throw new Error("Freighter did not return an address");
  return address;
}

/**
 * Approve the GridPulse contract to spend `amount` (in token base units) of
 * the settlement token on behalf of the connected wallet.
 *
 * `expirationLedger === 0` means the allowance never expires; pass a positive
 * ledger to bound it instead.
 */
export async function approveToken(args: {
  tokenAddress: string;
  spenderContractId: string;
  amount: bigint;
  expirationLedger: number;
}): Promise<string> {
  const { tokenAddress, spenderContractId, amount, expirationLedger } = args;

  const { passphrase, rpcUrl } = getNetworkConfig();
  const connected = await isConnected();
  if (!connected.isConnected) {
    throw new Error("Freighter is not connected");
  }

  const details = await getNetworkDetails();
  if (details.networkPassphrase && details.networkPassphrase !== passphrase) {
    throw new Error(
      `Freighter is on "${details.network}" but the app expects "${passphrase}"`,
    );
  }

  const { address } = await getAddress();
  if (!address) throw new Error("Freighter did not return an address");

  const server = new Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const account = await server.getAccount(address);

  const contract = new Contract(tokenAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      contract.call(
        "approve",
        new Address(address).toScVal(), // from
        new Address(spenderContractId).toScVal(), // spender
        nativeToScVal(amount, { type: "i128" }), // amount
        nativeToScVal(expirationLedger, { type: "u32" }), // expiration_ledger
      ),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);

  const signed = await signTransaction(prepared.toXDR(), {
    networkPassphrase: passphrase,
    address,
  });
  if (!signed.signedTxXdr) {
    throw new Error("Freighter did not return a signed transaction");
  }

  const envelope = TransactionBuilder.fromXDR(signed.signedTxXdr, passphrase);
  const result = await server.sendTransaction(envelope);
  if (result.status === "ERROR") {
    throw new Error(`approve transaction failed: ${result.errorResult ?? result.status}`);
  }
  return result.hash;
}

/** Maximum i128 value — used by the "approve max" action. */
export const MAX_I128 = (1n << 127n) - 1n;
