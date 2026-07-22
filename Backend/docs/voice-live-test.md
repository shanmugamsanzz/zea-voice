# Real voice call acceptance test

Run this only against the deployed environment after its database migrations and Redis health checks pass.

1. Create and activate an inbound/outbound agent with assigned phone number, published knowledge, and supported STT, LLM and TTS models.
2. Place one real inbound call. Ask one knowledge question, allow the complete answer to play, then end naturally.
3. Trigger one real outbound campaign call to a consenting test number. Answer it, speak one turn, and end naturally.
4. Copy the two `call_sessions.id` values from Call Logs—not the Plivo Call UUID.
5. Run:

   ```powershell
   $env:VOICE_TEST_INBOUND_CALL_ID='<inbound-call-session-uuid>'
   $env:VOICE_TEST_OUTBOUND_CALL_ID='<outbound-call-session-uuid>'
   npm.cmd run verify:voice-live-calls
   ```

The verifier requires both calls to be completed, contain caller and agent transcripts, contain STT/LLM/TTS usage rows, and contain first-response latency measurements. Carrier charges apply to both real calls.
