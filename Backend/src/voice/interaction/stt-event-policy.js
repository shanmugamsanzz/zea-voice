export function sttEventPolicy(type) {
  const eventType = String(type ?? '').trim().toLowerCase();
  return Object.freeze({
    bufferTranscript: eventType === 'partial_transcript' || eventType === 'final_transcript',
    allowBargeIn: eventType === 'speech_started' || eventType === 'partial_transcript' || eventType === 'final_transcript',
    processCallerTurn: eventType === 'final_transcript',
  });
}
