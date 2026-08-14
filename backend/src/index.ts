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
