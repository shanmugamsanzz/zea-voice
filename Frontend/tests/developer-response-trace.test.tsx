import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeveloperResponseTracePanel } from '../src/components/reports/DeveloperResponseTracePanel';
import {
  buildDeveloperResponseTrace,
  canViewDeveloperResponseTrace,
  latestFiniteMetric,
  type TraceSource,
} from '../src/components/reports/developer-response-trace';

const decision = (initialDecision: string, finalDecision: string, additions = {}): TraceSource => ({
  type: 'llm', id: `turn-${initialDecision}-${finalDecision}`, label: 'Template engine decision',
  metadata: {
    engine: 'template_engine_v1', initialDecision, finalDecision,
    evidenceIds: [], validationResult: 'valid', ...additions,
  },
});

const knowledge: TraceSource = {
  type: 'knowledge', id: 'evidence-1', label: 'Catalog document',
  metadata: {
    evidenceId: 'evidence-1', recordId: 'record-1', recordType: 'CATALOG_ITEM',
    recordName: 'Option Alpha', documentId: 'document-1',
    documentDisplayName: 'Catalog document', pageNumber: 1,
  },
};

test('developer trace models all template-engine decisions', () => {
  const searched = buildDeveloperResponseTrace([
    decision('SEARCH', 'RESPONSE', { evidenceIds: ['evidence-1'] }), knowledge,
  ]);
  assert.equal(searched?.route, 'SEARCH → RESPONSE');
  assert.equal(searched?.knowledgeSources.length, 1);

  const response = buildDeveloperResponseTrace([decision('RESPONSE', 'RESPONSE')]);
  assert.equal(response?.route, 'RESPONSE');
  assert.equal(response?.sourcesRequired, false);

  const clarify = buildDeveloperResponseTrace([
    decision('CLARIFY', 'CLARIFY', { clarificationReason: 'Ambiguous reference' }),
  ]);
  assert.equal(clarify?.clarificationReason, 'Ambiguous reference');

  const noMatch = buildDeveloperResponseTrace([decision('SEARCH', 'NO_MATCH')]);
  assert.equal(noMatch?.route, 'SEARCH → NO_MATCH');

  const tool = buildDeveloperResponseTrace([
    decision('TOOL', 'TOOL_RESULT', { workflowId: 'workflow-1', toolId: 'tool-1' }),
    { type: 'tool', id: 'tool-1', label: 'tool-1', metadata: {
      workflowId: 'workflow-1', status: 'FAILED', success: false,
    } },
  ]);
  assert.equal(tool?.workflowId, 'workflow-1');
  assert.equal(tool?.toolResult, 'failed');

  const successfulTool = buildDeveloperResponseTrace([
    decision('TOOL', 'TOOL_RESULT', { workflowId: 'workflow-1', toolId: 'tool-1' }),
    { type: 'tool', id: 'tool-1', label: 'tool-1', metadata: {
      workflowId: 'workflow-1', status: 'SUCCEEDED', success: true,
    } },
  ]);
  assert.equal(successfulTool?.toolResult, 'success');
});

test('runtime cards use the latest measured value instead of a later non-search null', () => {
  const samples = [
    { epoch: 1, retrievalMs: 18, totalFirstAudioMs: 120 },
    { epoch: 2, retrievalMs: undefined, totalFirstAudioMs: 90 },
  ];
  assert.equal(latestFiniteMetric(samples, 'retrievalMs'), 18);
  assert.equal(latestFiniteMetric(samples, 'totalFirstAudioMs'), 90);
  assert.equal(latestFiniteMetric([], 'retrievalMs'), undefined);
});

test('developer diagnostics render only for developer roles', () => {
  assert.equal(canViewDeveloperResponseTrace('SUPER_ADMIN'), true);
  assert.equal(canViewDeveloperResponseTrace('DEVELOPER'), true);
  assert.equal(canViewDeveloperResponseTrace('USER'), false);
  const sources = [decision('SEARCH', 'RESPONSE', { evidenceIds: ['evidence-1'] }), knowledge];
  const developerMarkup = renderToStaticMarkup(React.createElement(DeveloperResponseTracePanel, {
    sources, visible: true,
  }));
  assert.match(developerMarkup, /Route:<\/span> SEARCH → RESPONSE/u);
  assert.match(developerMarkup, /Sources \(1\):<\/span> Catalog document · Option Alpha/u);

  const userMarkup = renderToStaticMarkup(React.createElement(DeveloperResponseTracePanel, {
    sources, visible: false,
  }));
  assert.equal(userMarkup, '');
});
