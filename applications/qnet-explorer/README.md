# QNet explorer

Block explorer for QNet: a Next.js frontend plus an indexer process that ingests blocks and
transactions from the nodes' RPC into PostgreSQL.

Full documentation: [docs/applications/explorer.md](../../docs/applications/explorer.md)

## Run locally

```bash
cd frontend
npm install
npm run dev                                     # web tier
npm run build:indexer && npm run start:indexer  # indexer, the only database writer
```

Configuration is supplied through environment variables (node RPC URL, database connection,
API keys). Never commit those values; see the documentation for the variable names.

## Licence

Apache-2.0 (see [LICENSE](LICENSE)). The blockchain node software in the rest of the
repository is licensed separately — see the root [LICENSE](../../LICENSE).
