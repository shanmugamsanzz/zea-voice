export const callTransferTool = Object.freeze({
  id: 'builtin:transfer_call', name: 'transfer_call', type: 'internal_call_transfer',
  description: 'Transfer this live telephone call to the staff destination configured for this agent. Use EXECUTE only when the agent prompt permits transfer and the caller requests or agrees to it. Never supply credentials, phone numbers or company identifiers. The runtime pauses the AI while staff ring. An accepted request is not a staff connection. If staff cannot answer in wait mode, the same conversation resumes with the actual result. Never promise a staff callback unless separately saved through an authorized workflow.',
  configuration: { inputSchema: { type: 'object', additionalProperties: false,
    required: ['callerConfirmed'], properties: { callerConfirmed: { type: 'boolean', enum: [true] } } } },
});
