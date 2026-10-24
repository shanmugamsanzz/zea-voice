# UAT setup plan

Status: Planning only. UAT has not been implemented. This document does not change or deploy production.

Based on repository inspection on 23 October 2026. Running server configuration and GitHub environment settings have not been inspected.

## Intended release process

One repository, separate servers and data:

```text
feature branch -> develop -> uat -> main
                              |      |
                         UAT server  Production server
```

The team tests the revision deployed from `uat`. After approval, merge the tested changes into `main`. If conflict resolution or additional changes alter the tested code, test that result before production deployment. Keep both deployment workflows in all branches; branch triggers select the destination.

Proposed domains (confirm before provisioning):

| Environment | Frontend | Backend |
| --- | --- | --- |
| Production | voice.zeacrm.com | api.voice.zeacrm.com |
| UAT | uat.voice.zeacrm.com | api.uat.voice.zeacrm.com |

## Current repository setup

- `.github/workflows/deploy.yml` deploys only on pushes to `main`, after a backend verification job.
- Deployment connects through `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`, enters `/opt/zea-voice-app`, pulls `main`, builds Compose services and verifies the backend release SHA.
- Root `docker-compose.yml` contains backend, frontend and embedding services only. PostgreSQL, Redis and Qdrant are external dependencies.
- Compose requires the pre-existing external network `zea-voice-network`. It currently publishes no host ports.
- Frontend Docker build uses `VITE_API_BASE_URL=/api`; frontend Nginx proxies `/api/` to `backend:1112` and supports WebSocket upgrades.
- Backend configuration is supplied through server-side `Backend/.env`.
- CI uses Node 24; backend and frontend Docker builds use Node 22.
- README deployment ports and embedding model/dimensions do not match the current Compose/example configuration; update documentation during implementation.

## Code changes to prepare

### Remove environment-specific application defaults

| File | Current value | Planned change |
| --- | --- | --- |
| `Frontend/src/components/views/SuperAdminViews.tsx` | Production Plivo answer/hangup/recording URLs, in three initial values and three reset values (approximately lines 2560–2562 and 2639–2641) | Build defaults from the configured public backend URL. Use the same configuration source for initialization and reset. Do not substitute hardcoded UAT domains. |
| `Frontend/src/lib/api.ts` | Localhost API fallback | Define a consistent deployed API-base policy, preferably same-origin `/api`, while preserving local development configuration. |
| `Frontend/src/lib/publicPhoneCalls.ts` | Localhost API fallback | Apply the same API-base policy. |
| `Frontend/src/views/PublicBrowserAgentTestView.tsx` | Localhost API fallback | Apply the same policy to shared browser tests. |
| `Frontend/src/lib/browserAgentMedia.ts` | Server-side localhost fallback; browser fallback uses current origin | Review alongside the API-base policy; preserve correct WebSocket URLs. |
| `Backend/src/config/env.js` | Localhost CORS default | Require/check the appropriate deployed CORS configuration. Local development defaults need not be removed. |
| `Frontend/src/components/views/CompanyViews.tsx` | Example webhook default and static API-key-looking UI display near the integration settings | Review whether these controls are wired to persisted settings; replace misleading demo values with actual settings or clear empty states. Do not present a sample as a working key. |

Frontend cannot directly read backend environment variables. Choose an explicit mechanism for the public callback base, such as authenticated backend configuration or a frontend build variable wired through Docker. Check its effect on frontend rebuilds and keep credentials server-side.

Provider API endpoints (Plivo, OpenAI, Google, Cartesia, ElevenLabs, Backblaze), internal Docker service URLs, URL-parsing dummy bases and container health-check localhost addresses are not production-domain defects. Do not replace them with UAT domains.

### Deployment workflows

- Keep production deployment on `main`; add `deploy-uat.yml` for `uat`.
- Use separate GitHub environments named `production` and `uat`, with environment-scoped SSH secrets.
- Associate each deployment job with its intended environment. Migrate existing secrets carefully so production deployment keeps working.
- Deploy the exact revision that passed checks, rather than allowing a later branch head to be deployed by `git pull`.
- Serialize deployments for each environment. Keep release SHA checks, add frontend/HTTPS smoke checks, and define failure handling.
- Align CI and Docker Node versions after checking dependency compatibility.
- Protect `main` with review and required checks. Configure production deployment approval if desired by the team.

## UAT server and infrastructure

- Provision a separate server and install Docker/Compose.
- Size CPU, RAM and disk for the embedding model plus the database, Redis, Qdrant and expected test concurrency; validate with a representative load test before deciding capacity is sufficient.
- Create a UAT checkout of this repository and the `uat` branch.
- Provision persistent PostgreSQL, Redis and Qdrant services, either on the UAT server or dedicated UAT services.
- Create Docker networking and persistent volumes. On a separate server the existing container/network names can be reused. Sharing a Docker host requires distinct container names, networks, ports and volumes.
- Set up DNS, certificates and reverse proxy routes for both proposed UAT domains, including WebSocket upgrades and telephony callbacks.
- Choose either a proxy attached to the Docker network or explicit loopback port mappings for a host proxy. Current Compose has no published ports.
- Configure storage persistence/backups for database, vector data, uploads and recordings. Current application artifacts in the container must be reviewed for persistence requirements.

## UAT configuration and isolation

Use the same application code, with separate server configuration. Never commit real `.env` files.

| Configuration | UAT requirement |
| --- | --- |
| `NODE_ENV` | `production` for the deployed build |
| `PUBLIC_BASE_URL` | Proposed UAT backend HTTPS URL |
| `CORS_ORIGINS` | Approved UAT frontend origin(s) |
| `AUTH_COOKIE_SECURE` | `true` with HTTPS |
| `DATABASE_URL` | Separate UAT database and credentials |
| Redis host/auth/database | Separate UAT Redis instance preferred |
| `QUEUE_PREFIX` | Distinct value such as `zea-voice-uat` |
| Qdrant URL/key/collection prefix | Separate UAT instance preferred; no production collections |
| Credential encryption and media signing keys | Dedicated UAT values |
| Storage bucket and credentials | Dedicated UAT bucket/access |
| Embedding configuration | Match the model, dimensions and collection configuration used by the code; current example uses `intfloat/multilingual-e5-base`, 768 dimensions |
| Frontend API base | `/api` for current same-origin proxy design |

Create a test administrator, company and agents. Prefer synthetic data. Do not restore production credentials, queued tasks, callbacks or customer records into an active UAT environment without an explicit sanitization and isolation process.

Configure dedicated test telephony numbers/accounts where available. Review saved database configuration as well as code:

- Telephony answer, hangup and recording callbacks.
- Agent tool endpoints, transfers, pre-call and post-call webhooks.
- Campaign tasks, scheduled callbacks and outbound recipients.
- Storage, provider credentials and billing settings.

Enable outbound workers and real telephony testing only after test recipients and integrations are configured. Real provider calls can incur charges even from UAT.

## First deployment and acceptance

1. Back up production and record its current deployed SHA without modifying it.
2. Complete code/configuration changes and review them.
3. Provision isolated UAT infrastructure and server secrets.
4. Run migrations against the fresh UAT database and initialize the test administrator using the existing scripts.
5. Deploy the UAT revision and verify release SHA, readiness, frontend access, authentication, HTTPS and WebSockets.
6. Test browser calls, dedicated-number inbound/outbound calls, queue capacity, unanswered/busy outcomes, campaigns, tools, transfers, callbacks, reports, summaries and configured billing.
7. Verify tenant isolation and confirm UAT actions/data never reach production.
8. Record test results against the deployed commit. Fix/redeploy/retest as needed.
9. After approval, merge reviewed changes to `main`, back up the production database before migrations, deploy and smoke-test.

## Rollback preparation

- Keep the previous release SHA/tag and a usable image or rebuild procedure.
- Maintain tested database backup/restore procedures; code rollback alone does not undo migrations or data changes.
- Review migration compatibility before releasing. Avoid automatic destructive migration rollback.
- Recreating the backend can interrupt active calls. Plan deployment timing and verify shutdown/drain behavior; this plan does not promise zero-downtime deployment.

## Implementation checklist for later

- [ ] Confirm UAT domains, server capacity and infrastructure ownership.
- [ ] Create/confirm `develop` and `uat` branch process.
- [ ] Remove hardcoded production callback defaults through configuration.
- [ ] Review API fallbacks and demo integration controls.
- [ ] Prepare UAT infrastructure and persistent storage.
- [ ] Configure DNS, HTTPS and reverse proxy.
- [ ] Create isolated UAT credentials, database, queues, vectors and storage.
- [ ] Create GitHub environments and branch-specific deployment workflows.
- [ ] Deploy exact checked revisions and serialize deployments.
- [ ] Align Node versions and update deployment documentation.
- [ ] Initialize UAT, migrate and complete acceptance testing.
- [ ] Document production release and rollback procedures.

No implementation items above are marked complete by creating this document.
