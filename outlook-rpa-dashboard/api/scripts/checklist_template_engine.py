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
    'SPENCER': 'SPENCER', "SPENCER'S": 'SPENCER', 'SPENCER GIFTS': 'SPENCER',
    'TILLYS': 'TILLYS', "TILLY'S": 'TILLYS',
}

# CHECKLIST_CUSTOMER_ALIAS_V2
# Exact aliases observed in the historical checklist corpus.
# Workbook content is checked before folder/path names.
CUSTOMERS.update({
    'BEALLS DEPT': 'BEALLSDEPT',
    'BEALLS DEPARTMENT': 'BEALLSDEPT',
    'BELK': 'BELK',
    'BELK OUTLET': 'BELKOUTL',
    'BELKOUTL': 'BELKOUTL',
    'BLOOMINGDALE': 'BLOOMINGDALE',
    'BUCEES': 'BUCEES',
    'BURLINGTON': 'BURLINGTON',
    'BOSCOV': 'BOSCOV',
    'COAST GUARD': 'COASTGUARD',
    'COASTGUARD': 'COASTGUARD',
    'DD DISCOUNT': 'DDSDISCOUN',
    'DDDISCOUNT': 'DDSDISCOUN',
    'DDS DISCOUNTS': 'DDSDISCOUN',
    'DDSDISCOUNTS': 'DDSDISCOUN',
    'DDSDISCOUN': 'DDSDISCOUN',
    'DFA': 'DFA',
    'FACTORY': 'FACTORY',
    'FORMAN': 'FORMAN',
    'MCX': 'MCX',
    'MASON': 'MASON',
    'NAVY EXCHANGE': 'NAVYEXCHANGE',
    'ROSS STORES': 'ROSSSTORES',
    'ROSSSTORES': 'ROSSSTORES',
    'SHOPPERS WORLD': 'SHOPPERSWO',
    'SHOPPERSWO': 'SHOPPERSWO',
    'SIERRA': 'SIERRA',
    'SHOE SENSATION': 'SHOESENSATION',
    'UNITED FASHION': 'UNITEDFASH',
    'UNITEDFASH': 'UNITEDFASH',
    'WINNERS': 'WINNERS',
    'WALMART': 'WALMART',
    'MARSHA ECOM': 'MARSHALLS',
    'MARSHAECOM': 'MARSHALLS',
    'MTJX ECOMM': 'TJMAXX',
    'TJX ECOMM': 'TJMAXX',
})

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


# Added by V4.7.7.
# These are explicit approved workbook names whose names do not contain "check".
APPROVED_NON_CHECKLIST_FILENAMES = {
    'ITS FASHION PT 1747160-1747168 2.XLSX',
    'VERSONA PT 1764800.XLSX',
}

def is_candidate_template_name(value: str) -> bool:
    name = Path(value).name.upper()
    return (
        'CHECK' in name
        or name in APPROVED_NON_CHECKLIST_FILENAMES
    )


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


def canonical_schema_override(files, profile):
    override = (profile or {}).get('schema') or {}
    if not override:
        return None

    sheet_name = str(override.get('sheet_name') or '').strip()
    header_row = int(override.get('header_row') or 0)
    data_start_row = int(override.get('data_start_row') or (header_row + 1))
    raw_columns = override.get('columns') or {}
    columns = {}

    for field, column in raw_columns.items():
        if isinstance(column, int):
            columns[str(field)] = column
        elif isinstance(column, str) and column.strip():
            value = column.strip().upper()
            columns[str(field)] = int(value) if value.isdigit() else col_num(value)

    if not sheet_name or header_row < 1 or data_start_row <= header_row or not columns:
        raise RuntimeError('CHECKLIST_CANONICAL_SCHEMA_INVALID')

    sheet_map = {name: sheet_path for name, sheet_path in workbook_sheets(files)}
    sheet_path = sheet_map.get(sheet_name)
    if not sheet_path or sheet_path not in files:
        raise RuntimeError(f'CHECKLIST_CANONICAL_SHEET_NOT_FOUND:{sheet_name}')

    return {
        'name': sheet_name,
        'path': sheet_path,
        'table': {
            'header_row': header_row,
            'data_start_row': data_start_row,
            'columns': columns,
            'score': len(columns),
        },
        'cell_count': None,
        'schema_source': 'CANONICAL_CUSTOMER_REGISTRY',
    }


def load_xlsx(path: Path):
    with zipfile.ZipFile(path, 'r') as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def workbook_identity_text(files) -> str:
    values = []
    strings = shared_strings(files)
    values.extend(strings)
    for _, sheet_path in workbook_sheets(files):
        if sheet_path not in files:
            continue
        try:
            root = ET.fromstring(files[sheet_path])
        except Exception:
            continue
        for cell in root.findall('.//m:c', NS):
            value = cell_value(cell, strings)
            if value:
                values.append(value)
    return norm(' '.join(values))


def guess_customer(path: str):
    aliases = dict(CUSTOMERS)

    dynamic_path = (
        Path(__file__).resolve().parents[1]
        / 'checklists'
        / 'customer_aliases.json'
    )

    if dynamic_path.exists():
        try:
            dynamic = json.loads(
                dynamic_path.read_text(encoding='utf-8')
            )

            if isinstance(dynamic, dict):
                aliases.update(dynamic)
        except Exception:
            pass

    value = norm(path)
    compact_value = re.sub(
        r'[^A-Z0-9]+',
        '',
        str(path or '').upper()
    )

    for key in sorted(
        aliases,
        key=lambda item: len(norm(item)),
        reverse=True
    ):
        normalized = norm(key)
        compact_key = re.sub(
            r'[^A-Z0-9]+',
            '',
            str(key or '').upper()
        )

        if (
            normalized in value
            or (
                len(compact_key) >= 5
                and compact_key in compact_value
            )
        ):
            return aliases[key]

    return None

def scan_roots(roots, extract_dir: Path):
    templates = []
    seen_hashes = {}
    extract_dir.mkdir(parents=True, exist_ok=True)

    def add_file(path: Path, source):
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            files = load_xlsx(path)
            schema = discover_schema(files)
            customer_code = guess_customer(str(source), files)
            if digest in seen_hashes:
                existing = seen_hashes[digest]
                existing.setdefault('sources', [])
                if str(source) not in existing['sources']:
                    existing['sources'].append(str(source))
                existing.setdefault('customer_codes', [])
                if customer_code and customer_code not in existing['customer_codes']:
                    existing['customer_codes'].append(customer_code)
                if not existing.get('customer_code') and len(existing['customer_codes']) == 1:
                    existing['customer_code'] = existing['customer_codes'][0]
                return
            entry = {
                'template_id': digest[:16],
                'customer_code': customer_code,
                'customer_codes': [customer_code] if customer_code else [],
                'source': str(source),
                'sources': [str(source)],
                'template_path': str(path),
                'extension': path.suffix.lower(),
                'size_bytes': path.stat().st_size,
                'sha256': digest,
                'image_count': schema['image_count'],
                'sheets': schema['sheets'],
                'best_sheet': schema['best_sheet'],
            }
            seen_hashes[digest] = entry
            templates.append(entry)
        except Exception as error:
            templates.append({'source': str(source), 'error': str(error)})

    for root_value in roots:
        root = Path(root_value)
        if not root.exists(): continue
        if root.is_dir():
            for path in root.rglob('*'):
                if path.suffix.lower() in {'.xlsx', '.xlsm', '.xltx'} and is_candidate_template_name(str(path)):
                    add_file(path, path)
        elif root.suffix.lower() == '.zip':
            archive_hash = hashlib.sha256(root.read_bytes()).hexdigest()[:16]
            with zipfile.ZipFile(root, 'r') as archive:
                for member in archive.namelist():
                    if Path(member).suffix.lower() not in {'.xlsx', '.xlsm', '.xltx'}: continue
                    if not is_candidate_template_name(member): continue
                    target = extract_dir / archive_hash / Path(member).name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as source, target.open('wb') as destination:
                        shutil.copyfileobj(source, destination)
                    add_file(target, f'{root}!{member}')

    return templates


def non_empty(value):
    return value is not None and (not isinstance(value, str) or value.strip() != '')


def line_field_value(field, line, header):
    if field.startswith('qty_sz'):
        direct = line.get(field)
        if non_empty(direct):
            return direct
        suffix = field.replace('qty_sz', '')
        return (line.get('qty_buckets') or {}).get(f'QTY_SZ{suffix}')

    value = line.get(field)
    if non_empty(value):
        return value

    if field == 'line_warehouse_code':
        return line.get('warehouse_code') or header.get('warehouse_code')

    if field in {
        'customer_code', 'order_no', 'order_date', 'start_date',
        'cancel_date', 'store_code', 'division_code', 'terms_code',
        'warehouse_code', 'dept_code', 'ship_via', 'pick_ticket_no',
        'tickets', 'tracking', 'dc_name'
    }:
        return header.get(field)

    return None


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



ROOT_NAMESPACE_PATTERN = re.compile(
    rb'\sxmlns(?::([A-Za-z_][\w.-]*))?="([^"]+)"'
)


def root_namespace_declarations(xml_bytes):
    root_match = re.search(
        rb'<(?:[A-Za-z_][\w.-]*:)?worksheet\b[^>]*>',
        xml_bytes[: min(len(xml_bytes), 16000)]
    )
    if not root_match:
        return []

    output = []
    for match in ROOT_NAMESPACE_PATTERN.finditer(root_match.group(0)):
        prefix = (
            match.group(1).decode('utf-8')
            if match.group(1)
            else ''
        )
        uri = match.group(2).decode('utf-8')
        output.append((prefix, uri))
    return output


def serialize_worksheet_preserving_namespaces(original_bytes, root):
    declarations = root_namespace_declarations(original_bytes)

    for prefix, uri in declarations:
        if prefix in {'xml', 'xmlns'}:
            continue
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            pass

    serialized = ET.tostring(
        root,
        encoding='utf-8',
        xml_declaration=False
    ).decode('utf-8')

    root_match = re.search(
        r'<(?:[A-Za-z_][\w.-]*:)?worksheet\b[^>]*>',
        serialized
    )
    if not root_match:
        raise RuntimeError('WORKSHEET_ROOT_TAG_NOT_FOUND')

    root_tag = root_match.group(0)
    missing = []

    for prefix, uri in declarations:
        declaration = (
            f'xmlns:{prefix}="{uri}"'
            if prefix
            else f'xmlns="{uri}"'
        )
        if declaration not in root_tag:
            missing.append(f' {declaration}')

    if missing:
        insert_at = root_match.end() - 1
        serialized = (
            serialized[:insert_at]
            + ''.join(missing)
            + serialized[insert_at:]
        )

    final_root = re.search(
        r'<(?:[A-Za-z_][\w.-]*:)?worksheet\b[^>]*>',
        serialized
    ).group(0)

    ignorable = re.search(
        r'(?:mc:|[A-Za-z_][\w.-]*:)Ignorable="([^"]+)"',
        final_root
    )

    if ignorable:
        for prefix in ignorable.group(1).split():
            if f'xmlns:{prefix}=' not in final_root:
                raise RuntimeError(
                    f'UNDECLARED_IGNORABLE_NAMESPACE:{prefix}'
                )

    return (
        '<?xml version="1.0" encoding="UTF-8" '
        'standalone="yes"?>\n'
        + serialized
    ).encode('utf-8')


def mapped_cell_value(row_node, mapped_columns, strings):
    for cell in row_node.findall('m:c', NS):
        col, _ = split_ref(cell.get('r'))
        if col not in mapped_columns:
            continue
        if cell_value(cell, strings) != '':
            return True
    return False


def historical_data_end(
    rows_by_num,
    data_start,
    mapped_columns,
    strings
):
    maximum = max(rows_by_num.keys() or [data_start])
    last_data = data_start - 1
    seen_data = False
    blank_streak = 0

    for row_num in range(data_start, maximum + 1):
        row_node = rows_by_num.get(row_num)
        has_data = (
            row_node is not None
            and mapped_cell_value(
                row_node,
                mapped_columns,
                strings
            )
        )

        if has_data:
            seen_data = True
            last_data = row_num
            blank_streak = 0
            continue

        if seen_data:
            blank_streak += 1
            if blank_streak >= 2:
                break

    return max(last_data, data_start)


def clear_mapped_cells(row_node, mapped_columns):
    for cell in row_node.findall('m:c', NS):
        col, _ = split_ref(cell.get('r'))
        if col in mapped_columns:
            set_cell_value(cell, None)


def set_row_visibility(row_node, visible):
    if visible:
        row_node.attrib.pop('hidden', None)
    else:
        row_node.set('hidden', '1')


def metadata_value(header, *names):
    for name in names:
        value = header.get(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ''


def apply_header_metadata(
    sheet_data,
    strings,
    header,
    header_row
):
    label_to_field = {
        'PO': 'order_no',
        'PO NUMBER': 'order_no',
        'ORDER NO': 'order_no',
        'CUSTOMER': 'customer_code',
        'STORE': 'store_code',
        'DIV': 'division_code',
        'DIVISION': 'division_code',
        'TERMS': 'terms_code',
        'WAREHOUSE': 'warehouse_code',
        'ORDER DATE': 'order_date',
        'START DATE': 'start_date',
        'CANCEL DATE': 'cancel_date',
    }

    for row_node in sheet_data.findall('m:row', NS):
        row_num = int(row_node.get('r'))
        if row_num >= header_row:
            continue

        cells = row_node.findall('m:c', NS)

        for cell in cells:
            original = cell_value(cell, strings)
            label = norm(original)
            col, _ = split_ref(cell.get('r'))

            field = label_to_field.get(label)
            if field and header.get(field):
                target = get_or_create_cell(
                    row_node,
                    col + 1,
                    row_num,
                    cell
                )
                set_cell_value(target, header.get(field))
                continue

            if re.match(r'^PT(?:\s|#|$)', label):
                pt_number = metadata_value(
                    header,
                    'pick_ticket_no',
                    'pt_no',
                    'pick_ticket'
                )
                set_cell_value(
                    cell,
                    f'PT# {pt_number}' if pt_number else 'PT#'
                )
                continue

            if re.match(r'^PO(?:\s|#|$)', label):
                order_no = metadata_value(header, 'order_no')
                if order_no:
                    set_cell_value(cell, f'PO# {order_no}')
                continue

            if 'SHIP VIA' in label and 'SHIP DATE' in label:
                ship_via = metadata_value(
                    header,
                    'ship_via',
                    'ship_via_code'
                )
                ship_date = metadata_value(
                    header,
                    'ship_date',
                    'start_date'
                )
                display = ' · '.join(
                    value
                    for value in [ship_via, ship_date]
                    if value
                )

                right_cells = []
                for candidate in cells:
                    candidate_col, _ = split_ref(
                        candidate.get('r')
                    )
                    if candidate_col <= col:
                        continue
                    right_cells.append((
                        candidate_col,
                        candidate,
                        cell_value(candidate, strings)
                    ))

                non_empty = [
                    item
                    for item in right_cells
                    if str(item[2]).strip()
                ]

                if non_empty:
                    target_col, target, _ = non_empty[-1]
                else:
                    target_col = col + 2
                    target = get_or_create_cell(
                        row_node,
                        target_col,
                        row_num,
                        cell
                    )

                set_cell_value(target, display)


def set_active_cell_to_a1(root):
    sheet_view = root.find('m:sheetViews/m:sheetView', NS)
    if sheet_view is None:
        return

    selection = sheet_view.find('m:selection', NS)
    if selection is None:
        selection = ET.SubElement(
            sheet_view,
            f'{{{MAIN_NS}}}selection'
        )

    selection.set('activeCell', 'A1')
    selection.set('sqref', 'A1')


def update_print_area(files, sheet_name, last_row):
    workbook_path = 'xl/workbook.xml'
    if workbook_path not in files:
        return

    text = files[workbook_path].decode('utf-8')
    pattern = re.compile(
        r'(<definedName\b[^>]*'
        r'name="_xlnm\.Print_Area"[^>]*>)'
        r'(?P<area>.*?)'
        r'(</definedName>)'
    )

    def replace(match):
        area = match.group('area')
        area_match = re.match(
            r'(?P<sheet>.+?)!'
            r'\$(?P<c1>[A-Z]+)\$(?P<r1>\d+):'
            r'\$(?P<c2>[A-Z]+)\$(?P<r2>\d+)',
            area
        )
        if not area_match:
            return match.group(0)

        sheet_token = area_match.group('sheet')
        normalized_sheet = sheet_token.strip("'").replace("''", "'")
        if normalized_sheet != sheet_name:
            return match.group(0)

        end_row = max(
            int(area_match.group('r1')),
            int(last_row)
        )
        new_area = (
            f'{sheet_token}!'
            f'${area_match.group("c1")}'
            f'${area_match.group("r1")}:'
            f'${area_match.group("c2")}'
            f'${end_row}'
        )

        return (
            match.group(1)
            + new_area
            + match.group(3)
        )

    files[workbook_path] = pattern.sub(
        replace,
        text
    ).encode('utf-8')


def generate(template: Path, output: Path, payload):
    files = load_xlsx(template)
    discovered_schema = discover_schema(files)
    template_profile = payload.get('template_profile') or {}
    override = canonical_schema_override(files, template_profile)
    best = override or discovered_schema.get('best_sheet')
    schema_source = (
        'CANONICAL_CUSTOMER_REGISTRY'
        if override
        else 'GENERIC_HEADER_DISCOVERY'
    )
    schema = {
        **discovered_schema,
        'best_sheet': best,
    }

    if not best or not best.get('table'):
        raise RuntimeError(
            'No checklist line table with at least '
            '3 recognized columns was found.'
        )

    sheet_path = best['path']
    original_sheet_bytes = files[sheet_path]
    root = ET.fromstring(original_sheet_bytes)
    sheet_data = root.find('m:sheetData', NS)

    if sheet_data is None:
        raise RuntimeError('CHECKLIST_SHEET_DATA_NOT_FOUND')

    table = best['table']
    header_row = table['header_row']
    data_start = table['data_start_row']
    columns = table['columns']
    mapped_columns = set(columns.values())
    strings = shared_strings(files)

    rows_by_num = {
        int(row.get('r')): row
        for row in sheet_data.findall('m:row', NS)
    }

    template_row = rows_by_num.get(data_start)
    if template_row is None:
        template_row = ET.Element(
            f'{{{MAIN_NS}}}row',
            {'r': str(data_start)}
        )
        sheet_data.append(template_row)
        rows_by_num[data_start] = template_row

    original_data_end = historical_data_end(
        rows_by_num,
        data_start,
        mapped_columns,
        strings
    )

    for row_num in range(
        data_start,
        original_data_end + 1
    ):
        row_node = rows_by_num.get(row_num)
        if row_node is None:
            continue
        clear_mapped_cells(row_node, mapped_columns)
        set_row_visibility(row_node, False)

    header = payload.get('header') or {}
    line_rows = payload.get('lines') or []
    style_cells = {
        split_ref(cell.get('r'))[0]: cell
        for cell in template_row.findall('m:c', NS)
    }

    for offset, line in enumerate(line_rows):
        row_num = data_start + offset
        row_node = rows_by_num.get(row_num)

        if row_node is None:
            row_node = clone_row(template_row, row_num)
            sheet_data.append(row_node)
            rows_by_num[row_num] = row_node

        set_row_visibility(row_node, True)
        clear_mapped_cells(row_node, mapped_columns)

        for field, col in columns.items():
            value = line_field_value(field, line, header)
            cell = get_or_create_cell(
                row_node,
                col,
                row_num,
                style_cells.get(col)
            )
            set_cell_value(cell, value)

    apply_header_metadata(
        sheet_data,
        strings,
        header,
        header_row
    )
    set_active_cell_to_a1(root)

    ordered = sorted(
        sheet_data.findall('m:row', NS),
        key=lambda node: int(node.get('r'))
    )

    for node in list(sheet_data):
        sheet_data.remove(node)

    for node in ordered:
        sheet_data.append(node)

    last_visible_row = (
        data_start + len(line_rows) - 1
        if line_rows
        else header_row
    )

    update_print_area(
        files,
        best['name'],
        last_visible_row
    )

    files[sheet_path] = (
        serialize_worksheet_preserving_namespaces(
            original_sheet_bytes,
            root
        )
    )

    output.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(
        output,
        'w',
        zipfile.ZIP_DEFLATED
    ) as archive:
        for name, data in files.items():
            archive.writestr(name, data)

    return {
        'output': str(output),
        'template': str(template),
        'sheet': best['name'],
        'schema_source': schema_source,
        'column_map': columns,
        'line_count': len(line_rows),
        'historical_rows_cleared': max(
            0,
            original_data_end - data_start + 1
        ),
        'unused_template_rows_hidden': max(
            0,
            original_data_end
            - data_start
            - len(line_rows)
            + 1
        ),
        'image_count_preserved': schema['image_count'],
        'format_preserved': True,
        'print_layout_preserved': True,
        'excel_namespace_compatibility': True,
        'original_dimension_preserved': True,
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
