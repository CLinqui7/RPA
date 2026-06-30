import { createDemoA2000Batch } from './a2000/exportBatch.js';

const includeNeedsMapping = !process.argv.includes('--ready-only');
const result = await createDemoA2000Batch({ includeNeedsMapping });
console.log(JSON.stringify(result, null, 2));
