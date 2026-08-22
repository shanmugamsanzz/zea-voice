// Business examples intentionally live only in test fixtures. Production
// runtime code consumes the same generic contract for every tenant.
export const task10Industries = Object.freeze([
  {
    industry: 'healthcare', tenantId: '10000000-0000-4000-8000-000000000011',
    agentId: '20000000-0000-4000-8000-000000000011', kbId: '30000000-0000-4000-8000-000000000011',
    recordId: '40000000-0000-4000-8000-000000000011', revision: 3,
    query: 'Where can I visit you?', fact: 'The clinic is beside River Station.', language: 'en',
    variants: ['where are you located', 'vere can i visit yoo'],
  },
  {
    industry: 'property', tenantId: '10000000-0000-4000-8000-000000000012',
    agentId: '20000000-0000-4000-8000-000000000012', kbId: '30000000-0000-4000-8000-000000000012',
    recordId: '40000000-0000-4000-8000-000000000012', revision: 5,
    query: 'Is there a compact home available?', fact: 'Maple Residence has a two-bedroom home available.', language: 'en',
    variants: ['compact home details', 'kompact hom available'],
  },
  {
    industry: 'education', tenantId: '10000000-0000-4000-8000-000000000013',
    agentId: '20000000-0000-4000-8000-000000000013', kbId: '30000000-0000-4000-8000-000000000013',
    recordId: '40000000-0000-4000-8000-000000000013', revision: 2,
    query: 'class eppo start aagum?', fact: 'The evening class starts at six.', language: 'ta',
    variants: ['class eppo start', 'கிளாஸ் எப்போது தொடங்கும்'],
  },
  {
    industry: 'insurance', tenantId: '10000000-0000-4000-8000-000000000014',
    agentId: '20000000-0000-4000-8000-000000000014', kbId: '30000000-0000-4000-8000-000000000014',
    recordId: '40000000-0000-4000-8000-000000000014', revision: 8,
    query: 'How long is protection active?', fact: 'The protection period is twelve months.', language: 'en',
    variants: ['protection period', 'proteksyon active how long'],
  },
  {
    industry: 'retail', tenantId: '10000000-0000-4000-8000-000000000015',
    agentId: '20000000-0000-4000-8000-000000000015', kbId: '30000000-0000-4000-8000-000000000015',
    recordId: '40000000-0000-4000-8000-000000000015', revision: 4,
    query: 'blue model oda rate enna?', fact: 'The blue model costs 750 INR.', language: 'ta',
    variants: ['blue model rate', 'ப்ளூ மாடல் விலை என்ன'],
  },
]);
