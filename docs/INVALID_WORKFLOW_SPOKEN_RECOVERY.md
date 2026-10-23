# Invalid workflow response recovery

The observed non-workflow outcome with a non-null action is rejected before execution. If workflow speech is held, the universal turn can make one speech-only correction using the existing retrieved context and current question. The rejected speech is discarded. The correction is not allowed to execute, collect or cancel workflow actions; it can answer a factual question or tell the caller that no action completed. A second failure enters configured technical recovery. No tool is retried and no retrieval is repeated. Valid turns retain one universal generation; regular tool turns retain their existing result-generation call. The existing two-call cap is retained and timing assertions account for the single correction.

Other action validation failures now produce configured technical-failure speech instead of returning silently. Tool authorization remains unchanged. Cancellation/stale-turn handling still takes priority; no recovery should play after interruption/end. Configured static recovery wording is not automatically translated.

Checks: verify-invalid-workflow-recovery.js, verify-response-language.js, production runtime, universal answer and safety checks, existing runtime/RAG release regression suite. Live provider staging validation is still required.
