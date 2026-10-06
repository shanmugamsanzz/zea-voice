# Secure calling share links

Super Admin and Company Developers with an interactive session can create 24-hour
or permanent links from the agent Call dialog. Company Users and API keys cannot
manage links. Creation requires an active outbound-capable agent and the company
queue feature enabled. A permanent link has no time expiry and can be revoked.

Apply `1791290000000_phone-test-share-links.js` before running the new backend.
The previous phone-test queue migration is also required. Raw 256-bit link tokens
are returned only at creation; the database stores SHA-256 hashes. Link listings
never return tokens. Copy the new link immediately. Create a replacement if it is
lost; revoke the old link rather than trying to recover its token.

Share URLs use `/shared/phone-call#token=<secret>`. The fragment keeps the secret
out of HTTP URLs and server access logs. The visitor page opens without login or the
company dashboard and shows only the agent name, phone form and request status.
Deploy both the frontend and backend before distributing links. A link grants calling access only to its selected
agent. The public API returns no prompts, credentials, balance or company identifiers.

The creator must remain active with Super Admin or Developer rights in that company
workspace. Every public request validates expiry, revocation and active agent/company/
workspace. Submission revalidates within the queue transaction; queued dialing
validates again. Revoking a link cancels its waiting requests. Calls already committed
to dispatch or initiated retain their lifecycle and are not forcibly disconnected.

## API contract for the shared page

Use `X-Phone-Test-Share-Token` with the fragment token on every public request.
Do not put it in a URL or browser persistent storage. Public responses use `no-store`.

| Endpoint | Purpose |
| --- | --- |
| `GET /public/phone-test-links` | Minimal agent name and expiry information |
| `POST /public/phone-test-links/calls` | Queue/dial a call for the link's agent |
| `GET /public/phone-test-links/calls/:requestId` | Read only this request's status |

POST accepts only `phone`, a client-generated UUID `requestId`, `consent: true`,
and an optional empty `website` honeypot. Consent should confirm the visitor wants
the call at their own number. Reuse the client UUID when retrying the same request.
Send it as `X-Phone-Test-Request-Key` when polling the server-returned request ID.
The status endpoint binds both IDs to the link and company and returns no phone data.

Authorized management endpoints under `/agents/:agentId/phone-test-share-links`
support POST (`expiresIn: "24h"` or `"permanent"`), GET, and DELETE `/:linkId`.
All require the normal authenticated tenant/workspace context and role checks.

## Abuse protection

Redis checks quotas atomically and fails closed when coordination is unavailable:

| Scope | Default limit |
| --- | --- |
| Metadata/status/API requests per source IP | 1,000 per minute |
| Call submissions per source IP | 60 per hour |
| Call submissions per link | 10 per minute and 100 per day |
| Call submissions per company across links | 200 per day |
| Call submissions to the same number across links/companies | 3 per hour |

IP identity uses Express's existing trusted connection address. Forwarded IP headers
are not trusted automatically; visitors behind the current reverse proxy may share
the source-IP quota. Do not broadly enable proxy trust on a publicly reachable backend.
IPs and recipient numbers are hashed in rate-limit keys. Quotas count submission
attempts (including repeats), so retry after the provided delay when rate limited.

Public destination country dialing codes default to India (`91`). Configure
`PHONE_TEST_SHARE_ALLOWED_DIAL_CODES=91` with comma-separated country dialing codes
to allow other destinations. This restriction affects public links only. Existing
private calls keep their behavior. Shared calls also respect the company's combined
outbound queue limit, live concurrency, agent configuration and credits.

These limits reduce abuse; the bearer link and consent are not phone ownership
verification. Distribute links to intended recipients. Unrestricted public advertising
may need OTP verification or a challenge service before broader rollout.

Run `npm run verify:phone-test-share-links` and
`npm run verify:agent-phone-test-queue` from Backend. Tests cover hashed tokens,
roles, company scope, expiry, revocation, lost creator permissions, status receipts,
destination/consent checks, quota failure behavior and queued link invalidation.
Staging Redis/database/provider verification remains required before production use.

## Visitor page verification

Run `npm run test:public-phone-calls`, `npm run lint`, and `npm run build` from
Frontend, and `npm run verify:call-queue-release` from Backend. The public client
omits login cookies, never refreshes an authenticated session, and keeps the token
in memory. Visitors consent to a call at their own number. Saved requests show
queued, preparing, dialing, failed or canceled status; waiting requests are dialed
by the existing company queue worker when capacity becomes available.

After an uncertain submission response, a manual retry reuses the same request
receipt to avoid duplicate calls. Status reads require both the saved request ID
and that receipt. Expired or revoked links show an unavailable page. Closing the
page does not cancel a saved request, and requesting another call leaves the
previous request in its normal queue lifecycle.

Local automated checks use controlled provider/capacity/database fixtures. Before
production rollout, apply both migrations and run the documented Redis release
gate and staging tests with real provider callbacks. Verify a shared link with a
full company limit, release a slot, and confirm exactly one waiting call dials;
also verify revocation and company isolation on the deployed services.
