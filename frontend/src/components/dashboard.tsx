"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { GridOverviewDto, MeterWithPositionDto, ReportDto } from "@/lib/types";
import SubmitReading from "./submit-reading";
import WalletPanel from "./wallet-panel";

function formatWh(wh: string): string {
  const value = Number(wh) / 1000;
  return `${value.toFixed(3)} kWh`;
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function MeterCard({ meter }: { meter: MeterWithPositionDto }) {
  const net = Number(meter.net_wh);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Meter #{meter.id}</strong>
        <span className={`badge ${meter.active ? "active" : "inactive"}`}>
          {meter.active ? "active" : "inactive"}
        </span>
      </div>
      <div className="stat">
        <span className="label">Owner</span>
        <span className="value mono">{short(meter.owner)}</span>
      </div>
      <div className="stat">
        <span className="label">Net position</span>
        <span className={`value ${net >= 0 ? "pos" : "neg"}`}>{formatWh(meter.net_wh)}</span>
      </div>
      <div className="stat">
        <span className="label">Nonce</span>
        <span className="value">{meter.nonce}</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [overview, setOverview] = useState<GridOverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const [report, setReport] = useState<ReportDto | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await api.overview());
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load grid state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function settle() {
    setSettling(true);
    setError(null);
    setReport(null);
    try {
      const { report } = await api.settle();
      setReport(report);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "settlement failed");
    } finally {
      setSettling(false);
    }
  }

  if (loading && !overview) {
    return <main><p className="empty">Loading grid state…</p></main>;
  }

  if (!overview) {
    return (
      <main>
        <p className="error">{error ?? "Backend unavailable — is it running?"}</p>
        <button className="secondary" onClick={() => void load()}>Retry</button>
      </main>
    );
  }

  const { config, meters, contract_id } = overview;
  const totalNet = meters.reduce((sum, m) => sum + Number(m.net_wh), 0);

  return (
    <main>
      <h1>GridPulse</h1>
      <p className="subtitle">
        Peer-to-peer solar wheeling, settled atomically in USDC on Stellar.
      </p>

      <section className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Grid</h2>
          <button className="secondary" onClick={() => void load()}>Refresh</button>
        </div>
        <div className="stat">
          <span className="label">Contract</span>
          <span className="value mono">{contract_id}</span>
        </div>
        <div className="stat">
          <span className="label">Operator (fee recipient)</span>
          <span className="value mono">{short(config.admin)}</span>
        </div>
        <div className="stat">
          <span className="label">Settlement token</span>
          <span className="value mono">{short(config.token)}</span>
        </div>
        <div className="stat">
          <span className="label">Price</span>
          <span className="value">{config.price} base units / kWh</span>
        </div>
        <div className="stat">
          <span className="label">Operator fee</span>
          <span className="value">{(config.fee_bps / 100).toFixed(2)}%</span>
        </div>
        <div className="stat">
          <span className="label">Net energy (all meters)</span>
          <span className={`value ${totalNet >= 0 ? "pos" : "neg"}`}>{formatWh(String(totalNet))}</span>
        </div>
      </section>

      <section className="section">
        <h2>Meters</h2>
        {meters.length === 0 ? (
          <p className="empty">No meters registered yet — register one via the backend admin API.</p>
        ) : (
          <div className="cards">
            {meters.map((m) => (
              <MeterCard key={m.id} meter={m} />
            ))}
          </div>
        )}
      </section>

      <section className="card section">
        <h2>Settle</h2>
        <div className="row">
          <button onClick={settle} disabled={settling || meters.length === 0}>
            {settling ? "Settling…" : "Settle window"}
          </button>
          {report && (
            <span className="ok">
              Wheeled {formatWh(report.traded_wh)} · paid {report.paid_out} · fee {report.fee}
            </span>
          )}
          {error && <span className="error">{error}</span>}
        </div>
      </section>

      <SubmitReading />

      <WalletPanel tokenAddress={config.token} spender={contract_id} />
    </main>
  );
}
