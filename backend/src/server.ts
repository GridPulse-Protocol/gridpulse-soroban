import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { Admin } from './admin.js';
import { GridPulse } from './chain.js';
import type { AppConfig } from './config.js';
import { MeterRegistry } from './registry.js';
import { Relayer } from './relayer.js';
import { mapError, registerRoutes } from './routes.js';

/**
 * Build the Fastify app with all dependencies wired up. Kept separate from the
 * entrypoint so it can be reused by tests without binding a port.
 */
export function buildServer(cfg: AppConfig): FastifyInstance {
  const app = Fastify({ logger: true });

  void app.register(cors, { origin: true });

  const registry = new MeterRegistry(cfg.dataDir);
  registry.load();

  const relayerChain = new GridPulse(cfg, cfg.relayerSecret);
  const adminChain = cfg.adminSecret ? new GridPulse(cfg, cfg.adminSecret) : null;

  const relayer = new Relayer(relayerChain, registry);
  const admin = new Admin(adminChain, registry);

  registerRoutes(app, { config: cfg, relayer, admin });

  app.setErrorHandler((err, _request, reply) => {
    const { statusCode, message } = mapError(err);
    app.log.error({ err }, message);
    void reply.status(statusCode).send({ error: message });
  });

  return app;
}
