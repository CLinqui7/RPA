import { runScan } from './runScan.js';
const result = await runScan();
console.log(JSON.stringify(result, null, 2));
process.exit(result.run.status === 'success' ? 0 : 1);
