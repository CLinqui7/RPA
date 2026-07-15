#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import zipfile
from pathlib import Path

from checklist_template_engine import generate

API_ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = API_ROOT / 'checklists' / 'approved-template-registry.json'
CHECKLIST_ROOT = API_ROOT / 'checklists'

PAYLOAD_BASE = {
    'header': {
        'control_no': 'VERIFY-CTRL-001',
        'a2000_control_no': 'VERIFY-CTRL-001',
        'control_status': 'VERIFICATION',
        'internal_control_key': 'VERIFY|STORE:001',
        'purchase_order_id': 'verification-order',
        'customer_code': 'VERIFY',
        'order_no': 'PO-VERIFY-001',
        'order_date': '2026-07-15',
        'start_date': '2026-07-20',
        'cancel_date': '2026-07-30',
        'store_code': '001',
        'division_code': '01',
        'terms_code': 'NET30',
        'warehouse_code': 'PE',
        'dept_code': '100',
        'pick_ticket_no': 'PT-VERIFY-001',
        'tickets': 'YES',
        'tracking': 'TRACK-001',
        'dc_name': 'VERIFY DC',
    },
    'lines': [
        {
            'style_code': 'STYLE1',
            'color_code': 'BLK',
            'customer_style': 'CUSTSTYLE1',
            'manufacturer_style': 'MFGSTYLE1',
            'customer_color': 'BLACK',
            'customer_sku': 'SKU123',
            'customer_upc': '123456789012',
            'customer_sku_upc': 'SKU123',
            'qty_total': 24,
            'size_raw': 'S-M-L',
            'sales_price': 9.99,
            'retail_price': 19.99,
            'description': 'VERIFICATION ITEM',
            'order_no': 'PO-VERIFY-001',
            'start_date': '2026-07-20',
            'cancel_date': '2026-07-30',
            'store_code': '001',
            'division_code': '01',
            'warehouse_code': 'PE',
            'line_warehouse_code': 'PE',
            'dept_code': '100',
            'pick_ticket_no': 'PT-VERIFY-001',
            'cartons': 2,
            'carton_id': 'CARTON-001',
            'tickets': 'YES',
            'tracking': 'TRACK-001',
            'sub_sku': 'SUBSKU1',
            'sub_style': 'SUBSTYLE1',
            'sub_color': 'SUBCLR1',
            'dc_name': 'VERIFY DC',
            'packing_instructions': 'VERIFY PACKING',
            'pln_no': 'PLN-001',
            'qty_buckets': {'QTY_SZ1': 8, 'QTY_SZ2': 8, 'QTY_SZ3': 8},
        },
        {
            'style_code': 'STYLE2',
            'color_code': 'RED',
            'customer_style': 'CUSTSTYLE2',
            'customer_color': 'RED',
            'customer_sku': 'SKU456',
            'customer_upc': '987654321098',
            'customer_sku_upc': 'SKU456',
            'qty_total': 12,
            'size_raw': 'M-L',
            'sales_price': 12.5,
            'retail_price': 24.99,
            'description': 'SECOND VERIFICATION ITEM',
            'order_no': 'PO-VERIFY-001',
            'store_code': '001',
            'division_code': '01',
            'warehouse_code': 'PE',
            'line_warehouse_code': 'PE',
            'dept_code': '100',
            'pick_ticket_no': 'PT-VERIFY-001',
            'cartons': 1,
            'qty_buckets': {'QTY_SZ2': 6, 'QTY_SZ3': 6},
        },
    ],
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    registry = json.loads(REGISTRY_PATH.read_text(encoding='utf-8'))
    results = []

    with tempfile.TemporaryDirectory(prefix='rpa-checklists-') as temp_dir:
        temp_root = Path(temp_dir)
        for customer_code, profile in registry['customers'].items():
            print(f'[checklists] {customer_code}: starting', file=sys.stderr, flush=True)
            if not profile.get('allow_generation'):
                results.append({
                    'customer_code': customer_code,
                    'status': 'BLOCKED',
                    'reason': 'CHECKLIST_TEMPLATE_MISSING',
                })
                print(f'[checklists] {customer_code}: blocked, no approved template', file=sys.stderr, flush=True)
                continue

            template_path = CHECKLIST_ROOT / profile['bundled_template_path']
            expected_hash = str(profile.get('sha256') or '').lower()
            actual_hash = digest(template_path)
            if expected_hash and expected_hash != actual_hash:
                raise RuntimeError(f'{customer_code}:CHECKLIST_TEMPLATE_HASH_MISMATCH')

            output_path = temp_root / f'{customer_code}.xlsx'
            payload = {
                **PAYLOAD_BASE,
                'header': {**PAYLOAD_BASE['header'], 'customer_code': customer_code},
                'template_profile': {
                    'customer_code': customer_code,
                    'checklist_status': profile.get('checklist_status'),
                    'production_status': profile.get('production_status'),
                    'schema': profile.get('schema'),
                    'sha256': actual_hash,
                    'resolution_mode': 'STRICT_CANONICAL_REGISTRY',
                    'registry_version': registry.get('version'),
                    'runtime_policy': registry.get('runtime_policy'),
                },
            }

            engine = generate(template_path, output_path, payload)
            if engine.get('schema_source') != 'CANONICAL_CUSTOMER_REGISTRY':
                raise RuntimeError(f'{customer_code}:UNEXPECTED_SCHEMA_SOURCE')
            if not zipfile.is_zipfile(output_path):
                raise RuntimeError(f'{customer_code}:OUTPUT_NOT_VALID_XLSX')
            with zipfile.ZipFile(output_path, 'r') as workbook:
                if 'xl/workbook.xml' not in workbook.namelist():
                    raise RuntimeError(f'{customer_code}:WORKBOOK_XML_MISSING')

            results.append({
                'customer_code': customer_code,
                'status': 'PASS',
                'checklist_status': profile.get('checklist_status'),
                'sheet': engine.get('sheet'),
                'line_count': engine.get('line_count'),
                'schema_source': engine.get('schema_source'),
                'sha256': actual_hash,
            })
            print(f'[checklists] {customer_code}: PASS', file=sys.stderr, flush=True)

    passes = sum(item['status'] == 'PASS' for item in results)
    blocked = sum(item['status'] == 'BLOCKED' for item in results)
    report = {
        'ok': passes == 19 and blocked == 4,
        'registry_version': registry.get('version'),
        'runtime_policy': registry.get('runtime_policy'),
        'approved_templates_verified': passes,
        'blocked_without_template': blocked,
        'results': results,
    }
    print(json.dumps(report, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
