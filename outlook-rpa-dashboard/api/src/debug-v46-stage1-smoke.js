import {
  launchStatus,
  listOperationalOrders,
  listOperationsLog
} from './po/productionWorkflow.js';

try {
  const status = launchStatus();
  const orders = await listOperationalOrders({ limit: 5 });
  const logs = await listOperationsLog({ limit: 5 });

  console.log('A2000_V4_6_STAGE1_SMOKE=PASS');
  console.log(`ENVIRONMENT=${status.environment}`);
  console.log(`AUTO_UPLOAD_ENABLED=${status.auto_upload_enabled}`);
  console.log(`EMAIL_SCAN_AUTO_PARSE=${status.email_scan_auto_parse}`);
  console.log(`CERTIFIED_CUSTOMER_COUNT=${status.certified_customers.length}`);
  console.log(`OPERATIONAL_ORDER_READ_COUNT=${orders.length}`);
  console.log(`OPERATIONS_LOG_READ_COUNT=${logs.length}`);
  console.log('A2000_WRITES_PERFORMED=NO');
  console.log('SUPABASE_WRITES_PERFORMED=NO');
} catch (error) {
  console.error('A2000_V4_6_STAGE1_SMOKE=FAIL');
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
