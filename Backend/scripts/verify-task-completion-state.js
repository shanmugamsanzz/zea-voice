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

const multilingual = createTaskCompletionState({
  taskCompletionEnabled: true,
  taskCompletionIntent: 'reservation',
  taskCompletionRequiredFields: ['customer_name', 'customer_age', 'appointment_date', 'appointment_time'],
  taskCompletionConfirmationMessage: 'Confirmed.',
});
const multiResult = captureTaskCompletionInput(multilingual,
  'name Mitra, age 30, 13th August, kalai 10 mani', [
    { role: 'assistant', content: 'Please share your booking details.' },
  ]);
assert.equal(multiResult.state.values.customer_name, 'Mitra');
assert.equal(multiResult.state.values.customer_age, '30');
assert.equal(multiResult.state.values.appointment_date, '13th August');
assert.equal(multiResult.state.values.appointment_time, 'kalai 10 mani');
assert.equal(multiResult.complete, true);

const tamilDateTime = captureTaskCompletionInput(createTaskCompletionState({
  taskCompletionEnabled: true,
  taskCompletionIntent: 'reservation',
  taskCompletionRequiredFields: ['appointment_date', 'appointment_time'],
  taskCompletionConfirmationMessage: 'Confirmed.',
}), 'ஆகஸ்ட் 13 காலை 10 மணி', [
  { role: 'assistant', content: 'தேதி மற்றும் நேரம் சொல்லுங்க.' },
]);
assert.equal(tamilDateTime.state.values.appointment_date, 'ஆகஸ்ட் 13');
assert.equal(tamilDateTime.state.values.appointment_time, 'காலை 10');

console.log(JSON.stringify({ success: true, task: 'Task completion collection and confirmation rendering' }));
