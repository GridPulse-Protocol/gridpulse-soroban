/**
 * HTTP surface for the GridPulse relayer.
 *
 * Reads are served from on-chain state (via the SDK's read-only simulation).
 * `POST /readings` validates + queues a signed reading; the background
 * scheduler (or `POST /flush`) drains the queue to the chain, and `POST
 * /settle` (or the scheduler) closes a settlement window. Admin mutations
 * require `ADMIN_SECRET` to be configured.
 */

import type { FastifyInstance } from 'fastify';

import { Admin } from './admin.js';
import { ContractError } from './chain.js';
import type { AppConfig } from './config.js';
import { HttpError } from './errors.js';
import { Relayer } from './relayer.js';
import type { ReadingInput } from './relayer.js';
import type { RelayScheduler } from './scheduler.js';
import { meterToDto, parseU64 } from './types.js';

export interface Services {
  config: AppConfig;
  relayer: Relayer;
  admin: Admin;
  scheduler: RelayScheduler;
}

interface Params {
  id: string;
}

interface ReadingsBody extends ReadingInput {}

interface SettleBody {
  meter_ids?: string[];
}

interface RegisterMeterBody {
  owner: string;
  signer: string;
}

interface ActiveBody {
  active: boolean;
}

interface ConfigPatchBody {
  price?: string;
  fee_bps?: number;
}

export function registerRoutes(app: FastifyInstance, services: Services): void {
  const { config, relayer, admin, scheduler } = services;

  app.get('/health', async () => ({
    status: 'ok',
    contract_id: config.contractId,
    network: config.networkPassphrase,
    relayer: relayer.chain.signerPublicKey,
  }));

  // ---- Grid state --------------------------------------------------------

  app.get('/api/overview', async () => relayer.overview());

  app.get<{ Params: Params }>('/api/meters/:id', async (request) => {
    const meterId = parseU64(request.params.id, 'meter_id');
    const meter = await relayer.chain.meter(meterId);
    if (!meter) throw new HttpError(404, `meter ${meterId} is not registered`);
    const net = await relayer.chain.netPosition(meterId);
    return { meter: { ...meterToDto(meter), net_wh: net.toString() } };
  });

  // ---- Relayer entry points ----------------------------------------------

  app.post<{ Body: ReadingsBody }>('/api/readings', async (request) => {
    const result = await relayer.enqueueReading(request.body ?? ({} as ReadingsBody));
    return { status: 'queued', ...result };
  });

  app.post('/api/flush', async () => relayer.flush(config.batchSize));

  app.get('/api/queue', async () => ({
    size: relayer.queueSize(),
    readings: relayer.queueList(),
  }));

  app.get('/api/jobs', async () => scheduler.status());

  app.post<{ Body: SettleBody }>('/api/settle', async (request) => {
    const { meter_ids } = request.body ?? {};
    return relayer.settle(meter_ids);
  });

  // ---- Admin -------------------------------------------------------------

  app.post<{ Body: RegisterMeterBody }>('/api/admin/meters', async (request) => {
    const { owner, signer } = request.body ?? ({} as RegisterMeterBody);
    if (!owner || !signer) throw new HttpError(400, 'owner and signer are required');
    return admin.registerMeter(owner, signer);
  });

  app.patch<{ Params: Params; Body: ActiveBody }>('/api/admin/meters/:id/active', async (request) => {
    const { active } = request.body ?? ({} as ActiveBody);
    if (typeof active !== 'boolean') throw new HttpError(400, 'active must be a boolean');
    return admin.setMeterActive(request.params.id, active);
  });

  app.patch<{ Body: ConfigPatchBody }>('/api/admin/config', async (request) => {
    const { price, fee_bps } = request.body ?? {};
    const result: { price?: { tx_hash: string }; fee_bps?: { tx_hash: string } } = {};
    if (price !== undefined) result.price = await admin.setPrice(price);
    if (fee_bps !== undefined) result.fee_bps = await admin.setFeeBps(fee_bps);
    if (Object.keys(result).length === 0) {
      throw new HttpError(400, 'nothing to update: provide price and/or fee_bps');
    }
    return result;
  });
}

/** Convert a thrown error to an HTTP status code + body. */
export function mapError(err: unknown): { statusCode: number; message: string } {
  if (err instanceof HttpError) return { statusCode: err.statusCode, message: err.message };
  if (err instanceof ContractError) return { statusCode: 409, message: err.message };
  if (err instanceof Error) return { statusCode: 500, message: err.message };
  return { statusCode: 500, message: 'internal error' };
}
