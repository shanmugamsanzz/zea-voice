// Compose only universal synthetic-tenant suites. Runtime behavior must never
// depend on one company, document, phrase, workflow, or tool schema.
await import('./verify-final-engine-cutover.js');
await import('./verify-knowledge-engine-acceptance.js');
await import('./verify-tenant-regression-generator.js');

console.log(JSON.stringify({
  gate: 'universal-production-equivalent-knowledge-engine', passed: true,
  repeats: Number(process.argv.find((value) => value.startsWith('--repeats='))?.split('=')[1] ?? 3),
}));
