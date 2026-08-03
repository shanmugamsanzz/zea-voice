import assert from 'node:assert/strict';
import {
  captureTaskCompletionInput,
  createTaskCompletionState,
  renderTaskCompletionConfirmation,
} from '../src/voice/interaction/task-completion-state.js';

let state = createTaskCompletionState({
  taskCompletionEnabled: true,
  taskCompletionIntent: 'appointment_booking',
  taskCompletionRequiredFields: [
    'patient_name', 'patient_age', 'selected_package', 'appointment_date', 'appointment_time',
  ],
  taskCompletionConfirmationMessage: '{{patient_name}} - {{selected_package}} confirmed.',
});

assert.equal(state.configuration.enabled, true);
assert.equal('Silver package'.match(/\b(silver|gold|platinum)\b/iu)?.[1], 'Silver');
let result = captureTaskCompletionInput(state, 'Silver package', [
  { role: 'assistant', content: 'Which package do you want?' },
]);
assert.equal(result.state.values.selected_package, 'Silver');

result = captureTaskCompletionInput(result.state, 'Shanmugam age 21', [
  { role: 'assistant', content: 'Patient name and age?' },
]);
assert.equal(result.state.values.patient_name, 'Shanmugam');
assert.equal(result.state.values.patient_age, '21');

result = captureTaskCompletionInput(result.state, 'tomorrow 10 o clock', [
  { role: 'assistant', content: 'Which date and time?' },
]);
assert.equal(result.complete, true);
assert.equal(renderTaskCompletionConfirmation(result.state), 'Shanmugam - Silver confirmed.');

console.log(JSON.stringify({ success: true, task: 'Task completion collection and confirmation rendering' }));
