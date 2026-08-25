import assert from 'node:assert/strict';
import {
  applyCanonicalEntityToTaskCompletionState,
  captureTaskCompletionInput,
  createTaskCompletionState,
  renderTaskCompletionConfirmation,
} from '../src/voice/interaction/task-completion-state.js';
import { mergeToolFieldSchemas } from '../src/voice/interaction/tool-field-schema.js';
import { resolveRuntimeMessage } from '../src/voice/interaction/configured-runtime-messages.js';

const fieldSchemas = mergeToolFieldSchemas([], [{
  name: 'submit_request',
  inputSchema: {
    type: 'object',
    required: ['contact', 'quantity', 'service', 'requested_date', 'requested_time'],
    properties: {
      contact: { type: 'string', title: 'Contact', question: 'Who is the contact?' },
      quantity: { type: 'integer', title: 'Quantity', question: 'What quantity?' },
      service: {
        type: 'string', title: 'Service', question: 'Which service?',
        enum: ['standard', 'priority'],
        'x-enum-labels': ['Standard', 'Priority'],
        'x-enum-aliases': { standard: ['usual'], priority: ['fast-track'] },
      },
      requested_date: {
        type: 'string', format: 'date', title: 'Requested date', question: 'Which date?',
      },
      requested_time: {
        type: 'string', format: 'time', title: 'Requested time', question: 'Which time?',
      },
    },
  },
}]);
assert.equal(fieldSchemas.find((field) => field.key === 'quantity').type, 'integer');
assert.deepEqual(fieldSchemas.find((field) => field.key === 'service').options[1], {
  value: 'priority', label: 'Priority', aliases: ['fast-track'],
});

let state = createTaskCompletionState({
  taskCompletionEnabled: true,
  taskCompletionIntent: 'submit_request',
  taskCompletionRequiredFields: ['contact', 'quantity', 'service', 'requested_date', 'requested_time'],
  taskCompletionConfirmationMessage: '{{contact}} - {{service}} confirmed.',
}, {}, { fieldSchemas });

assert.equal(state.configuration.enabled, true);
let result = captureTaskCompletionInput(state, 'fast-track', [
  { role: 'assistant', content: 'Which service?' },
]);
assert.equal(result.state.values.service, 'priority');

result = captureTaskCompletionInput(result.state, 'Contact: Mira; Quantity: 21', [
  { role: 'assistant', content: 'Please provide the contact and quantity.' },
]);
assert.equal(result.state.values.contact, 'Mira');
assert.equal(result.state.values.quantity, 21);

result = captureTaskCompletionInput(result.state,
  'Requested date: 2026-08-30; Requested time: 10:00', [
    { role: 'assistant', content: 'Provide the requested date and time.' },
  ]);
assert.equal(result.state.values.requested_date, '2026-08-30');
assert.equal(result.state.values.requested_time, '10:00');
assert.equal(result.complete, true);
assert.equal(renderTaskCompletionConfirmation(result.state), 'Mira - priority confirmed.');

const catalogState = createTaskCompletionState({
  taskCompletionEnabled: true,
  taskCompletionIntent: 'reserve_service',
  taskCompletionRequiredFields: ['selected_service'],
  taskCompletionConfirmationMessage: '{{selected_service}} confirmed.',
}, {}, { fieldSchemas: [{
  key: 'selected_service', label: 'Selected service', type: 'catalog_reference',
  question: 'Which published service?', catalogReference: { recordType: 'catalog_item' },
}] });
const canonicalCatalogState = applyCanonicalEntityToTaskCompletionState(catalogState, {
  recordId: 'record-1', recordType: 'catalog_item', key: 'express-service',
  name: 'Express Service',
});
assert.deepEqual(canonicalCatalogState.canonicalEntity, {
  recordId: 'record-1', name: 'Express Service', key: 'express-service',
  recordType: 'catalog_item',
});
const catalogResult = captureTaskCompletionInput(canonicalCatalogState, 'express option', [
  { role: 'assistant', content: 'Which published service?' },
], {
  resolvedEntities: [{
    recordId: 'record-1', recordType: 'catalog_item', name: 'Express Service',
    aliases: ['express option'], confidenceLevel: 'HIGH',
  }],
});
assert.equal(catalogResult.state.values.selected_service, 'Express Service');
assert.equal(catalogResult.complete, true);

const missingSchema = captureTaskCompletionInput(createTaskCompletionState({
  taskCompletionEnabled: true,
  taskCompletionIntent: 'submit_request',
  taskCompletionRequiredFields: ['unconfigured_field'],
  taskCompletionConfirmationMessage: 'Confirmed.',
}), 'arbitrary caller value', [
  { role: 'assistant', content: 'Provide a value.' },
]);
assert.deepEqual(missingSchema.captured, []);
assert.deepEqual(missingSchema.missing, ['unconfigured_field']);

assert.equal(resolveRuntimeMessage({ agent: { settings: {
  knowledgeClarificationMessage: 'Could you confirm {{candidate}}?',
} } }, 'clarification', {}, { candidate: 'Express Service' }),
'Could you confirm Express Service?');
assert.equal(resolveRuntimeMessage({ agent: { settings: {} } }, 'technical_failure', {
  tenantEvidence: { guidanceEvidence: [{
    callerFacing: true,
    content: 'The configured service is temporarily unavailable.',
    authoritativeData: { runtimeMessageRole: 'technical_failure' },
  }] },
}), 'The configured service is temporarily unavailable.');
assert.equal(resolveRuntimeMessage({ agent: { settings: {} } }, 'clarification'), '');

console.log(JSON.stringify({ success: true, task: 'Schema-driven task completion collection' }));
