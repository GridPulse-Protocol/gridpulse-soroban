"use client";

/**
 * Demo form for posting a signed reading to the relayer. In production the
 * reading is produced and signed by the IoT meter firmware; this form exists so
 * a developer can exercise the full relay path by hand (the signature can be
 * generated with the same 40-byte big-endian payload the contract expects).
 */

import { useState } from "react";
import { api } from "@/lib/api";

const EMPTY = {
  meter_id: "",
  timestamp: String(Math.floor(Date.now() / 1000)),
  generation_wh: "",
  consumption_wh: "",
  nonce: "",
  signature: "",
};

export default function SubmitReading() {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.submitReading(form);
      setResult(`Relayed ${res.meter_id} → net ${res.net_wh} Wh (tx ${res.tx_hash.slice(0, 12)}…)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "submission failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card section">
      <h2>Submit a signed reading</h2>
      <form onSubmit={submit}>
        <div className="cards" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div className="form-row">
            <label>meter_id (u64)</label>
            <input value={form.meter_id} onChange={set("meter_id")} placeholder="1" />
          </div>
          <div className="form-row">
            <label>timestamp (unix seconds)</label>
            <input value={form.timestamp} onChange={set("timestamp")} />
          </div>
          <div className="form-row">
            <label>generation_wh</label>
            <input value={form.generation_wh} onChange={set("generation_wh")} placeholder="1500" />
          </div>
          <div className="form-row">
            <label>consumption_wh</label>
            <input value={form.consumption_wh} onChange={set("consumption_wh")} placeholder="600" />
          </div>
          <div className="form-row">
            <label>nonce</label>
            <input value={form.nonce} onChange={set("nonce")} placeholder="1" />
          </div>
          <div className="form-row">
            <label>signature (hex, 64 bytes)</label>
            <input value={form.signature} onChange={set("signature")} placeholder="0x…" />
          </div>
        </div>
        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? "Relaying…" : "Relay reading"}
          </button>
          {result && <span className="ok">{result}</span>}
          {error && <span className="error">{error}</span>}
        </div>
      </form>
    </section>
  );
}
