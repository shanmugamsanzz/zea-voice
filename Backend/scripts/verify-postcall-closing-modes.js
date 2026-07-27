import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizePostCallClosingSettings, resolvePostCallClosingConfiguration,
} from '../src/voice/integrations/postcall-closing-config.js';

const dynamic = normalizePostCallClosingSettings({
  postCallMessageType: 'dynamic', postCallPrompt: 'Thank the caller and mention the confirmed action.',
});
assert.equal(dynamic.postCallMessageType, 'Dynamic');
assert.equal(dynamic.postCallPrompt, 'Thank the caller and mention the confirmed action.');

const legacy = normalizePostCallClosingSettings({});
assert.equal(legacy.postCallMessageType, 'Dynamic');
assert.match(legacy.postCallPrompt, /brief, natural closing/i);

const staticMode = normalizePostCallClosingSettings({
  postCallMessageType: 'Static',
  postCallStaticMessage: ' Shanmuga Hospital-ஐ தொடர்பு கொண்டதற்கு நன்றி. ',
});
assert.equal(staticMode.postCallStaticMessage, 'Shanmuga Hospital-ஐ தொடர்பு கொண்டதற்கு நன்றி.');

const none = normalizePostCallClosingSettings({
  postCallMessageType: 'None', postCallPrompt: '', postCallStaticMessage: '',
});
assert.equal(none.postCallMessageType, 'None');

assert.throws(() => normalizePostCallClosingSettings({
  postCallMessageType: 'Dynamic', postCallPrompt: ' ',
}), (error) => error.code === 'POSTCALL_CLOSING_CONFIGURATION_INVALID' && error.field === 'postCallPrompt');
assert.throws(() => normalizePostCallClosingSettings({
  postCallMessageType: 'Static', postCallStaticMessage: '',
}), (error) => error.code === 'POSTCALL_CLOSING_CONFIGURATION_INVALID' && error.field === 'postCallStaticMessage');
assert.throws(() => resolvePostCallClosingConfiguration({ postCallMessageType: 'unsupported' }),
  (error) => error.field === 'postCallMessageType');

const frontend = await readFile(new URL('../../Frontend/src/components/agent/AgentTabs.tsx', import.meta.url), 'utf8');
assert.match(frontend, /Dynamic Closing Prompt is required/);
assert.match(frontend, /Static Closing Message is required/);
assert.match(frontend, /agent\.postCallMessageType === 'None'/);

console.log(JSON.stringify({
  success: true,
  task: 'Post-Call Dynamic, Static and None closing modes',
}));
