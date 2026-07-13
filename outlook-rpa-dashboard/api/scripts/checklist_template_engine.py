#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
REL_NS = {'p': 'http://schemas.openxmlformats.org/package/2006/relationships'}
MAIN_NS = NS['m']
ET.register_namespace('', MAIN_NS)
ET.register_namespace('r', NS['r'])

CUSTOMERS = {
    'BEALLS OUTLET': 'BEALLSOUTL', 'BEALLSOUTL': 'BEALLSOUTL', 'BEALLS': 'BEALLSOUTL',
    'CITI TRENDS': 'CITI', 'CITI': 'CITI',
    'GRABRIELBROS': 'GABRIELBRO', 'GABRIEL BROS': 'GABRIELBRO',
    'GABRIELBRO': 'GABRIELBRO', 'GABRIEL': 'GABRIELBRO', 'GABES': 'GABRIELBRO',
    'SHOE SHOW': 'SHOE4500', 'SHOESHOW': 'SHOE4500', 'SHOE4500': 'SHOE4500',
    'VARIETY WHOLESALERS': 'VARIETYWHO', 'VARIETYWHO': 'VARIETYWHO',
    'VARIETY': 'VARIETYWHO',
    '10 BELOW': '10BELOW', '10BELOW': '10BELOW',
    '10 SPOT': '10BELOW', '10SPOT': '10BELOW', 'SIMPLY 10': '10BELOW',
    'OLLIE S': 'OLLIES', 'OLLIES': 'OLLIES', "OLLIE'S": 'OLLIES',
    'VERSONA': 'VERSONA', 'ZUMIEZ': 'ZUMIEZ',
    'ME SALVE': 'MESALVEINC', 'MESALVEINC': 'MESALVEINC',
    'MESALVE': 'MESALVEINC', 'MELSALVE': 'MESALVEINC',
    'ITS FASHION': 'ITSFASHION', 'ITSFASHION': 'ITSFASHION',
    'CARNIVAL': 'CARNIVAL',
    'CATCO': 'CATO', 'CATO': 'CATO',
    'COLONY': 'COLONY',
    'GORDON BROTHERS': 'GORBRORET', 'GORBRORET': 'GORBRORET',
    'HAMRICKS': 'HAMRICKS', 'HAMRICK': 'HAMRICKS',
    'IPC': 'IPC',
    'MACYSBACKS': 'MACYSBACKS', 'MACYSBACK': 'MACYSBACKS',
    'MACY S': 'MACYSBACKS',
    'MANDEE': 'MANDEE',
    'MARSHALLS': 'MARSHALLS', 'MARSHAECOM': 'MARSHALLS',
    'TJ MAXX': 'TJMAXX', 'TJMAXX': 'TJMAXX',
    'TJXECOM': 'TJMAXX', 'MTJX ECOMM': 'TJMAXX',
    'SPENCER': 'SPENCER', 'TILLYS': 'TILLYS',
}

FIELD_SYNONYMS = {
    'style_code': ['OUR STYLE', 'A2000 STYLE', 'PT STYLE', 'AE STYLE', 'A E STYLE', 'STYLE'],
    'color_code': ['CLR', 'A2000 COLOR', 'PT COLOR', 'AE COLOR', 'A E COLOR', 'COLOR'],
    'customer_style': ['CUSTOMER STYLE ON TICKET', 'CUSTOMER STYLE', 'VENDOR STYLE', 'MFG STYLE', 'TILLYS STYLE', 'RETAILER STYLE'],
    'customer_color': ['CUSTOMER COLOR', 'MFG COLOR', 'COLOR DESCRIPTION'],
    'customer_sku': ['CUSTOMER SKU', 'CUST SKU', 'SKU'],
    'customer_upc': ['CUSTOMER UPC', 'UPC NO', 'UPC'],
    'qty_total': ['PICK QTY', 'ORDER QTY', 'QUANTITY', 'QTY'],
    'size_raw': ['SIZE RUN', 'SIZE'],
    'sales_price': ['UNIT COST', 'COST', 'SALES PRICE', 'PRICE'],
    'description': ['DESCRIPTION', 'DESC', 'TILLY DESCRIPTION', 'CUSTOMER DESCRIPTION'],
    'order_no': ['ORDER NO', 'PO NUMBER', 'PO #', 'PO'],
    'store_code': ['STORE NO', 'STORE', 'DC'],
    'division_code': ['DIVISION', 'DIV'],
    'terms_code': ['TERMS', 'TERM'],
    'warehouse_code': ['WAREHOUSE', 'WH'],
}


def norm(value: str) -> str:
    return re.sub(r'[^A-Z0-9]+', ' ', str(value or '').upper()).strip()


def col_num(cell_ref: str) -> int:
    letters = re.match(r'[A-Z]+', cell_ref.upper()).group(0)
    value = 0
    for ch in letters:
        value = value * 26 + ord(ch) - 64
    return value


def col_name(number: int) -> str:
    out = ''
    while number:
        number, rem = divmod(number - 1, 26)
        out = chr(65 + rem) + out
    return out


def split_ref(cell_ref: str):
    match = re.match(r'([A-Z]+)(\d+)', cell_ref.upper())
    return col_num(match.group(1)), int(match.group(2))


def shared_strings(files):
    path = 'xl/sharedStrings.xml'
    if path not in files:
        return []
    root = ET.fromstring(files[path])
    values = []
    for si in root.findall('m:si', NS):
        values.append(''.join(t.text or '' for t in si.iter(f'{{{MAIN_NS}}}t')))
    return values


def cell_value(cell, strings):
    cell_type = cell.get('t')
    if cell_type == 'inlineStr':
        return ''.join(t.text or '' for t in cell.iter(f'{{{MAIN_NS}}}t'))
    value = cell.find('m:v', NS)
    if value is None or value.text is None:
        return ''
    if cell_type == 's':
        try: return strings[int(value.text)]
        except Exception: return ''
    return value.text


def workbook_sheets(files):
    workbook = ET.fromstring(files['xl/workbook.xml'])
    rels = ET.fromstring(files['xl/_rels/workbook.xml.rels'])
    targets = {rel.get('Id'): rel.get('Target') for rel in rels.findall('p:Relationship', REL_NS)}
    output = []
    for sheet in workbook.findall('m:sheets/m:sheet', NS):
        rid = sheet.get(f'{{{NS["r"]}}}id')
        target = targets.get(rid)
        if target:
            path = str(PurePosixPath('xl') / target) if not target.startswith('/') else target.lstrip('/')
            output.append((sheet.get('name'), path))
    return output


def discover_schema(files):
    strings = shared_strings(files)
    sheets = []
    best = None
    for sheet_name, sheet_path in workbook_sheets(files):
        if sheet_path not in files: continue
        root = ET.fromstring(files[sheet_path])
        cells = []
        for cell in root.findall('.//m:c', NS):
            ref = cell.get('r')
            value = cell_value(cell, strings)
            if ref and value:
                col, row = split_ref(ref)
                cells.append({'ref': ref, 'col': col, 'row': row, 'value': value})

        rows = {}
        for item in cells:
            rows.setdefault(item['row'], []).append(item)
        row_matches = []
        for row, items in rows.items():
            matched = {}
            for item in items:
                value_norm = norm(item['value'])
                for field, synonyms in FIELD_SYNONYMS.items():
                    if any(value_norm == norm(s) or value_norm.startswith(norm(s) + ' ') for s in synonyms):
                        matched.setdefault(field, item['col'])
            if len(matched) >= 3:
                row_matches.append((len(matched), row, matched))
        row_matches.sort(reverse=True)
        table = None
        if row_matches:
            score, row, columns = row_matches[0]
            table = {'header_row': row, 'data_start_row': row + 1, 'columns': columns, 'score': score}
        info = {'name': sheet_name, 'path': sheet_path, 'table': table, 'cell_count': len(cells)}
        sheets.append(info)
        if table and (best is None or table['score'] > best['table']['score']): best = info
    return {'sheets': sheets, 'best_sheet': best, 'image_count': sum(1 for name in files if name.startswith('xl/media/'))}


def load_xlsx(path: Path):
    with zipfile.ZipFile(path, 'r') as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def guess_customer(path: str):
    value = norm(path)
    for key in sorted(CUSTOMERS, key=len, reverse=True):
        if norm(key) in value:
            return CUSTOMERS[key]
    return None


def scan_roots(roots, extract_dir: Path):
    templates = []
    seen_hashes = set()
    extract_dir.mkdir(parents=True, exist_ok=True)

    def add_file(path: Path, source):
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest in seen_hashes: return
            files = load_xlsx(path)
            schema = discover_schema(files)
            seen_hashes.add(digest)
            templates.append({
                'template_id': digest[:16],
                'customer_code': guess_customer(str(source)),
                'source': str(source),
                'template_path': str(path),
                'extension': path.suffix.lower(),
                'size_bytes': path.stat().st_size,
                'sha256': digest,
                'image_count': schema['image_count'],
                'sheets': schema['sheets'],
                'best_sheet': schema['best_sheet'],
            })
        except Exception as error:
            templates.append({'source': str(source), 'error': str(error)})

    for root_value in roots:
        root = Path(root_value)
        if not root.exists(): continue
        if root.is_dir():
            for path in root.rglob('*'):
                if path.suffix.lower() in {'.xlsx', '.xlsm', '.xltx'} and 'check' in path.name.lower():
                    add_file(path, path)
        elif root.suffix.lower() == '.zip':
            archive_hash = hashlib.sha256(root.read_bytes()).hexdigest()[:16]
            with zipfile.ZipFile(root, 'r') as archive:
                for member in archive.namelist():
                    if Path(member).suffix.lower() not in {'.xlsx', '.xlsm', '.xltx'}: continue
                    if 'check' not in member.lower(): continue
                    target = extract_dir / archive_hash / Path(member).name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as source, target.open('wb') as destination:
                        shutil.copyfileobj(source, destination)
                    add_file(target, f'{root}!{member}')

    return templates


def set_cell_value(cell, value):
    for child in list(cell):
        if child.tag in {f'{{{MAIN_NS}}}v', f'{{{MAIN_NS}}}is', f'{{{MAIN_NS}}}f'}:
            cell.remove(child)
    if value is None or value == '':
        cell.attrib.pop('t', None)
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        cell.attrib['t'] = 'n'
        v = ET.SubElement(cell, f'{{{MAIN_NS}}}v')
        v.text = str(value)
    else:
        cell.attrib['t'] = 'inlineStr'
        inline = ET.SubElement(cell, f'{{{MAIN_NS}}}is')
        t = ET.SubElement(inline, f'{{{MAIN_NS}}}t')
        t.text = str(value)


def get_or_create_cell(row_node, col, row_num, style_source=None):
    ref = f'{col_name(col)}{row_num}'
    for cell in row_node.findall('m:c', NS):
        if cell.get('r') == ref: return cell
    cell = ET.Element(f'{{{MAIN_NS}}}c', {'r': ref})
    if style_source is not None and style_source.get('s') is not None:
        cell.set('s', style_source.get('s'))
    cells = row_node.findall('m:c', NS)
    inserted = False
    for index, existing in enumerate(cells):
        existing_col, _ = split_ref(existing.get('r'))
        if existing_col > col:
            row_node.insert(index, cell)
            inserted = True
            break
    if not inserted: row_node.append(cell)
    return cell


def clone_row(template_row, row_num):
    clone = ET.fromstring(ET.tostring(template_row, encoding='utf-8'))
    clone.set('r', str(row_num))
    for cell in clone.findall('m:c', NS):
        col, _ = split_ref(cell.get('r'))
        cell.set('r', f'{col_name(col)}{row_num}')
    return clone


def generate(template: Path, output: Path, payload):
    files = load_xlsx(template)
    schema = discover_schema(files)
    best = schema.get('best_sheet')
    if not best or not best.get('table'):
        raise RuntimeError('No checklist line table with at least 3 recognized columns was found.')

    sheet_path = best['path']
    root = ET.fromstring(files[sheet_path])
    sheet_data = root.find('m:sheetData', NS)
    table = best['table']
    header_row = table['header_row']
    data_start = table['data_start_row']
    columns = table['columns']
    rows_by_num = {int(row.get('r')): row for row in sheet_data.findall('m:row', NS)}
    template_row = rows_by_num.get(data_start)
    if template_row is None:
        template_row = ET.Element(f'{{{MAIN_NS}}}row', {'r': str(data_start)})
        sheet_data.append(template_row)

    line_rows = payload.get('lines') or []
    for offset, line in enumerate(line_rows):
        row_num = data_start + offset
        row_node = rows_by_num.get(row_num)
        if row_node is None:
            row_node = clone_row(template_row, row_num)
            sheet_data.append(row_node)
            rows_by_num[row_num] = row_node
        style_cells = {split_ref(cell.get('r'))[0]: cell for cell in template_row.findall('m:c', NS)}
        for field, col in columns.items():
            value = line.get(field)
            cell = get_or_create_cell(row_node, col, row_num, style_cells.get(col))
            set_cell_value(cell, value)

    # Fill simple metadata labels by writing the adjacent cell, preserving its style.
    strings = shared_strings(files)
    header = payload.get('header') or {}
    label_to_field = {
        'PO': 'order_no', 'PO NUMBER': 'order_no', 'ORDER NO': 'order_no',
        'CUSTOMER': 'customer_code', 'STORE': 'store_code', 'DIV': 'division_code',
        'DIVISION': 'division_code', 'TERMS': 'terms_code', 'WAREHOUSE': 'warehouse_code',
        'ORDER DATE': 'order_date', 'START DATE': 'start_date', 'CANCEL DATE': 'cancel_date'
    }
    for row_node in sheet_data.findall('m:row', NS):
        row_num = int(row_node.get('r'))
        if row_num == header_row: continue
        cells = row_node.findall('m:c', NS)
        for cell in cells:
            label = norm(cell_value(cell, strings))
            field = label_to_field.get(label)
            if not field or not header.get(field): continue
            col, _ = split_ref(cell.get('r'))
            target = get_or_create_cell(row_node, col + 1, row_num, cell)
            set_cell_value(target, header.get(field))

    # Keep rows ordered after clones.
    ordered = sorted(sheet_data.findall('m:row', NS), key=lambda node: int(node.get('r')))
    for node in list(sheet_data): sheet_data.remove(node)
    for node in ordered: sheet_data.append(node)

    max_row = max([int(node.get('r')) for node in ordered] or [1])
    max_col = max(columns.values() or [1])
    dimension = root.find('m:dimension', NS)
    if dimension is not None:
        dimension.set('ref', f'A1:{col_name(max_col)}{max_row}')

    files[sheet_path] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items(): archive.writestr(name, data)

    return {
        'output': str(output),
        'template': str(template),
        'sheet': best['name'],
        'line_count': len(line_rows),
        'image_count_preserved': schema['image_count'],
        'format_preserved': True,
        'print_layout_preserved': True,
    }


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    catalog = sub.add_parser('catalog')
    catalog.add_argument('--root', action='append', default=[])
    catalog.add_argument('--extract-dir', required=True)
    catalog.add_argument('--output', required=True)
    generate_p = sub.add_parser('generate')
    generate_p.add_argument('--template', required=True)
    generate_p.add_argument('--payload', required=True)
    generate_p.add_argument('--output', required=True)
    args = parser.parse_args()

    if args.command == 'catalog':
        templates = scan_roots(args.root, Path(args.extract_dir))
        result = {'template_count': len([t for t in templates if not t.get('error')]), 'templates': templates}
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps({'template_count': result['template_count'], 'output': str(args.output)}))
    else:
        payload = json.loads(Path(args.payload).read_text(encoding='utf-8'))
        result = generate(Path(args.template), Path(args.output), payload)
        print(json.dumps(result))

if __name__ == '__main__':
    main()
