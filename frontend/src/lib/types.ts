/**
 * Types mirroring the backend's JSON DTOs. All on-chain integers arrive as
 * decimal strings and byte buffers as hex, so the UI never touches JSON
 * number-precision pitfalls.
 */

export interface ConfigDto {
  admin: string;
  token: string;
  /** Clearing price in token base units per kWh. */
  price: string;
  /** Operator fee in basis points (1/10000). */
  fee_bps: number;
}

export interface MeterWithPositionDto {
  id: string;
  owner: string;
  signer: string;
  active: boolean;
  nonce: string;
  last_ts: string;
  net_wh: string;
}

export interface GridOverviewDto {
  contract_id: string;
  config: ConfigDto;
  meters: MeterWithPositionDto[];
}

export interface ReportDto {
  traded_wh: string;
  producers: number;
  consumers: number;
  paid_out: string;
  fee: string;
}

export interface SettleResult {
  report: ReportDto;
  tx_hash: string;
}
