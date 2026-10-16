export const callTransferTool = Object.freeze({
  id: 'builtin:transfer_call', name: 'transfer_call', type: 'internal_call_transfer',
  description: 'Transfer this live telephone call to the configured staff destination. Use EXECUTE only when the agent prompt permits transfer and the caller requests/agrees. Put a brief pre-transfer announcement in your workflow response speech, using the prompt wording and caller language. The runtime plays it and waits for playback confirmation before dialing. Say you will try to connect, never that staff are already connected. Never supply credentials, phone numbers or company identifiers. The AI waits while staff ring with hold music. In wait mode, failure resumes the same conversation with the actual result. Never promise a staff callback unless separately saved through an authorized workflow.',
  configuration: { inputSchema: { type: 'object', additionalProperties: false,
    required: ['callerConfirmed'], properties: { callerConfirmed: { type: 'boolean', enum: [true] } } } },
});
