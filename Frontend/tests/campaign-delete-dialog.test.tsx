import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CampaignDeleteDialog } from '../src/components/campaigns/CampaignDeleteDialog';

test('permanent deletion warning exposes total/remaining counts and requires typed confirmation', () => {
  const html = renderToStaticMarkup(<CampaignDeleteDialog name="Test Campaign" preview={{
    id:'campaign-1',name:'Test Campaign',status:'paused',totalTasks:100,remainingTasks:98,
  }} error="" deleting={false} onCancel={() => {}} onConfirm={() => {}} />);
  assert.ok(html.includes('100 total lead tasks'));
  assert.ok(html.includes('98 remaining waiting tasks'));
  assert.ok(html.includes('Type DELETE to confirm'));
  assert.ok(html.includes('This cannot be undone'));
  assert.match(html,/type="submit" disabled=""/);
});
test('running campaigns and unavailable counts cannot be confirmed', () => {
  for (const preview of [null, {id:'campaign-1',name:'Test',status:'running',totalTasks:1,remainingTasks:0}]) {
    const html = renderToStaticMarkup(<CampaignDeleteDialog name="Test" preview={preview}
      error="" deleting={false} onCancel={() => {}} onConfirm={() => {}} />);
    assert.match(html,/type="submit" disabled=""/);
  }
});
