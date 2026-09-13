# Voice Engine Live Acceptance

Deploy the backend under test, configure the agent with `shanmuga-universal-agent-prompt.txt`, and upload `shanmuga-universal-knowledge.txt` through the agent document UI. Use a second agent with an unrelated prompt and document to verify isolation without code changes.

## Required calls

Record at least 20 normal turns after deployment. Include all of these scenarios:

1. Greeting followed by a short positive acknowledgement: continue the offered topic once; do not restart later.
2. Identity and call-purpose question: answer from configured identity.
3. Overview request: summarize only documented categories.
4. Exact item request: answer that item, not an overview or previous item.
5. Phonetic or STT-distorted item name: clarify using conversation context; do not invent an entity.
6. Short contextual reference after one clear subject: retain the subject.
7. Ambiguous contextual reference after multiple subjects: ask one focused clarification.
8. Caller correction: replace the earlier value or subject.
9. Missing documented fact: give a natural unavailable-information response.
10. Unsupported factual name after a previous incorrect assistant statement: do not reuse it as verified fact.
11. Comparison: cover every requested item using supporting chunks.
12. Question about appointment hours: do not start booking or substitute service hours.
13. Explicit booking request: start the configured workflow and ask one missing field.
14. Booking field answer: retain it without resetting the workflow.
15. Side question during booking: answer it, retain fields, and resume naturally.
16. Field correction after summary: update it and require a new confirmation.
17. Confirmation interrupted before completion: do not execute; present confirmation again.
18. Ambiguous or unfinished caller speech: do not execute a tool or close the call.
19. Explicit workflow cancellation: cancel the workflow without inventing success.
20. Explicit closing after a complete turn: close only after the configured response.
21. Caller interruption during a long answer: stop old audio and answer the new request.
22. Second-agent request: return only that agent's document evidence and configured identity.

## Required evidence

Export JSON-lines backend logs covering all test calls and run:

```text
npm run verify:qdrant-architecture-live -- <json-lines-server-log>
```

Approval requires at least 20 normal samples, average actual-answer first audio below 3000 ms, every normal response at or below 4000 ms, one query embedding, one tenant-and-agent-filtered Qdrant search, maximum one LLM call, no ordinary static recovery, and manual review confirming that the response meaning is correct.

The script intentionally cannot approve semantic correctness automatically. A reviewer must check the transcript against the configured prompt and retrieved document text.
