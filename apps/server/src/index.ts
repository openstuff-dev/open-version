import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ensureFirstAdmin } from './bootstrap.js';
import { loadConfig } from './config.js';
import { loadVault, type Vault } from './crypto.js';
import { createPool, migrate } from './db.js';
import { policyFrom } from './safe-fetch.js';
import { startWorker } from './worker.js';

const config = loadConfig();
await migrate(config.databaseUrl, fileURLToPath(new URL('../migrations', import.meta.url)));
const pool = createPool(config.databaseUrl);
// One vault for the API and the worker, made (and its warning logged) once.
let vault: Promise<Vault> | undefined;
const getVault = () => (vault ??= loadVault(pool, config, app.log));
const app = await buildApp(config, pool, { vault: getVault });
await ensureFirstAdmin(pool, config, app.log);
const stopWorker = startWorker(pool, getVault, policyFrom(config), app.log);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopWorker();
    void app.close().then(() => pool.end());
  });
}

await app.listen({ port: config.port, host: config.host });
