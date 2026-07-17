# Zea Voice

## Production containers

The root Compose file starts:

- Backend API on host port `1112`.
- Frontend UI on host port `5020`.
- Authenticated CPU embedding service on loopback port `8080`.
- PostgreSQL and Redis remain external and are read from `Backend/.env`.

```powershell
docker compose up -d --build
docker compose ps
```

The first embedding start downloads `intfloat/multilingual-e5-small` into the
named `zea-voice-embedding-model-cache` volume. The backend verifies the model
returns exactly 384 dimensions before it becomes ready. Run the repeatable
latency benchmark from `Backend` with:

```powershell
npm run benchmark:embedding
```

The embedding port is bound only to `127.0.0.1`; containers use the private
`zea-voice-network`. Qdrant collection names are generated from validated tenant
UUIDs and are never accepted directly from an API caller.

Configure the server reverse proxy as follows:

- `https://api.voice.zeacrm.com` -> `http://127.0.0.1:1112`
- The frontend domain -> `http://127.0.0.1:5020`
- `https://voice.zeacrm.com/webhook` must continue routing to the voice runtime
  that returns Plivo XML; it is not a frontend route.

`Backend/.env` is intentionally excluded from Git because it contains database,
Redis, storage, and encryption credentials. Copy or recreate that file on the
server before starting Compose. Never remove the production `.env` without
backing it up first.
