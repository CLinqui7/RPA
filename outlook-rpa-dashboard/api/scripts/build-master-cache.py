#!/usr/bin/env python3
import csv, re, sys
from pathlib import Path
try:
    from openpyxl import load_workbook
except Exception:
    print('ERROR: openpyxl is required. Run: python3 -m pip install openpyxl', file=sys.stderr)
    raise

def clean(v): return '' if v is None else str(v).replace('\u00a0',' ').strip()
def norm(v): return re.sub(r'[^A-Z0-9]', '', clean(v).upper())
def parse_csv_line(line): return next(csv.reader([line]))

def row_values_from_xlsx(path):
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    for row in ws.iter_rows(values_only=True):
        vals = [clean(v) for v in row]
        if not any(vals): continue
        if len(vals)==1 or (vals[0].count(',')>3 and not any(vals[1:])):
            try: yield parse_csv_line(vals[0])
            except Exception: yield [vals[0]]
        else:
            yield vals

def dict_rows_from_xlsx(path):
    it=iter(row_values_from_xlsx(path))
    try: header=[clean(x) for x in next(it)]
    except StopIteration: return
    for vals in it:
        if not any(clean(v) for v in vals): continue
        yield {h: clean(vals[i]) if i<len(vals) else '' for i,h in enumerate(header)}

def dict_rows_from_csv(path):
    raw=Path(path).read_bytes(); text=None
    for enc in ('utf-8-sig','latin1','cp1252'):
        try: text=raw.decode(enc); break
        except Exception: pass
    if text is None: text=raw.decode('latin1',errors='replace')
    rows=csv.reader(text.splitlines())
    try: header=[clean(x) for x in next(rows)]
    except StopIteration: return
    for vals in rows:
        if not any(clean(v) for v in vals): continue
        yield {h: clean(vals[i]) if i<len(vals) else '' for i,h in enumerate(header)}

def iter_table(master_dir,*names):
    for name in names:
        p=Path(master_dir)/name
        if p.exists():
            print(f'Loading {p.name}...', flush=True)
            if p.suffix.lower()=='.csv': return dict_rows_from_csv(p), str(p)
            return dict_rows_from_xlsx(p), str(p)
    return iter(()), None

def write_csv(path, headers, rows):
    with Path(path).open('w', newline='', encoding='utf-8') as f:
        w=csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for row in rows:
            w.writerow({h: row.get(h,'') for h in headers})

def main():
    master_dir=Path(sys.argv[1] if len(sys.argv)>1 else 'api/masters').resolve()
    out_dir=master_dir/'cache'
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f'Building compact master cache from: {master_dir}', flush=True)

    customer_iter,_=iter_table(master_dir,'customer_master.csv.xlsx','customer_master.xlsx','customer_master.csv')
    store_iter,_=iter_table(master_dir,'stores_master.csv','stores_master.csv.xlsx','stores_master.xlsx')
    sku_iter,_=iter_table(master_dir,'VR_SKU.xlsx')
    upc_iter,_=iter_table(master_dir,'VR_UPC_STYLE.xlsx')
    color_iter,_=iter_table(master_dir,'VR_COLOR.xlsx')
    whse_iter,_=iter_table(master_dir,'whse_master.csv','warehouse_master.csv','whse_master.xlsx','whse_master.csv.xlsx')

    print('Writing customers...', flush=True)
    customers=[]; c_count=0
    for r in customer_iter:
        c_count += 1
        code=clean(r.get('Customer')).upper()
        if not code: continue
        customers.append({'customer':code,'name':clean(r.get('Cust Name')),'name_norm':norm(r.get('Cust Name')),'terms':clean(r.get('Terms')),'terms_description':clean(r.get('Terms Description')),'ship_via':clean(r.get('Ship Via')),'def_wh':clean(r.get('Def Wh')),'div':clean(r.get('Div')),'active':clean(r.get('Active')),'addr1':clean(r.get('Addr 1')),'city':clean(r.get('City')),'state':clean(r.get('State')),'postal':clean(r.get('Postal'))})
    write_csv(out_dir/'customers.csv', ['customer','name','name_norm','terms','terms_description','ship_via','def_wh','div','active','addr1','city','state','postal'], customers)

    print('Writing stores...', flush=True)
    stores=[]; s_count=0
    for r in store_iter:
        s_count += 1
        customer=clean(r.get('Customer')).upper(); store=clean(r.get('Store')).upper()
        if not customer or not store: continue
        stores.append({'customer':customer,'store':store,'name':clean(r.get('St Name')),'addr1':clean(r.get('St Addr 1')),'city':clean(r.get('St City')),'state':clean(r.get('St State')),'postal':clean(r.get('St Postal')),'ship_via':clean(r.get('Ship Via')),'wh':clean(r.get('Wh')),'active':clean(r.get('Active'))})
    write_csv(out_dir/'stores.csv', ['customer','store','name','addr1','city','state','postal','ship_via','wh','active'], stores)

    print('Writing SKU compact...', flush=True)
    sku_headers=['style','clr','style_descr','clr_desc','clr_abbr','sku','sku_descr','scale','scale_abbr','div','customer','master_style','style_alias','invoice_descr','price','style_norm','master_style_norm','style_alias_norm']
    sku_path=out_dir/'sku.csv'
    sku_count=0; known_styles=set()
    with sku_path.open('w', newline='', encoding='utf-8') as f:
        w=csv.DictWriter(f, fieldnames=sku_headers); w.writeheader()
        for r in sku_iter:
            sku_count += 1
            style=clean(r.get('Style')).upper(); clr=clean(r.get('Clr')).upper()
            if not style: continue
            known_styles.add(style)
            row={'style':style,'clr':clr,'style_descr':clean(r.get('Style Descr')),'clr_desc':clean(r.get('Clr Desc')),'clr_abbr':clean(r.get('Clr Abbr')),'sku':clean(r.get('Sku')),'sku_descr':clean(r.get('Sku Descr')),'scale':clean(r.get('Scale')),'scale_abbr':clean(r.get('Scale Abbr')),'div':clean(r.get('Div')),'customer':clean(r.get('Customer')).upper() or 'STOCK','master_style':clean(r.get('Master Style')),'style_alias':clean(r.get('Style Alias')),'invoice_descr':clean(r.get('Invoice Descr')),'price':clean(r.get('Price')),'style_norm':norm(style),'master_style_norm':norm(r.get('Master Style')),'style_alias_norm':norm(r.get('Style Alias'))}
            w.writerow(row)

    print('Writing UPC compact...', flush=True)
    upc_headers=['style','clr','upc','size_name','size_num','sku','div','scale','scale_abbr','size_norm']
    upc_count=0
    with (out_dir/'upc.csv').open('w', newline='', encoding='utf-8') as f:
        w=csv.DictWriter(f, fieldnames=upc_headers); w.writeheader()
        for r in upc_iter:
            upc_count += 1
            style=clean(r.get('Style')).upper(); clr=clean(r.get('Clr')).upper(); upc=clean(r.get('Upc No'))
            if not style or not clr or not upc or style not in known_styles: continue
            size_name=clean(r.get('Size Name')); size_num=clean(r.get('Size Num'))
            w.writerow({'style':style,'clr':clr,'upc':upc,'size_name':size_name,'size_num':size_num,'sku':clean(r.get('Sku')),'div':clean(r.get('Div')),'scale':clean(r.get('Scale')),'scale_abbr':clean(r.get('Scale Abbr')),'size_norm':norm(size_name or size_num)})

    print('Writing colors...', flush=True)
    colors=[]; color_count=0
    for r in color_iter:
        color_count += 1
        code=clean(r.get('Color Code')).upper()
        if code: colors.append({'code':code,'abbr':clean(r.get('Color Abbr')),'description':clean(r.get('Color Description')),'nrf':clean(r.get('Nrf Color No')),'active':clean(r.get('Active'))})
    write_csv(out_dir/'colors.csv', ['code','abbr','description','nrf','active'], colors)

    print('Writing warehouses...', flush=True)
    warehouses=[]; whse_count=0
    for r in whse_iter:
        whse_count += 1
        code=clean(r.get('Wh')).upper()
        if not code: continue
        warehouses.append({'wh':code,'name':clean(r.get('Wh Name')),'type':clean(r.get('Wh Type')),'addr1':clean(r.get('Wh Addr 1')),'addr2':clean(r.get('Wh Addr 2')),'city':clean(r.get('Wh City')),'state':clean(r.get('Wh State')),'postal':clean(r.get('Wh Postal')),'country':clean(r.get('Wh Country')),'active':clean(r.get('Wh Active'))})
    write_csv(out_dir/'warehouses.csv', ['wh','name','type','addr1','addr2','city','state','postal','country','active'], warehouses)

    manifest={'version':3,'counts':{'customers':c_count,'stores':s_count,'sku_rows':sku_count,'upc_rows':upc_count,'colors':color_count,'warehouses':whse_count}}
    (out_dir/'manifest.json').write_text(__import__('json').dumps(manifest, indent=2), encoding='utf-8')
    print(f'Wrote compact cache to: {out_dir}', flush=True)
    print('Counts:', manifest['counts'], flush=True)

if __name__=='__main__': main()
