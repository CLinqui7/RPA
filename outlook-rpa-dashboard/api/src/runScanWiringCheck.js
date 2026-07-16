import {
  runScanDependencyStatus
} from './runScan.js';

const status = runScanDependencyStatus();

console.log(JSON.stringify(status, null, 2));

if (!status.ok) {
  process.exitCode = 1;
}
