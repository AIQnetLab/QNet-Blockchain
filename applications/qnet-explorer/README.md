# QNet explorer

Block explorer for QNet: a Next.js frontend plus a sync service that ingests blocks and
transactions from a node's RPC into PostgreSQL.

Full documentation: [docs/applications/explorer.md](../../docs/applications/explorer.md)

## Run locally

```bash
cd frontend
npm install
npm run dev
```

Configuration is supplied through environment variables (node RPC URL, database connection,
API keys). Never commit those values; see the documentation for the variable names.

## Licence

Apache-2.0 (see [LICENSE](LICENSE)). The blockchain node software in the rest of the
repository is licensed separately — see the root [LICENSE](../../LICENSE).
