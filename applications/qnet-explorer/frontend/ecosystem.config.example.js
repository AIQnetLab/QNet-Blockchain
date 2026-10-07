// PM2 layout for the explorer host. Copy to ecosystem.config.js and fill the secrets.
// qnet-indexer is the only database writer; qnet-explorer (Next.js) reads through a read-only role.
// Both run under the unprivileged user that owns the checkout (deployment/deploy-aiqnet.sh creates
// 'aiqnet'; start pm2 with `sudo -u aiqnet -H pm2 start ecosystem.config.js`), never as root. Secrets such
// as FAUCET_PRIVATE_KEY and CABINET_READ_KEY (32 random bytes in hex, which the deploy script makes once) live in
// .env.local, mode 600, owned by that user, and so does FAUCET_PASS_KEY (32 random bytes in hex, made once with
// `openssl rand -hex 32`): the key of the faucet passes the node cabinet gives, so they outlive a restart; unset, a key
// of the process (src/server/faucet-pass.ts). `npm run start` binds the site to
// 127.0.0.1:3000, so only nginx on this host reaches it.
module.exports = {
  apps: [
    {
      name: 'qnet-explorer',
      script: 'npm',
      args: 'run start',
      cwd: '/var/www/qnet/applications/qnet-explorer/frontend',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        DATABASE_URL: 'postgresql://explorer_reader:<password>@localhost:15432/qnet_explorer',
        QNET_API_URL: 'http://162.244.25.114:8001',
        QNET_API_KEY: '<explorer api key>',
        DB_SSL: 'false',
        // '1' lets the node cabinet send QNet Wallet its link and claim requests; off until app builds that
        // answer them are installed (src/server/phone-flows.ts).
        CABINET_PHONE_FLOWS: '0',
        // The https address of QNet Wallet's Android file, the Play-signed build, that /wallet offers; empty offers
        // none (src/server/wallet-apk.ts).
        WALLET_APK_URL: '',
        // Per-IP limits key on X-Real-IP, which nginx on this host sets ($remote_addr); nothing to set here.
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
    {
      name: 'qnet-indexer',
      script: 'dist-indexer/main.js',
      cwd: '/var/www/qnet/applications/qnet-explorer/frontend',
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
