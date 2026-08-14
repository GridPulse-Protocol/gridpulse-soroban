/**
 * Typed client for the GridPulse backend REST API. Runs entirely in the
 * browser; the backend is a separate Fastify service.
 */

import type { GridOverviewDto, SettleResult } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  const body = (await res.json().catch(() => ({}))) as { error?: string };

  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `request failed (${res.status})`);
  }

  return body as T;
}

export interface ReadingInput {
  meter_id: string;
  timestamp: string;
  generation_wh: string;
  consumption_wh: string;
  nonce: string;
  signature: string;
}

export const api = {
  overview: () => request<GridOverviewDto>("/api/overview"),

  submitReading: (reading: ReadingInput) =>
    request<{ status: string; meter_id: string; queue_size: number }>(
      "/api/readings",
      { method: "POST", body: JSON.stringify(reading) },
    ),

  flush: () =>
    request<{ submitted: number; dropped: number; remaining: number }>("/api/flush", {
      method: "POST",
    }),

  settle: (meterIds?: string[]) =>
    request<SettleResult>("/api/settle", {
      method: "POST",
      body: JSON.stringify(meterIds ? { meter_ids: meterIds } : {}),
    }),
};
