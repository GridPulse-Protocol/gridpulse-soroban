"use client";

/**
 * Connect Freighter and approve the GridPulse contract as a SEP-41 spender on
 * the settlement token (USDC). Homes only need to approve once — settlement
 * then pulls USDC from consumers via `transfer_from` up to this allowance.
 */

import { useEffect, useState } from "react";
import { approveToken, connectWallet, MAX_I128, walletAddress } from "@/lib/stellar";

export default function WalletPanel({
  tokenAddress,
  spender,
}: {
  tokenAddress: string;
  spender: string;
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void walletAddress().then(setAddress);
  }, []);

  async function connect() {
    setError(null);
    try {
      setAddress(await connectWallet());
    } catch (err) {
      setError(err instanceof Error ? err.message : "connection failed");
    }
  }

  async function approveMax() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const hash = await approveToken({
        tokenAddress,
        spenderContractId: spender,
        amount: MAX_I128,
        expirationLedger: 0,
      });
      setMessage(`Approved max allowance (tx ${hash.slice(0, 12)}…)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "approve failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card section">
      <h2>Wallet</h2>
      {address ? (
        <>
          <div className="stat">
            <span className="label">Connected</span>
            <span className="value mono">{address.slice(0, 8)}…{address.slice(-6)}</span>
          </div>
          <div className="form-row">
            <label>Spender (contract)</label>
            <div className="mono">{spender}</div>
          </div>
          <div className="row">
            <button onClick={approveMax} disabled={busy || !tokenAddress}>
              {busy ? "Approving…" : "Approve max USDC"}
            </button>
            {message && <span className="ok">{message}</span>}
            {error && <span className="error">{error}</span>}
          </div>
        </>
      ) : (
        <div className="row">
          <button onClick={connect}>Connect Freighter</button>
          <span className="empty">Required to approve USDC for settlement</span>
          {error && <span className="error">{error}</span>}
        </div>
      )}
    </section>
  );
}
