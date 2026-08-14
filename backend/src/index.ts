import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const cfg = loadConfig();
const app = buildServer(cfg);

try {
  await app.listen({ host: cfg.host, port: cfg.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Stop background jobs and close cleanly on termination signals.
const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
