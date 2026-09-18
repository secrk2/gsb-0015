import Redis from 'ioredis';
import { config } from './config.js';

// Redis 仅作缓存（作战台聚合、幂等键快取）；不可用时自动降级，不影响主流程
export const redis = new Redis({
  ...config.redis,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 500, 3000),
});

redis.on('error', (err) => {
  console.warn('[redis] 连接异常（降级为无缓存模式）:', err.message);
});

export async function cacheGet(key) {
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value, ttlSec = 15) {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  } catch { /* 降级忽略 */ }
}

/** 按前缀失效（演示规模 keys 数量极小，KEYS 可接受） */
export async function cacheDelPrefix(prefix) {
  try {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(keys);
  } catch { /* 降级忽略 */ }
}
