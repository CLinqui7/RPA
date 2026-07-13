import { A2000RestAdapter } from './a2000/restAdapter.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] || null;
}

function usage() {
  return [
    'Usage:',
    '  npm --prefix api run a2000:upload -- --order-id <purchase_order_id>',
    '  npm --prefix api run a2000:upload -- --order-id <purchase_order_id> --confirm-write --confirm-order-li-cleared',
    '',
    'Safety:',
    '  Without --confirm-write this command runs live read-only preflight only.',
    '  Shared ORDER_LI writes also require --confirm-order-li-cleared.',
    '  Production writes have an additional environment gate.'
  ].join('\n');
}

const orderId = argValue('--order-id');
const confirmWrite = process.argv.includes('--confirm-write');
const confirmedOrderLiClear = (
  process.argv.includes('--confirm-order-li-cleared')
  || process.argv.includes('--resume-lines-after-clear')
);

if (!orderId) {
  console.error(usage());
  process.exit(2);
}

if (confirmedOrderLiClear) {
  process.env.A2000_ORDER_LI_CLEARED = 'YES';
}

try {
  const adapter = new A2000RestAdapter();

  const result = await adapter.uploadOrderById(orderId, {
    confirmWrite
  });

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    stage: 'adapter_exception',
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error)
    }
  }, null, 2));

  process.exitCode = 1;
}
