#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import re
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

PROJECT = Path(sys.argv[1] if len(sys.argv) > 1 else '/workspaces/RPA/outlook-rpa-dashboard').resolve()
API_ROOT = PROJECT / 'api'
CATALOG_PATH = API_ROOT / 'checklists' / 'catalog.json'
ALIASES_PATH = API_ROOT / 'checklists' / 'customer_aliases.json'
ENGINE_PATH = API_ROOT / 'scripts' / 'checklist_template_engine.py'

HARD_ALIASES = {
    'BEALLS OUTLET': 'BEALLSOUTL', 'BEALLS': 'BEALLSOUTL', 'BEALLSOUTL': 'BEALLSOUTL',
    'CITI TRENDS': 'CITI', 'CITI': 'CITI',
    'GABRIEL BROTHERS': 'GABRIELBRO', 'GABRIEL BROS': 'GABRIELBRO', 'GABES': 'GABRIELBRO',
    'GABRIELBRO': 'GABRIELBRO', 'GRABRIELBROS': 'GABRIELBRO',
    'SHOE SHOW': 'SHOE4500', 'SHOESHOW': 'SHOE4500', 'SHOE4500': 'SHOE4500',
    'VARIETY WHOLESALERS': 'VARIETYWHO', 'VARIETY WHO': 'VARIETYWHO', 'VARIETYWHO': 'VARIETYWHO',
    '10 BELOW': '10BELOW', '10BELOW': '10BELOW', '10 SPOT': '10BELOW', 'SIMPLY 10': '10BELOW',
    "OLLIE'S": 'OLLIES', 'OLLIES': 'OLLIES',
    'VERSONA': 'VERSONA', 'ZUMIEZ': 'ZUMIEZ',
    'ME SALVE': 'MESALVEINC', 'MESALVE': 'MESALVEINC', 'MEL SALVE': 'MESALVEINC', 'MESALVEINC': 'MESALVEINC',
    'ITS FASHION': 'ITSFASHION', 'ITSFASHION': 'ITSFASHION',
    'CARNIVAL': 'CARNIVAL',
    'CATCO': 'CATO', 'CATO': 'CATO',
    'COLONY BRANDS': 'COLONY', 'COLONY': 'COLONY',
    'GORDON BROTHERS': 'GORBRORET', 'GORBRORET': 'GORBRORET',
    'HAMRICKS': 'HAMRICKS', 'HAMRICK': 'HAMRICKS',
    'INTEGRATED PREMIUM CONCEPTS': 'IPC', 'IPC': 'IPC',
    'MACYS BACKSTAGE': 'MACYSBACKS', "MACY'S BACKSTAGE": 'MACYSBACKS', 'MACYSBACKS': 'MACYSBACKS',
    'MANDEE': 'MANDEE',
    'MARSHALLS': 'MARSHALLS', 'MARSHAECOM': 'MARSHALLS',
    'TJ MAXX': 'TJMAXX', 'TJMAXX': 'TJMAXX', 'TJXECOM': 'TJMAXX', 'MTJX ECOMM': 'TJMAXX',
    'SPENCER GIFTS': 'SPENCER', 'SPENCER': 'SPENCER',
    'TILLYS': 'TILLYS', "TILLY'S": 'TILLYS',
}

EXTENSIONS = {'.xlsx', '.xlsm', '.xltx'}


def norm(value: str) -> str:
    return re.sub(r'[^A-Z0-9]+', ' ', str(value or '').upper()).strip()


def compact(value: str) -> str:
    return re.sub(r'[^A-Z0-9]+', '', str(value or '').upper())


def load_engine():
    spec = importlib.util.spec_from_file_location('checklist_template_engine_runtime', ENGINE_PATH)
    if not spec or not spec.loader:
        raise RuntimeError(f'No se pudo cargar {ENGINE_PATH}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_csv_rows(path: Path):
    if not path.exists():
        return []
    with path.open('r', encoding='utf-8-sig', errors='replace', newline='') as handle:
        return list(csv.DictReader(handle))


def build_aliases():
    aliases = dict(HARD_ALIASES)
    customers_path = API_ROOT / 'masters' / 'cache' / 'customers.csv'
    for row in read_csv_rows(customers_path):
        code = str(row.get('customer') or '').strip().upper()
        if not code:
            continue
        aliases[code] = code
        for field in ('name', 'cust_name', 'customer_name', 'name_norm'):
            value = str(row.get(field) or '').strip()
            if len(norm(value)) >= 4:
                aliases[value] = code
    normalized = {}
    for alias, code in aliases.items():
        key = norm(alias)
        if len(key) < 2:
            continue
        normalized[key] = str(code).strip().upper()
    return normalized


def workbook_text(path: Path, limit: int = 250000) -> str:
    try:
        chunks = []
        with zipfile.ZipFile(path, 'r') as archive:
            names = archive.namelist()
            if 'xl/sharedStrings.xml' in names:
                root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
                for node in root.iter():
                    if node.tag.endswith('}t') and node.text:
                        chunks.append(node.text)
                        if sum(map(len, chunks)) >= limit:
                            break
            if sum(map(len, chunks)) < limit:
                for name in names:
                    if not name.startswith('xl/worksheets/sheet') or not name.endswith('.xml'):
                        continue
                    root = ET.fromstring(archive.read(name))
                    for node in root.iter():
                        if node.tag.endswith('}t') and node.text:
                            chunks.append(node.text)
                            if sum(map(len, chunks)) >= limit:
                                break
                    if sum(map(len, chunks)) >= limit:
                        break
        return ' '.join(chunks)[:limit]
    except Exception:
        return ''


def match_aliases(value: str, aliases: dict[str, str]):
    value_norm = f' {norm(value)} '
    value_compact = compact(value)
    matches = []
    for alias, code in sorted(aliases.items(), key=lambda item: len(item[0]), reverse=True):
        alias_compact = compact(alias)
        if f' {alias} ' in value_norm or (len(alias_compact) >= 5 and alias_compact in value_compact):
            matches.append((len(alias), code, alias))
    if not matches:
        return []
    max_len = max(item[0] for item in matches)
    return sorted({item[1] for item in matches if item[0] >= max_len - 2})


def infer_customer(path: Path, text: str, aliases: dict[str, str], existing_code: str | None):
    if existing_code:
        return existing_code, 'existing_catalog_sha'
    path_matches = match_aliases(str(path), aliases)
    if len(path_matches) == 1:
        return path_matches[0], 'path_alias'
    text_matches = match_aliases(text, aliases)
    if len(text_matches) == 1:
        return text_matches[0], 'workbook_text_alias'
    if len(path_matches) == 1 and path_matches[0] in text_matches:
        return path_matches[0], 'path_and_workbook_alias'
    return None, 'unresolved'


def discover_roots():
    roots = [
        API_ROOT / 'training' / 'historical' / 'Customers_Master_Checklists',
        API_ROOT / 'checklists' / 'templates',
        API_ROOT / 'training' / 'historical',
    ]
    return [root for root in roots if root.exists()]


def prefer_path(left: Path, right: Path):
    left_score = (0 if 'checklists/templates' in str(left) else 1, -len(str(left)))
    right_score = (0 if 'checklists/templates' in str(right) else 1, -len(str(right)))
    return right if right_score > left_score else left


def main():
    engine = load_engine()
    aliases = build_aliases()
    ALIASES_PATH.parent.mkdir(parents=True, exist_ok=True)
    ALIASES_PATH.write_text(json.dumps(aliases, indent=2, ensure_ascii=False), encoding='utf-8')

    existing_by_sha = {}
    if CATALOG_PATH.exists():
        try:
            existing = json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
            for item in existing.get('templates', []):
                sha = str(item.get('sha256') or '').strip().lower()
                code = str(item.get('customer_code') or '').strip().upper()
                if sha and code:
                    existing_by_sha[sha] = code
        except Exception:
            pass

    files_by_sha = {}
    for root in discover_roots():
        for path in root.rglob('*'):
            if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
                continue
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except Exception:
                continue
            if digest in files_by_sha:
                files_by_sha[digest] = prefer_path(files_by_sha[digest], path)
            else:
                files_by_sha[digest] = path

    templates = []
    by_customer = {}
    unresolved = []
    invalid = []

    for digest, path in sorted(files_by_sha.items(), key=lambda item: str(item[1]).lower()):
        try:
            files = engine.load_xlsx(path)
            schema = engine.discover_schema(files)
            text = workbook_text(path)
            code, source = infer_customer(path, text, aliases, existing_by_sha.get(digest))
            record = {
                'template_id': digest[:16],
                'customer_code': code,
                'customer_codes': [code] if code else [],
                'customer_resolution': source,
                'source': str(path),
                'template_path': str(path.resolve()),
                'resolved_template_path': str(path.resolve()),
                'extension': path.suffix.lower(),
                'size_bytes': path.stat().st_size,
                'sha256': digest,
                'image_count': schema.get('image_count', 0),
                'sheets': schema.get('sheets', []),
                'best_sheet': schema.get('best_sheet'),
            }
            if not schema.get('best_sheet') or not schema.get('best_sheet', {}).get('table'):
                record['error'] = 'NO_RECOGNIZED_CHECKLIST_LINE_TABLE'
                invalid.append({'path': str(path), 'customer_code': code})
            elif code:
                by_customer[code] = by_customer.get(code, 0) + 1
            else:
                unresolved.append(str(path))
            templates.append(record)
        except Exception as error:
            templates.append({
                'source': str(path),
                'template_path': str(path.resolve()),
                'sha256': digest,
                'error': str(error),
            })
            invalid.append({'path': str(path), 'error': str(error)})

    valid = [item for item in templates if not item.get('error')]
    catalog = {
        'catalog_version': 3,
        'template_count': len(valid),
        'source_file_count': len(files_by_sha),
        'mapped_template_count': len([item for item in valid if item.get('customer_code')]),
        'unresolved_template_count': len([item for item in valid if not item.get('customer_code')]),
        'invalid_template_count': len([item for item in templates if item.get('error')]),
        'recognized_customer_codes': sorted(by_customer),
        'templates_by_customer': dict(sorted(by_customer.items())),
        'templates': templates,
    }
    CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    backup = CATALOG_PATH.with_suffix('.json.before-self-heal')
    if CATALOG_PATH.exists() and not backup.exists():
        backup.write_bytes(CATALOG_PATH.read_bytes())
    CATALOG_PATH.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding='utf-8')

    report_path = API_ROOT / 'checklists' / 'catalog_repair_report.json'
    report = {
        'ok': True,
        'catalog_path': str(CATALOG_PATH),
        'aliases_path': str(ALIASES_PATH),
        'template_count': catalog['template_count'],
        'mapped_template_count': catalog['mapped_template_count'],
        'unresolved_template_count': catalog['unresolved_template_count'],
        'invalid_template_count': catalog['invalid_template_count'],
        'templates_by_customer': catalog['templates_by_customer'],
        'unresolved_preview': unresolved[:50],
        'invalid_preview': invalid[:50],
    }
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
