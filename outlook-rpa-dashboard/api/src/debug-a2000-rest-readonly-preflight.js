import { A2000RestAdapter } from './a2000/restAdapter.js';

const certifiedOrder = {
  status: 'parsed',
  conflicts: [],
  customer_code: 'CITI',
  store_code: '1',
  order_no: 'READONLY-PREFLIGHT',
  order_date: '07/09/26',
  start_date: '07/16/26',
  cancel_date: '07/23/26',
  division_code: 'AL',
  terms_code: 'X6',
  ship_via_code: 'ROUTING',
  warehouse_code: 'PE',
  purchase_order_lines: [
    {
      line_no: 1,
      style_code: '11KS306S9962',
      color_code: '0C9',
      sales_price: 7.1429,
      warehouse_code: 'PE',
      scale_code: 'v0',
      qty_total: 576,
      qty_sz4: 96,
      qty_sz5: 192,
      qty_sz6: 192,
      qty_sz7: 96
    },
    {
      line_no: 2,
      style_code: '11KS306S9739',
      color_code: '0C2',
      sales_price: 7.1429,
      warehouse_code: 'PE',
      scale_code: 'v0',
      qty_total: 576,
      qty_sz4: 96,
      qty_sz5: 192,
      qty_sz6: 192,
      qty_sz7: 96
    }
  ]
};

console.log('A2000_READONLY_PREFLIGHT=START');
console.log('A2000_WRITES_PERFORMED=NO');

try {
  const adapter = new A2000RestAdapter();
  const result = await adapter.preflight(certifiedOrder);

  console.log(`PREFLIGHT_VALID=${result.valid}`);
  console.log(`LOCAL_VALIDATION_VALID=${result.validation?.valid}`);
  console.log(`SOURCE_GUARD_VALID=${result.source_guard?.valid}`);
  console.log(`LIVE_SCALE_VALID=${result.live_scale_validation?.valid}`);
  console.log(`LIVE_SCALE_SKIPPED=${result.live_scale_validation?.skipped}`);

  for (
    const [index, line]
    of (result.live_scale_validation?.lines || []).entries()
  ) {
    console.log(
      [
        `LINE=${index + 1}`,
        `STYLE=${line.style_code || ''}`,
        `COLOR=${line.color_code || ''}`,
        `VALID=${line.valid}`,
        `EXPECTED_SCALE=${line.expected_scale || ''}`,
        `SELECTED_SCALES=${JSON.stringify(line.selected_scales || [])}`,
        `PACK_MULTIPLIER=${line.pack_multiplier ?? ''}`,
        `ERRORS=${JSON.stringify(line.errors || [])}`
      ].join('|')
    );
  }

  console.log('PREFLIGHT_JSON=' + JSON.stringify(result));

  if (!result.valid) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`PREFLIGHT_EXCEPTION=${error?.message || String(error)}`);
  process.exitCode = 1;
}
