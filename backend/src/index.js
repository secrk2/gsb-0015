import { config } from './config.js';
import { app } from './app.js';
import { pool, waitForDb } from './db.js';
import { redis } from './redis.js';
import { seedIfEmpty } from './seed.js';

async function main() {
  await waitForDb();
  try {
    await redis.connect();
  } catch (err) {
    console.warn('[redis] 首次连接失败，将以无缓存模式运行:', err.message);
  }
  if (config.seedDemo) {
    await seedIfEmpty(pool);
  }
  app.listen(config.port, () => {
    console.log(`安运通后端已启动: http://0.0.0.0:${config.port}/api`);
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
