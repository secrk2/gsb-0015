// 全局配置：全部支持环境变量覆盖，默认值为 docker-compose 开发环境
export const config = {
  port: Number(process.env.PORT || 7102),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'aytdb123',
    database: process.env.DB_NAME || 'anyuntong',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    db: Number(process.env.REDIS_DB || 0),
  },
  jwtSecret: process.env.JWT_SECRET || 'ayt-dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  seedDemo: String(process.env.SEED_DEMO || 'true') === 'true',
};
