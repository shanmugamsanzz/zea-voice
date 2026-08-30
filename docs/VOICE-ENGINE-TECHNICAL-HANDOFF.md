# Zea Voice Engine — Technical Handoff

## 1. Purpose

Zea Voice is a multi-tenant, real-time voice-agent platform. A company can create agents, connect telephony and AI providers, publish tenant-owned knowledge, configure tools and memory, test the exact live agent from a browser, and review transcripts and post-call reports.

The runtime is a template engine. Company names, products, prices, aliases, workflows, spoken scripts and business rules belong to tenant configuration and published documents; they must not be embedded in runtime source code.

This document describes the current production architecture and the invariants an engineer must preserve.

## 2. Current architecture

```text
Telephony caller (Plivo) or Browser Test microphone
                         ↓
Authenticated real-time media WebSocket
                         ↓
RealtimeConversationOrchestrator
                         ↓
Configured streaming STT → finalized utterance
                         ↓
Question + canonical call memory + tenant publication scope
                         ↓
Structured + BM25 + Qdrant retrieval in parallel
                         ↓
Namespace-aware ranking + canonical reservations + RRF → maximum 5
                         ↓
Single PostgreSQL hydration and publication/provenance verification
                         ↓
Compact grounded prompt + one structured LLM decision
                         ↓
RESPONSE | CLARIFY | TOOL
                         ↓
Evidence, claims, numbers, workflow and tool validation
                         ↓
Configured streaming TTS → paced audio playback
                         ↓
Caller hears answer; canonical memory and transcript are updated
                         ↓
Recording, reporting, AI summary and configured post-call webhook
```

Telephony calls and Browser Test sessions converge on the same `RealtimeConversationOrchestrator`. Browser Test is a transport adapter, not a separate conversation or knowledge engine.

## 3. Technology stack

| Area | Current implementation |
|---|---|
| Frontend | React 19, TypeScript, Vite, TanStack Query, Tailwind CSS, Nginx |
| Backend | Node.js 22+, JavaScript ES modules, Express, native HTTP/WebSocket integration |
| Primary database | PostgreSQL with migrations, tenant/workspace scope and row-level security |
| Runtime cache and queues | Redis and BullMQ |
| Vector search | Qdrant, tenant-scoped collections and metadata filters |
| Embeddings | Hugging Face Text Embeddings Inference, `intfloat/multilingual-e5-small`, 384 dimensions |
| Object storage | Backblaze B2 through its S3-compatible API |
| Telephony | Plivo REST, signed webhooks and bidirectional media WebSocket |
| STT adapters | Sarvam, Deepgram and Azure implementations; the agent selects an active configured model |
| LLM adapters | OpenAI-compatible, Gemini and Anthropic implementations; the agent selects an active configured model |
| TTS adapters | Cartesia, Sarvam, ElevenLabs and Azure implementations; the agent selects an active configured model |
| Deployment | Docker Compose, external `zea-voice-network`, reverse proxy in front of frontend and backend |
| Observability | Structured logs, call events, provider usage, turn latency, transcript sources and health endpoints |

Provider credentials and model assignments are stored as configuration. Secrets are encrypted and are never returned by normal APIs.

## 4. Live call lifecycle

### 4.1 Call creation and media authentication

For telephony, Plivo calls the answer webhook. The backend validates the Plivo signature, resolves the phone number and tenant-owned agent, creates the call session, runs any configured pre-call integration, and returns Plivo XML containing a short-lived signed media WebSocket URL.

For Browser Test, an authenticated user creates a test session for a selected agent. The API validates `tenantId + workspaceId + agentId + testCallId`, enforces per-tenant concurrency, creates a `browser_test` call session, and issues a short-lived signed WebSocket token.

Both media transports attach the same orchestrator.

### 4.2 Audio and STT

The transport normalizes incoming audio for the configured streaming STT adapter. Partial transcripts support interruption detection, but only a finalized transcript starts a normal knowledge/LLM turn. A provider speech-end event is preferred; a bounded silence finalizer exists when the provider does not emit one.

### 4.3 Turn ownership and interruption

Every turn has an epoch/token. A newer finalized caller utterance cancels obsolete retrieval, LLM and audio work from the prior epoch. Barge-in clears stale queued audio. Valid completed context is retained; obsolete generated speech is not added to memory.

Emergency and explicit hang-up handling are deterministic exceptions. Other finalized normal turns use the unified grounded LLM path.

## 5. Knowledge ownership and publication

Each agent receives a Master Prompt and assignments to published Knowledge Bases. The Master Prompt owns role, tone, language policy and behavioural boundaries. Facts and actions belong to the five document types below.

| Document type | Authoritative responsibility | PostgreSQL representation |
|---|---|---|
| Product / Service Catalog | Categories, canonical items, aliases, hierarchy, prices, attributes, relationships and selection rules | Structured catalogs, items and attributes |
| Workflow and Action Rules | Safety, stage transitions, action authorization, success/failure behaviour and configured responses | Workflow rules |
| Conversation Guidance | Approved overview messages, response order, stages and next questions | Conversation flows/nodes |
| FAQ | Approved common questions, aliases and short answers | FAQ entries |
| General Knowledge | Stable tenant facts and policies | Knowledge chunks |

### Publication pipeline

```text
Upload text/PDF or enter UI text
        ↓
Extract and normalize document text
        ↓
Parse according to the selected document contract
        ↓
Validate schema and cross-document Catalog references
        ↓
Create immutable publication revision
        ↓
Write authoritative structured records to PostgreSQL
        ↓
Generate canonical aliases, multilingual/STT and phonetic forms from tenant data
        ↓
Build Redis publication manifest/evidence/BM25 artifacts
        ↓
Embed semantic records and upsert tenant-scoped Qdrant points
        ↓
Mark revision ready and assign it to agents
```

Publication must detect duplicate canonical keys, ambiguous aliases, unresolved Catalog references, wrong record types and inconsistent cross-document names. Runtime must use only active, ready, assigned revisions.

The detailed tenant authoring formats are in [ui-document-contracts.md](knowledge-base/ui-document-contracts.md).

## 6. Retrieval and grounding

### 6.1 Query understanding

The latest complete utterance is interpreted with relevant canonical memory to identify:

- Explicit entities or categories
- Contextual references such as “this”, “that” or “its price”
- Requested fact
- Comparison entities
- Need/problem and requested outcome
- Action intent
- Genuine ambiguity

Query classification and entity resolution provide retrieval hints. They do not directly answer normal turns or execute tools.

### 6.2 Parallel hybrid search

Catalog, FAQ, Conversation, Workflow and General Knowledge are searched as independent namespaces. Structured matching, Redis-backed BM25 and Qdrant semantic search run concurrently with the same tenant, agent, Knowledge Base, revision, direction and namespace scope.

The search layer returns canonical candidate identities. It does not return unverified facts directly to the caller.

### 6.3 Priority and RRF

The latest request has priority:

1. Explicit current entities/categories
2. All explicitly requested comparison entities
3. Published overview records for an overview request
4. Remembered canonical entity only for a genuinely contextual follow-up
5. Relevant semantic or lexical fallback candidates

A new explicit topic replaces stale memory. Required records are reserved before Reciprocal Rank Fusion and cannot be removed by generic guidance. The final candidate set is capped at five.

### 6.4 PostgreSQL hydration and provenance

Candidate IDs are hydrated together from PostgreSQL. Hydration verifies:

- Tenant and agent assignment
- Knowledge Base and publication revision
- Current publication/document state
- Record type and canonical record identity
- Provenance needed for citations and validation

Qdrant, BM25 and Redis help discover records; PostgreSQL is the final authority for facts.

The deterministic reference chain is:

```text
LLM source ID
  → published evidence ID
  → authoritative record ID
  → verified PostgreSQL record
```

If a known required record cannot be hydrated or disappears before prompt construction, the system reports an operational grounding failure and schedules artifact recovery. It must not turn that failure into caller ambiguity.

## 7. Grounded LLM contract

One normal turn sends one compact grounded request containing only:

- Current finalized question
- Relevant configured caller/agent turn pairs
- Canonical call memory
- Requested fact and detected need
- Ambiguity candidates when applicable
- Maximum five verified PostgreSQL records
- Applicable Workflow authorization
- Agent-assigned tool schemas

The voice prompt has its own configured character/token budget. Mandatory evidence and the response contract are protected first; optional history and metadata are reduced before required records.

The LLM must return strict structured output with one decision:

| Decision | Meaning |
|---|---|
| `RESPONSE` | Published evidence supports caller-facing speech, or the exact configured information-unavailable response is used for clear zero-evidence questions |
| `CLARIFY` | The entity, requested fact or meaning is genuinely ambiguous; the question must be short, audible and candidate-specific when candidates exist |
| `TOOL` | A published Workflow authorizes the requested action and an assigned tool schema permits the arguments |

Zero evidence does not skip the LLM. The current question and relevant memory still go to the grounded decision. Unsupported factual answers remain forbidden.

## 8. Validation and tools

The post-LLM validator uses the same hydrated PostgreSQL records supplied to the model. It checks selected evidence, source IDs, canonical entities, claims, numbers, citations, comparison completeness, recommendation support and safety constraints.

For tools, both conditions are mandatory:

1. A current published Workflow rule authorizes the action.
2. An active tool assigned to the agent validates the arguments against its configured schema.

Webhook tools use encrypted secret headers, bounded timeouts and response-size limits. The agent may claim success only after a verified successful result. Failures preserve useful collected data and return configured failure speech.

## 9. Memory model

Canonical memory is isolated by tenant, workspace, agent and call/context identity. It can contain the active canonical record, category, comparison records, pending clarification, requested facts, relevant turn pairs, collected information and active tool state.

UI cache policies:

| Policy | Behaviour |
|---|---|
| `disabled` | No Redis context read/write; current in-process call state still supports the active conversation |
| `session_only` | Tenant-isolated session cache, deleted at call end; no cross-call continuation |
| `persistent_24h` | Tenant-isolated context may continue across calls for the configured TTL/context identity |

Conversation context modes:

- `last_n_turns`: retain the configured number of complete caller/agent pairs, up to the runtime limit.
- `full_current_call`: retain the current-call history while selecting only relevant context that fits the LLM prompt budget.

Important Information Fields are UI-defined and schema-validated. Current-call fields work independently of cross-call persistence. Fields cannot authorize tools; `requiredAction` ties collection to an already authorized action.

## 10. Latency and audio lifecycle

The production voice path separates these deadlines:

- STT finalization
- Routing
- Retrieval
- PostgreSQL hydration
- Initial first-audio target
- LLM completion after acknowledgement
- Final TTS first audio
- Tool execution

When processing exceeds the configured first-audio threshold, the agent may speak the tenant-configured latency acknowledgement. That acknowledgement completes the original first-audio obligation but does not end or cancel the grounded turn. The validated final answer receives its own TTS first-audio timeout.

Inactivity prompts are disabled while STT finalization, retrieval, hydration, LLM generation, validation, tool execution or TTS playback is active. The inactivity timer starts only after final playback completes.

Audio output is sentence-grouped, paced and monitored for buffer pressure and underruns. TTS lookahead may synthesize later sentence groups concurrently, while epoch checks prevent stale audio from reaching the caller.

## 11. Operational failure policy

Retrieval time warnings are observability signals, not automatic failures. Genuine failures are separated from ambiguity:

| Condition | Caller behaviour |
|---|---|
| Genuine unclear entity/fact | Targeted `CLARIFY` question |
| Clear question with no published answer | Tenant-configured information-unavailable response or authorized support tool |
| Retrieval/hydration/provenance failure | Tenant-configured technical response and artifact recovery |
| LLM timeout, malformed JSON or truncation | Tenant-configured technical response |
| Validation failure | Tenant-configured technical response; never an inactivity prompt |
| TTS/provider failure | Bounded retry/recovery, then configured technical response when speakable |

The engine must never silently return to listening after a finalized turn.

## 12. Browser Test transport

Each Agent List card can create an isolated Browser Test session. The browser requests microphone access, streams audio through an authenticated WebSocket and receives the same TTS stream as a telephony call.

Browser Test uses:

- The selected agent’s real provider configuration and Master Prompt
- Assigned active Knowledge Base revisions
- The same retrieval, memory, LLM, tools, validation and TTS runtime
- The same transcript, source, latency, recording and report pipeline

Reports identify the transport/source as `browser_test`. Session end and unexpected disconnects finalize the call and release concurrency safely.

## 13. Persistence, reporting and integrations

PostgreSQL persists call sessions, ordered transcript entries, transcript evidence sources, provider usage, call events, tool execution results, recordings metadata, AI summaries and webhook delivery state.

At call completion:

1. The runtime finalizes transcript, state, usage and outcome.
2. Recording processing stores the final asset through configured storage.
3. The post-call summary job is queued.
4. The summary worker generates configured structured summary fields.
5. A configured post-call webhook receives the permitted transcript/summary payload with idempotency protection.

Call reconciliation repairs calls that missed a terminal provider signal. Post-call work is designed to finalize even after a media disconnect.

## 14. Multi-tenant security invariants

- Every runtime query is scoped by tenant and workspace; knowledge adds agent, Knowledge Base and revision scope.
- PostgreSQL row-level security protects tenant data.
- Browser and Plivo media URLs use short-lived signed tokens.
- Provider and tool secrets are encrypted at rest and redacted from API responses.
- Qdrant collection names are derived from validated tenant IDs; callers cannot supply arbitrary collection names.
- Redis keys include tenant/workspace/agent/context isolation.
- Cross-tenant evidence, memory, tools and reports must always be rejected.
- Webhooks require validation, bounded timeouts and idempotency controls.

## 15. Deployment topology

The root Compose file runs:

- `zea-voice-backend`
- `zea-voice-frontend`
- `zea-voice-embedding`

They communicate over the external `zea-voice-network`. PostgreSQL, Redis and Qdrant are configured through backend environment variables and may run as external services/containers on that network. The embedding model cache uses a named Docker volume.

Nginx serves the React application and proxies `/api/` to `backend:1112`, including WebSocket upgrade headers. The public reverse proxy must separately route the public API/Plivo webhook domain to the backend.

Important production configuration groups are documented by `Backend/.env.example`:

- Database, Redis and queue settings
- Authentication and credential encryption
- Public URL, Plivo and signed-media settings
- B2 and Qdrant credentials
- Embedding and RAG settings
- Routing, retrieval, hydration, LLM and TTS deadlines
- Prompt/output budgets
- Browser Test limits
- Worker and reconciliation settings

Never share `Backend/.env`, `Frontend/.env`, production database URLs, API keys, signing secrets or encryption keys. Share `.env.example` only.

## 16. Health and observability

Important health routes include:

```text
GET /health
GET /health/database
GET /health/redis
GET /health/workers
GET /health/qdrant
```

Structured logs carry call, tenant, workspace, agent, transport and stage context. Important voice stages include conversation state changes, STT events, retrieval/hydration timing, grounded LLM completion, acknowledgement, TTS playback, interruption cancellation, tool execution, call completion and post-call processing.

The main call report exposes measured turns, tool executions, first-audio latency, retrieval latency, transcript, evidence sources, summary and webhook delivery.

## 17. Production verification commands

Run from `Backend`:

```bash
npm run check
npm run verify:grounded-voice-e2e
npm run verify:universal-engine-acceptance
npm run verify:universal-hardcoding-gate
npm run verify:browser-test-transport
npm run verify:production-latency-contract
npm run verify:operational-audio-lifecycle
```

The grounded voice E2E gate runs identity, location, overview, direct entity, phonetic, contextual and zero-evidence scenarios across multiple synthetic tenants and languages. It requires non-empty evidence for known answers, correct `RESPONSE/CLARIFY/TOOL`, final audio after acknowledgement, no processing-time inactivity prompt and zero silent turns.

## 18. Important source map

| Responsibility | Primary files |
|---|---|
| Server/bootstrap | `Backend/src/server.js`, `Backend/src/app.js` |
| Plivo media | `Backend/src/voice/plivo-answer.service.js`, `Backend/src/voice/plivo-media.socket.js` |
| Browser Test | `Backend/src/voice/browser-test-session.service.js`, `Backend/src/voice/browser-test-media.socket.js` |
| Conversation orchestration | `Backend/src/voice/realtime-conversation-orchestrator.js` |
| Provider registry | `Backend/src/voice/providers/registry.js`, `Backend/src/voice/providers/defaults.js` |
| Normal-turn contract | `Backend/src/knowledge-bases/normal-turn-contract.js` |
| Query/entity understanding | `Backend/src/knowledge-engine/contextual-query-understanding.js`, `entity-route-resolver.js`, `query-classifier.js` |
| Parallel retrieval | `Backend/src/knowledge-bases/parallel-hybrid-search.js`, `Backend/src/knowledge-engine/targeted-retrieval.js` |
| RRF/reservations/hydration | `Backend/src/knowledge-engine/canonical-retrieval-reservations.js`, `authoritative-evidence.js` |
| Grounded evidence | `Backend/src/knowledge-bases/grounded-turn-evidence.js`, `Backend/src/knowledge-engine/grounded-evidence-representation.js` |
| LLM prompt and contract | `Backend/src/voice/interaction/grounded-llm-response.js`, `grounded-llm-decision.js` |
| Unified validation/state update | `Backend/src/voice/interaction/unified-grounded-turn.js`, `grounded-claim-validator.js`, `grounded-decision-security.js` |
| Memory | `Backend/src/voice/interaction/generic-conversation-state.js`, `context-cache-policy.js`, `conversation-memory-state.js` |
| Tools | `Backend/src/voice/tools/tool-executor.service.js`, `Backend/src/knowledge-bases/verified-tool-result.js` |
| Knowledge ingestion/publication | `Backend/src/knowledge-bases/knowledge-processing.service.js`, `knowledge-processing.worker.js`, `Backend/src/knowledge-engine/publication-index-builder.js` |
| Post-call pipeline | `Backend/src/voice/call-completion.service.js`, `Backend/src/voice/postcall-summary/` |
| Environment contract | `Backend/src/config/env.js`, `Backend/.env.example` |
| Tenant document formats | `docs/knowledge-base/ui-document-contracts.md` |

## 19. Architectural invariants for reviewers

An external engineer should treat these as non-negotiable acceptance criteria:

1. Telephony and Browser Test use one engine, not parallel implementations.
2. Every finalized normal turn reaches one grounded LLM decision, including zero-evidence turns.
3. Retrieval engines discover candidates; verified PostgreSQL records authorize facts.
4. Explicit latest-request entities outrank stale memory and unrelated guidance.
5. No more than five verified records enter the voice LLM prompt.
6. The validator uses the same records the LLM received.
7. Tools require both Workflow authorization and an assigned schema.
8. Engine failures never become false clarification or inactivity speech.
9. Acknowledgement audio never cancels the final answer.
10. Tenant data, credentials, evidence, memory and reports never cross tenant boundaries.
11. Runtime source contains no tenant-specific business vocabulary.
12. Every finalized turn produces audible speech or a verified tool continuation; silent turns are failures.

## 20. Recommended expert review order

1. Run the verification commands in section 17.
2. Review one Browser Test call and one Plivo call with the same agent and questions.
3. Trace one known answer from retrieval candidate through PostgreSQL hydration, `source_1`, LLM selection, validator and transcript citation.
4. Trace one contextual follow-up and one explicit topic switch through canonical memory.
5. Trace one zero-evidence question, one genuine ambiguity and one operational provider failure.
6. Verify interruption during acknowledgement and during final TTS.
7. Verify a tool succeeds only with published Workflow authorization.
8. Attempt cross-tenant session, evidence, memory and report access and confirm rejection.
9. Review p50/p95 retrieval, LLM completion, TTS first-audio and end-to-end first-audio metrics from production logs.
10. Confirm deployed environment values follow `Backend/.env.example` without exposing secrets.
