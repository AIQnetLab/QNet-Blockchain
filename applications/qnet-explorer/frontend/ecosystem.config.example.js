// PM2 layout for the explorer host. Copy to ecosystem.config.js and fill the secrets.
// qnet-indexer is the only database writer; qnet-explorer (Next.js) reads through a read-only role.
module.exports = {
  apps: [
    {
      name: 'qnet-explorer',
      script: 'npm',
      args: 'run start',
      cwd: '/root/QNet-Blockchain/applications/qnet-explorer/frontend',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        DATABASE_URL: 'postgresql://explorer_reader:<password>@localhost:15432/qnet_explorer',
        QNET_API_URL: 'http://162.244.25.114:8001',
        QNET_API_KEY: '<explorer api key>',
        DB_SSL: 'false',
        // Behind nginx: per-IP limits key on X-Forwarded-For (also set in .env.local on the host).
        RATE_LIMIT_TRUSTED_PROXY: '1',
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
    {
      name: 'qnet-indexer',
      script: 'dist-indexer/main.js',
      cwd: '/root/QNet-Blockchain/applications/qnet-explorer/frontend',
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://qnet_user:<password>@localhost:15432/qnet_explorer',
        QNET_API_URLS: 'http://162.244.25.114:8001,http://161.97.86.81:8001,http://154.38.160.39:8001,http://62.171.157.44:8001,http://5.189.130.160:8001',
        QNET_API_KEY: '<explorer api key>',
        INDEXER_LOG_LEVEL: 'info',
        DB_SSL: 'false',
      },
      time: true,
      restart_delay: 3000,
      max_memory_restart: '700M',
      kill_timeout: 15000,
    },
  ],
};
