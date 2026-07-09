from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

BASE = os.getenv("A2000_BASE_URL", "").rstrip("/")
CLIENT_ID = os.getenv("A2000_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("A2000_CLIENT_SECRET", "")
CLIENT_NAME = os.getenv("A2000_CLIENT_NAME", "Linqui")
WRITE_TESTS = os.getenv("A2000_WRITE_TESTS", "0") == "1"
DESTRUCTIVE_PROBES = os.getenv("A2000_DESTRUCTIVE_PROBES", "0") == "1"
SOURCE_CTRL_NO = int(os.getenv("A2000_SOURCE_CTRL_NO", "3757166"))

PROJECT = Path("/workspaces/RPA/outlook-rpa-dashboard")
CSV_JS = PROJECT / "api/src/a2000/csv.js"
ROOT = PROJECT / "api/training/a2000_preprod_certification"
RUN_ID = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
RUN = ROOT / f"cert_{RUN_ID}"
RUN.mkdir(parents=True, exist_ok=True)

TOKEN = ""
TESTS: list[dict[str, Any]] = []
FACTS: dict[str, Any] = {}
RAW_INDEX: list[dict[str, Any]] = []


def emit(text: str = "") -> None:
    print(text, flush=True)


def save_text(name: str, text: str) -> Path:
    path = RUN / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def save_json(name: str, value: Any) -> Path:
    return save_text(name, json.dumps(value, indent=2, ensure_ascii=False, default=str))


def parse_json_with_duplicates(raw: str) -> tuple[Any | None, list[str]]:
    duplicates: list[str] = []

    def hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        counts = Counter(key for key, _ in pairs)
        duplicates.extend(key for key, count in counts.items() if count > 1)
        result: dict[str, Any] = {}
        for key, value in pairs:
            result[key] = value
        return result

    try:
        body = json.loads(raw, object_pairs_hook=hook)
        return body, sorted(set(duplicates))
    except Exception:
        return None, []


def http_call(
    method: str,
    path: str,
    payload: Any | None = None,
    *,
    basic: bool = False,
    label: str,
) -> tuple[int, str, Any | None, list[str], dict[str, str]]:
    url = f"{BASE}{path}"
    headers: dict[str, str] = {"Accept": "application/json"}
    data: bytes | None = None

    if basic:
        credentials = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
        headers["Authorization"] = f"Basic {credentials}"
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urllib.parse.urlencode(payload or {}).encode()
    else:
        headers["Authorization"] = f"Bearer {TOKEN}"
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, ensure_ascii=False).encode()
            save_json(f"requests/{label}.json", payload)

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    response_headers: dict[str, str] = {}

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            status = response.status
            raw = response.read().decode("utf-8", errors="replace")
            response_headers = {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read().decode("utf-8", errors="replace")
        response_headers = {k.lower(): v for k, v in exc.headers.items()}
    except Exception as exc:
        status = 0
        raw = repr(exc)

    save_text(f"responses/{label}.raw.txt", raw)
    body, duplicates = parse_json_with_duplicates(raw)
    if body is not None:
        save_json(f"responses/{label}.parsed.json", body)

    RAW_INDEX.append({
        "label": label,
        "method": method,
        "path": path,
        "http_status": status,
        "content_type": response_headers.get("content-type"),
        "duplicate_keys": duplicates,
        "response_bytes": len(raw.encode("utf-8")),
    })

    return status, raw, body, duplicates, response_headers


def add_test(
    test_id: str,
    purpose: str,
    result: str,
    *,
    finding: str,
    actual: Any = None,
    risk: str = "NONE",
) -> None:
    row = {
        "test_id": test_id,
        "purpose": purpose,
        "write_risk": risk,
        "result": result,
        "finding": finding,
        "actual": actual,
    }
    TESTS.append(row)
    emit(f"{test_id} | {result} | {purpose}")
    emit(f"  FINDING: {finding}")
    if actual is not None:
        emit(f"  ACTUAL: {actual}")


def viewer(
    name: str,
    columns: list[str],
    filter_sql: str,
    sort: str,
    *,
    label: str,
) -> tuple[int, Any | None, list[dict[str, Any]]]:
    payload = {
        "COLUMNS": ", ".join(columns),
        "FILTER": filter_sql,
        "SORT": sort,
    }
    status, _, body, _, _ = http_call(
        "POST",
        f"/api/viewers/view/{name}",
        payload,
        label=label,
    )
    rows = body.get(name, []) if isinstance(body, dict) else []
    if not isinstance(rows, list):
        rows = []
    return status, body, rows


def upload(
    upload_id: str,
    payload: dict[str, Any],
    *,
    label: str,
) -> tuple[int, str, Any | None, list[str]]:
    status, raw, body, duplicates, _ = http_call(
        "POST",
        f"/api/uploads/upload/{upload_id}",
        payload,
        label=label,
    )
    return status, raw, body, duplicates


def numeric(value: Any) -> float:
    try:
        return float(str(value).replace(",", ""))
    except Exception:
        return 0.0


def extract_js_array(text: str, const_name: str) -> list[str]:
    pattern = rf"export\s+const\s+{re.escape(const_name)}\s*=\s*\[(.*?)\]\s*;"
    match = re.search(pattern, text, re.S)
    if not match:
        return []
    return re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))


def group_rest_logs(rows: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        value = row.get("UTREST_LOG_NO")
        if value is None:
            continue
        try:
            groups[int(value)].append(row)
        except Exception:
            continue
    return dict(groups)


def log_messages(rows: list[dict[str, Any]]) -> list[str]:
    return [str(row.get("MESSAGE")) for row in rows if row.get("MESSAGE") not in (None, "")]


def latest_log_group(endpoint: str, *, label: str) -> tuple[int | None, list[dict[str, Any]]]:
    status, _, rows = viewer(
        "VR_UTREST_LOG",
        [
            "UTREST_LOG_NO", "MODULE", "ENDPOINT", "PAYLOAD_SIZE", "MESSAGE",
            "CLIENT_NAME", "CLIENT_OWNER", "ENTRY_DATE", "ENTRY_TIME",
        ],
        f"CLIENT_NAME = '{CLIENT_NAME}' AND MODULE = 'UPLOADS' AND ENDPOINT = '{endpoint}'",
        "UTREST_LOG_NO",
        label=label,
    )
    if status != 200:
        return None, []
    groups = group_rest_logs(rows)
    if not groups:
        return None, []
    latest = max(groups)
    return latest, groups[latest]


def make_order_no(tag: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%y%m%d%H%M%S")
    return f"CERT{tag}{stamp}"[:25]


def current_dates() -> tuple[str, str, str]:
    now = datetime.now(timezone.utc)
    return (
        now.strftime("%m/%d/%y"),
        (now + timedelta(days=7)).strftime("%m/%d/%y"),
        (now + timedelta(days=14)).strftime("%m/%d/%y"),
    )


def build_header_row(source_header: dict[str, Any], order_no: str) -> dict[str, Any]:
    order_date, start_date, cancel_date = current_dates()
    row: dict[str, Any] = {
        "CUST_NO": source_header["CUSTOMER"],
        "STORE_NO": str(source_header["STORE"]),
        "ORDER_NO": order_no,
        "ORDER_DATE": order_date,
        "START_DATE": start_date,
        "CANCEL_DATE": cancel_date,
        "DIV_NO": source_header["DIV"],
        "TERM_NO": source_header["TERMS"],
    }
    if source_header.get("SHIP_VIA"):
        row["SHIP_VIA_NO"] = source_header["SHIP_VIA"]
    if source_header.get("DEF_WH"):
        row["DEF_WHOUSE"] = source_header["DEF_WH"]
    if source_header.get("ORDER_TYPE"):
        row["ORDER_TYPE"] = source_header["ORDER_TYPE"]
    return row


def pick_source_line(
    rows: list[dict[str, Any]],
    *,
    skip: set[tuple[str, str]] | None = None,
) -> tuple[dict[str, Any] | None, int | None]:
    skip = skip or set()
    for row in rows:
        style = row.get("STYLE")
        color = row.get("CLR")
        if not style or color in (None, ""):
            continue
        if (str(style), str(color)) in skip:
            continue
        for index in range(1, 19):
            if numeric(row.get(f"OPEN_SZ{index}")) > 0:
                return row, index
    return None, None


def build_line_row(
    *,
    seq_order_no: int,
    order_no: str,
    source_header: dict[str, Any],
    source_line: dict[str, Any],
    size_bucket: int,
    line_no: int,
) -> dict[str, Any]:
    price = source_line.get("PRICE")
    if numeric(price) <= 0:
        price = 1
    return {
        "SEQ_ORDER_NO": int(seq_order_no),
        "LINE_NO": int(line_no),
        "CUST_NO": source_header["CUSTOMER"],
        "STORE_NO": str(source_header["STORE"]),
        "ORDER_NO": order_no,
        "STYLE": source_line["STYLE"],
        "COLOR_NO": source_line["CLR"],
        "SALES_PRICE": price,
        "WHOUSE": source_line.get("WH") or source_header.get("DEF_WH"),
        f"QTY_SZ{size_bucket}": 1,
    }


def create_header(
    source_header: dict[str, Any],
    order_no: str,
    *,
    label: str,
) -> tuple[Any | None, int | None, list[dict[str, Any]]]:
    before_status, _, before_rows = viewer(
        "VR_ORDER_HD",
        ["CTRL_NO", "CUSTOMER", "ORDER_NO", "STORE", "DIV", "STATUS"],
        f"ORDER_NO = '{order_no}'",
        "CTRL_NO",
        label=f"{label}_before",
    )
    if before_status != 200 or before_rows:
        return None, None, before_rows

    payload = {"IGNORE_ERRORS": "N", "ORDER_HD": [build_header_row(source_header, order_no)]}
    status, _, body, _ = upload("ORDER_HD", payload, label=f"{label}_upload")

    seq: int | None = None
    if (
        status == 200
        and isinstance(body, dict)
        and body.get("status") == "Success"
        and numeric(body.get("updated")) > 0
        and isinstance(body.get("data"), list)
        and body["data"]
        and body["data"][0].get("SEQ_ORDER_NO") is not None
    ):
        seq = int(body["data"][0]["SEQ_ORDER_NO"])

    after_rows: list[dict[str, Any]] = []
    if seq is not None:
        _, _, after_rows = viewer(
            "VR_ORDER_HD",
            [
                "CTRL_NO", "CUSTOMER", "ORDER_NO", "STORE", "DIV", "TERMS",
                "DEF_WH", "SHIP_VIA", "STATUS",
            ],
            f"CTRL_NO = {seq} AND ORDER_NO = '{order_no}'",
            "CTRL_NO",
            label=f"{label}_after",
        )

    return body, seq, after_rows


def report_markdown() -> str:
    lines = [
        "# A2000 PRE-PRODUCTION CERTIFICATION REPORT",
        "",
        f"- Run ID: `{RUN_ID}`",
        f"- Base URL: `{BASE}`",
        f"- Write tests: `{WRITE_TESTS}`",
        f"- Destructive probes: `{DESTRUCTIVE_PROBES}`",
        f"- Source CTRL_NO: `{SOURCE_CTRL_NO}`",
        "",
        "## Test matrix",
        "",
        "| Test ID | Result | Risk | Purpose | Finding |",
        "|---|---|---|---|---|",
    ]
    for test in TESTS:
        purpose = str(test["purpose"]).replace("|", "\\|").replace("\n", " ")
        finding = str(test["finding"]).replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| {test['test_id']} | {test['result']} | {test['write_risk']} | {purpose} | {finding} |"
        )
    lines.extend([
        "",
        "## Facts",
        "",
        "```json",
        json.dumps(FACTS, indent=2, ensure_ascii=False, default=str),
        "```",
        "",
        "## Raw response index",
        "",
        "```json",
        json.dumps(RAW_INDEX, indent=2, ensure_ascii=False, default=str),
        "```",
    ])
    return "\n".join(lines) + "\n"


# ============================================================
# CERT-000 ENVIRONMENT AND SAFETY
# ============================================================

emit("============================================================")
emit("A2000 PRE-PRODUCTION CERTIFICATION SUITE")
emit("============================================================")
emit(f"RUN_ID={RUN_ID}")
emit(f"RUN_DIR={RUN}")
emit(f"WRITE_TESTS={WRITE_TESTS}")
emit(f"DESTRUCTIVE_PROBES={DESTRUCTIVE_PROBES}")
emit(f"BASE_URL_SET={bool(BASE)}")
emit(f"CLIENT_ID_SET={bool(CLIENT_ID)}")
emit(f"CLIENT_SECRET_SET={bool(CLIENT_SECRET)}")
emit("SECRETS_WILL_NOT_BE_PRINTED=YES")

if not BASE or not CLIENT_ID or not CLIENT_SECRET:
    add_test(
        "CERT-000", "Environment and secret presence", "FAIL",
        finding="Missing A2000_BASE_URL, A2000_CLIENT_ID or A2000_CLIENT_SECRET.",
    )
    save_json("test_matrix.json", TESTS)
    save_text("CERTIFICATION_REPORT.md", report_markdown())
    sys.exit(2)

if WRITE_TESTS:
    safe_test = "amextest.a2000cloud.com" in BASE.lower() and "/ords/amxtest" in BASE.lower()
    if not safe_test:
        add_test(
            "CERT-000", "Environment write safety guard", "FAIL",
            finding=f"WRITE TESTS BLOCKED outside AMEXTEST. BASE={BASE}",
            risk="HIGH",
        )
        save_json("test_matrix.json", TESTS)
        save_text("CERTIFICATION_REPORT.md", report_markdown())
        sys.exit(3)

add_test(
    "CERT-000", "Environment and write safety guard", "PASS",
    finding="Required variables are present. Writes are blocked outside AMEXTEST.",
    actual={"base_url": BASE, "write_tests": WRITE_TESTS},
)


# ============================================================
# CERT-001 OAUTH
# ============================================================

status, raw, oauth, _, _ = http_call(
    "POST", "/api/oauth/token", {"grant_type": "client_credentials"},
    basic=True, label="CERT-001_oauth",
)

if status == 200 and isinstance(oauth, dict) and oauth.get("access_token"):
    TOKEN = str(oauth["access_token"])
    FACTS["oauth"] = {
        "http_status": status,
        "token_type": oauth.get("token_type"),
        "expires_in": oauth.get("expires_in"),
        "token_length": len(TOKEN),
    }
    add_test(
        "CERT-001", "OAuth client_credentials", "PASS",
        finding="Bearer token obtained successfully without printing the token.",
        actual=FACTS["oauth"],
    )
else:
    add_test(
        "CERT-001", "OAuth client_credentials", "FAIL",
        finding="Could not obtain access_token.",
        actual={"http_status": status, "body_preview": raw[:500]},
    )
    save_json("test_matrix.json", TESTS)
    save_text("CERTIFICATION_REPORT.md", report_markdown())
    sys.exit(4)


# ============================================================
# CERT-002..006 LIVE DEFINES
# ============================================================

defines: dict[str, Any] = {}
define_specs = [
    ("CERT-002", "ORDER_HD upload define", "/api/uploads/define/ORDER_HD", "ORDER_HD"),
    ("CERT-003", "ORDER_LI upload define", "/api/uploads/define/ORDER_LI", "ORDER_LI"),
    ("CERT-004", "VR_ORDER_HD viewer define", "/api/viewers/define/VR_ORDER_HD", "COLUMNS"),
    ("CERT-005", "VR_ORDER_LI viewer define", "/api/viewers/define/VR_ORDER_LI", "COLUMNS"),
    ("CERT-006", "VR_UTREST_LOG viewer define", "/api/viewers/define/VR_UTREST_LOG", "COLUMNS"),
]

for test_id, purpose, path, required_key in define_specs:
    status, _, body, dups, _ = http_call("GET", path, label=f"{test_id}_define")
    passed = status == 200 and isinstance(body, dict) and required_key in body
    if passed:
        defines[test_id] = body
        if required_key in ("ORDER_HD", "ORDER_LI"):
            rows = body.get(required_key, [])
            count = len(rows[0]) if isinstance(rows, list) and rows and isinstance(rows[0], dict) else 0
        else:
            count = len([x.strip() for x in str(body.get("COLUMNS", "")).split(",") if x.strip()])
        add_test(
            test_id, purpose, "PASS",
            finding=f"Define reachable. Field/column count={count}.",
            actual={"http_status": status, "root_keys": list(body.keys()), "duplicate_keys": dups},
        )
    else:
        add_test(
            test_id, purpose, "FAIL",
            finding=f"Define not usable or required root key {required_key} missing.",
            actual={"http_status": status, "body": body},
        )

order_hd_define = defines.get("CERT-002", {})
order_li_define = defines.get("CERT-003", {})


# ============================================================
# CERT-007 LIVE CONTRACT VS csv.js
# ============================================================

csv_audit: dict[str, Any] = {}
if CSV_JS.exists() and isinstance(order_hd_define, dict) and isinstance(order_li_define, dict):
    text = CSV_JS.read_text(encoding="utf-8", errors="replace")
    csv_header = extract_js_array(text, "A2000_HEADER_COLUMNS")
    csv_lines = extract_js_array(text, "A2000_LINE_COLUMNS")
    hd_rows = order_hd_define.get("ORDER_HD", [])
    li_rows = order_li_define.get("ORDER_LI", [])
    hd_fields = list(hd_rows[0].keys()) if isinstance(hd_rows, list) and hd_rows and isinstance(hd_rows[0], dict) else []
    li_fields = list(li_rows[0].keys()) if isinstance(li_rows, list) and li_rows and isinstance(li_rows[0], dict) else []
    csv_audit = {
        "ORDER_HD": {
            "csv_fields": len(csv_header),
            "define_fields": len(hd_fields),
            "match": len(set(csv_header) & set(hd_fields)),
            "csv_only": [x for x in csv_header if x not in hd_fields],
            "define_only": [x for x in hd_fields if x not in csv_header],
        },
        "ORDER_LI": {
            "csv_fields": len(csv_lines),
            "define_fields": len(li_fields),
            "match": len(set(csv_lines) & set(li_fields)),
            "csv_only": [x for x in csv_lines if x not in li_fields],
            "define_only": [x for x in li_fields if x not in csv_lines],
        },
    }
    save_json("contract_audit.json", csv_audit)
    add_test(
        "CERT-007", "Compare csv.js columns against live Upload defines",
        "PASS" if csv_header and csv_lines and "STORE_NO" in li_fields else "PARTIAL",
        finding="Live REST contract compared to current csv.js. REST ORDER_LI uses STORE_NO.",
        actual=csv_audit,
    )
else:
    add_test(
        "CERT-007", "Compare csv.js columns against live Upload defines", "PARTIAL",
        finding="csv.js or live define data unavailable; audit could not be completed.",
    )
FACTS["contract_audit"] = csv_audit


# ============================================================
# CERT-008 VIEWER ZERO RESULT
# ============================================================

zero_order = f"NEVER{RUN_ID.replace('_', '')}"[:25]
status, _, zero_rows = viewer(
    "VR_ORDER_HD",
    ["CTRL_NO", "CUSTOMER", "ORDER_NO", "STORE", "STATUS"],
    f"ORDER_NO = '{zero_order}'",
    "CTRL_NO",
    label="CERT-008_zero_result",
)
add_test(
    "CERT-008", "Viewer request schema and exact zero-result filter",
    "PASS" if status == 200 and len(zero_rows) == 0 else "FAIL",
    finding="POST Viewer accepts COLUMNS, FILTER singular and SORT; nonexistent ORDER_NO returns an empty list.",
    actual={"http_status": status, "row_count": len(zero_rows)},
)


# ============================================================
# CERT-009 SOURCE HEADER
# ============================================================

source_header_columns = [
    "CTRL_NO", "CUSTOMER", "CUST_NAME", "ORDER_NO", "STORE", "ORDER_DATE",
    "START_DATE", "CANCEL_DATE", "DIV", "TERMS", "TERMS_DESCR", "DEF_WH",
    "SHIP_VIA", "ORDER_TYPE", "STATUS",
]
status, _, source_headers = viewer(
    "VR_ORDER_HD", source_header_columns,
    f"CTRL_NO = {SOURCE_CTRL_NO}", "CTRL_NO",
    label="CERT-009_source_header",
)
source_header = source_headers[0] if len(source_headers) == 1 else None
source_header_ok = (
    status == 200 and source_header is not None
    and source_header.get("CUSTOMER") and source_header.get("STORE")
    and source_header.get("DIV") and source_header.get("TERMS")
)
add_test(
    "CERT-009", "Read exact source Sales Order Header context",
    "PASS" if source_header_ok else "FAIL",
    finding="Exact source Header context loaded for controlled Line tests.",
    actual=source_header,
)


# ============================================================
# CERT-010 SOURCE LINES AND REAL SIZE BUCKET
# ============================================================

source_line_columns = [
    "CTRL_NO", "STYLE", "CLR", "LINE_NO", "WH", "CUSTOMER", "STORE",
    "ORDER_NO", "DIV", "PRICE", "SCALE", "STATUS", "ORDER_QTY", "OPEN_QTY",
    *[f"OPEN_SZ{i}" for i in range(1, 19)],
]
status, _, source_lines = viewer(
    "VR_ORDER_LI", source_line_columns,
    f"CTRL_NO = {SOURCE_CTRL_NO}", "LINE_NO",
    label="CERT-010_source_lines",
)
source_line, source_bucket = pick_source_line(source_lines)
line_context_ok = (
    status == 200 and source_header is not None and source_line is not None
    and source_bucket is not None
    and str(source_header.get("DIV") or "") == str(source_line.get("DIV") or "")
)
add_test(
    "CERT-010", "Read source Lines and derive a real positive OPEN_SZn bucket",
    "PASS" if line_context_ok else "FAIL",
    finding="A real STYLE, CLR, SCALE and positive size bucket were selected from the tenant; Header DIV must match Line DIV.",
    actual={
        "line_count": len(source_lines),
        "selected_line": source_line,
        "selected_size_bucket": source_bucket,
        "header_line_div_match": (
            str(source_header.get("DIV") or "") == str(source_line.get("DIV") or "")
            if source_header and source_line else False
        ),
    },
)


# ============================================================
# CERT-011 VIEWER PROJECTION AND SORT
# ============================================================

returned_keys = list(source_lines[0].keys()) if source_lines else []
line_nos = [numeric(row.get("LINE_NO")) for row in source_lines if row.get("LINE_NO") is not None]
projection_ok = bool(source_lines) and set(returned_keys).issubset(set(source_line_columns))
sort_ok = line_nos == sorted(line_nos)
add_test(
    "CERT-011", "Behaviorally verify Viewer projection and SORT on non-empty rows",
    "PASS" if projection_ok and sort_ok else "PARTIAL",
    finding="Requested columns are projected and source LINE_NO values are sorted.",
    actual={"returned_keys": returned_keys, "line_nos": line_nos, "projection_ok": projection_ok, "sort_ok": sort_ok},
)


# ============================================================
# CERT-012 REST LOG BASELINE
# ============================================================

status, _, baseline_log_rows = viewer(
    "VR_UTREST_LOG",
    [
        "UTREST_LOG_NO", "MODULE", "ENDPOINT", "PAYLOAD_SIZE", "MESSAGE",
        "CLIENT_NAME", "CLIENT_OWNER", "ENTRY_DATE", "ENTRY_TIME",
    ],
    f"CLIENT_NAME = '{CLIENT_NAME}'",
    "UTREST_LOG_NO",
    label="CERT-012_log_baseline",
)
baseline_groups = group_rest_logs(baseline_log_rows)
save_json("rest_log_baseline_grouped.json", {str(k): v for k, v in baseline_groups.items()})
add_test(
    "CERT-012", "Read and group REST logs by UTREST_LOG_NO",
    "PASS" if status == 200 and baseline_groups else "PARTIAL",
    finding="REST log rows are grouped by repeated UTREST_LOG_NO to reconstruct an operation.",
    actual={"http_status": status, "rows": len(baseline_log_rows), "groups": len(baseline_groups)},
)

FACTS["source_header"] = source_header
FACTS["source_line"] = source_line
FACTS["source_size_bucket"] = source_bucket


# ============================================================
# WRITE CERTIFICATION
# ============================================================

single_line_pass = False
single_seq: int | None = None
single_order_no: str | None = None

if not WRITE_TESTS:
    add_test(
        "CERT-020", "Controlled write certification", "SKIPPED",
        finding="A2000_WRITE_TESTS is not 1. Read-only certification completed.",
        risk="MEDIUM",
    )
elif not source_header_ok or not line_context_ok:
    add_test(
        "CERT-020", "Controlled write certification preconditions", "FAIL",
        finding="Source Header/Line context is not safe enough to build controlled writes.",
        risk="MEDIUM",
    )
else:
    # --------------------------------------------------------
    # CERT-020 CREATE HEADER + LINKING
    # --------------------------------------------------------
    single_order_no = make_order_no("SL")
    header_body, single_seq, header_rows = create_header(
        source_header, single_order_no, label="CERT-020_single_header"
    )
    header_pass = (
        isinstance(header_body, dict)
        and header_body.get("status") == "Success"
        and numeric(header_body.get("updated")) > 0
        and single_seq is not None
        and len(header_rows) == 1
        and int(header_rows[0].get("CTRL_NO")) == single_seq
    )
    add_test(
        "CERT-020", "Create unique ORDER_HD and verify SEQ_ORDER_NO ↔ VR_ORDER_HD.CTRL_NO",
        "PASS" if header_pass else "FAIL",
        finding="Header creation must return SEQ_ORDER_NO and Viewer must expose the same value as CTRL_NO.",
        actual={
            "order_no": single_order_no,
            "seq_order_no": single_seq,
            "viewer_rows": header_rows,
            "body_status": header_body.get("status") if isinstance(header_body, dict) else None,
            "body_updated": header_body.get("updated") if isinstance(header_body, dict) else None,
        },
        risk="MEDIUM",
    )

    # --------------------------------------------------------
    # CERT-021 ONE VALID LINE
    # --------------------------------------------------------
    if header_pass and single_seq is not None and source_line and source_bucket:
        line_row = build_line_row(
            seq_order_no=single_seq,
            order_no=single_order_no,
            source_header=source_header,
            source_line=source_line,
            size_bucket=source_bucket,
            line_no=1,
        )
        line_payload = {"IGNORE_ERRORS": "N", "ORDER_LI": [line_row]}
        line_status, _, line_body, line_dups = upload(
            "ORDER_LI", line_payload, label="CERT-021_single_line_upload"
        )
        _, _, line_rows = viewer(
            "VR_ORDER_LI",
            [
                "CTRL_NO", "STYLE", "CLR", "LINE_NO", "WH", "CUSTOMER", "STORE",
                "ORDER_NO", "DIV", "PRICE", "SCALE", "ORDER_QTY", "OPEN_QTY",
                *[f"OPEN_SZ{i}" for i in range(1, 19)],
            ],
            f"CTRL_NO = {single_seq}", "LINE_NO",
            label="CERT-021_single_line_verify",
        )
        single_line_pass = (
            line_status == 200
            and isinstance(line_body, dict)
            and line_body.get("status") == "Success"
            and numeric(line_body.get("updated")) > 0
            and len(line_rows) >= 1
        )
        latest_no, latest_rows = latest_log_group(
            "ORDER_LI", label="CERT-021_single_line_latest_log"
        )
        messages = log_messages(latest_rows)
        contamination_pattern = (
            any("Too many order headers match this line" in msg for msg in messages)
            and any(f"Line: {n} " in msg for n in (2, 3, 4, 5, 14) for msg in messages)
        )
        add_test(
            "CERT-021", "Create one ORDER_LI from a real tenant business context and verify with VR_ORDER_LI",
            "PASS" if single_line_pass else "FAIL",
            finding=(
                "Full Header + one Line verified."
                if single_line_pass
                else (
                    "Single Line failed and the latest log shows multi-line contamination/staging symptoms."
                    if contamination_pattern
                    else "Single Line failed; use exact body and grouped REST log to classify the remaining validation."
                )
            ),
            actual={
                "order_no": single_order_no,
                "seq_order_no": single_seq,
                "source_style": source_line.get("STYLE"),
                "source_color": source_line.get("CLR"),
                "source_scale": source_line.get("SCALE"),
                "size_bucket": source_bucket,
                "http_status": line_status,
                "body": line_body,
                "duplicate_keys": line_dups,
                "viewer_line_count": len(line_rows),
                "latest_log_no": latest_no,
                "latest_log_messages": messages,
                "staging_contamination_suspected": contamination_pattern,
            },
            risk="MEDIUM",
        )
    else:
        add_test(
            "CERT-021", "Create one ORDER_LI and verify", "SKIPPED",
            finding="Header creation did not pass.", risk="MEDIUM",
        )

    # --------------------------------------------------------
    # CERT-022 DUPLICATE LINE
    # --------------------------------------------------------
    if single_line_pass and DESTRUCTIVE_PROBES and single_seq and single_order_no and source_line and source_bucket:
        duplicate_payload = {
            "IGNORE_ERRORS": "N",
            "ORDER_LI": [
                build_line_row(
                    seq_order_no=single_seq,
                    order_no=single_order_no,
                    source_header=source_header,
                    source_line=source_line,
                    size_bucket=source_bucket,
                    line_no=1,
                )
            ],
        }
        dup_status, _, dup_body, _ = upload(
            "ORDER_LI", duplicate_payload, label="CERT-022_duplicate_line_upload"
        )
        _, _, dup_rows = viewer(
            "VR_ORDER_LI",
            ["CTRL_NO", "STYLE", "CLR", "LINE_NO", "ORDER_NO", "ORDER_QTY", "OPEN_QTY"],
            f"CTRL_NO = {single_seq}", "LINE_NO",
            label="CERT-022_duplicate_line_verify",
        )
        latest_no, latest_rows = latest_log_group(
            "ORDER_LI", label="CERT-022_duplicate_line_latest_log"
        )
        add_test(
            "CERT-022", "Repost exact ORDER_LI to characterize duplicate Line behavior", "PASS",
            finding="Duplicate Line behavior was observed and preserved as a characterization test.",
            actual={
                "http_status": dup_status,
                "body": dup_body,
                "viewer_line_count": len(dup_rows),
                "latest_log_no": latest_no,
                "latest_log_messages": log_messages(latest_rows),
            },
            risk="MEDIUM",
        )
    else:
        add_test(
            "CERT-022", "Duplicate ORDER_LI behavior", "SKIPPED",
            finding="Requires successful single Line and A2000_DESTRUCTIVE_PROBES=1.",
            risk="MEDIUM",
        )

    # --------------------------------------------------------
    # CERT-023 TWO VALID LINES
    # --------------------------------------------------------
    if single_line_pass:
        first_line, first_bucket = pick_source_line(source_lines)
        skip = {(str(first_line.get("STYLE")), str(first_line.get("CLR")))} if first_line else set()
        second_line, second_bucket = pick_source_line(source_lines, skip=skip)
        if first_line and first_bucket and second_line and second_bucket:
            multi_order = make_order_no("ML")
            _, multi_seq, multi_header_rows = create_header(
                source_header, multi_order, label="CERT-023_multi_header"
            )
            if multi_seq is not None and len(multi_header_rows) == 1:
                multi_payload = {
                    "IGNORE_ERRORS": "N",
                    "ORDER_LI": [
                        build_line_row(
                            seq_order_no=multi_seq, order_no=multi_order,
                            source_header=source_header, source_line=first_line,
                            size_bucket=first_bucket, line_no=1,
                        ),
                        build_line_row(
                            seq_order_no=multi_seq, order_no=multi_order,
                            source_header=source_header, source_line=second_line,
                            size_bucket=second_bucket, line_no=2,
                        ),
                    ],
                }
                multi_status, _, multi_body, _ = upload(
                    "ORDER_LI", multi_payload, label="CERT-023_multi_line_upload"
                )
                _, _, multi_rows = viewer(
                    "VR_ORDER_LI",
                    ["CTRL_NO", "STYLE", "CLR", "LINE_NO", "ORDER_NO", "ORDER_QTY", "OPEN_QTY"],
                    f"CTRL_NO = {multi_seq}", "LINE_NO",
                    label="CERT-023_multi_line_verify",
                )
                multi_pass = (
                    multi_status == 200
                    and isinstance(multi_body, dict)
                    and multi_body.get("status") == "Success"
                    and numeric(multi_body.get("updated")) >= 2
                    and len(multi_rows) >= 2
                )
                add_test(
                    "CERT-023", "Upload two valid ORDER_LI rows in one batch and verify both",
                    "PASS" if multi_pass else "FAIL",
                    finding="Two-Line batch behavior characterized.",
                    actual={
                        "order_no": multi_order,
                        "seq_order_no": multi_seq,
                        "http_status": multi_status,
                        "body": multi_body,
                        "viewer_line_count": len(multi_rows),
                        "viewer_rows": multi_rows,
                    },
                    risk="MEDIUM",
                )
            else:
                add_test(
                    "CERT-023", "Two valid ORDER_LI rows in one batch", "SKIPPED",
                    finding="Could not create the dedicated multi-line Header.", risk="MEDIUM",
                )
        else:
            add_test(
                "CERT-023", "Two valid ORDER_LI rows in one batch", "SKIPPED",
                finding="Could not select two distinct valid source style/color Lines.", risk="MEDIUM",
            )
    else:
        add_test(
            "CERT-023", "Two valid ORDER_LI rows in one batch", "SKIPPED",
            finding="Requires a successful single Line.", risk="MEDIUM",
        )

    # --------------------------------------------------------
    # CERT-024 ORDER_LI ROLLBACK
    # --------------------------------------------------------
    if single_line_pass and DESTRUCTIVE_PROBES and source_line and source_bucket:
        rollback_order = make_order_no("LR")
        _, rollback_seq, rollback_header_rows = create_header(
            source_header, rollback_order, label="CERT-024_line_rollback_header"
        )
        if rollback_seq is not None and len(rollback_header_rows) == 1:
            valid_line = build_line_row(
                seq_order_no=rollback_seq, order_no=rollback_order,
                source_header=source_header, source_line=source_line,
                size_bucket=source_bucket, line_no=1,
            )
            invalid_line = dict(valid_line)
            invalid_line["LINE_NO"] = 2
            invalid_line["STYLE"] = "ZZ_BAD_STYLE"
            invalid_line["COLOR_NO"] = "ZZ_BAD_COLOR"
            rollback_payload = {"IGNORE_ERRORS": "N", "ORDER_LI": [valid_line, invalid_line]}
            rb_status, _, rb_body, _ = upload(
                "ORDER_LI", rollback_payload, label="CERT-024_line_rollback_upload"
            )
            _, _, rb_rows = viewer(
                "VR_ORDER_LI",
                ["CTRL_NO", "STYLE", "CLR", "LINE_NO", "ORDER_NO"],
                f"CTRL_NO = {rollback_seq}", "LINE_NO",
                label="CERT-024_line_rollback_verify",
            )
            rollback_observed = (
                rb_status == 200
                and isinstance(rb_body, dict)
                and rb_body.get("status") == "Fail"
                and numeric(rb_body.get("updated")) == 0
                and len(rb_rows) == 0
            )
            add_test(
                "CERT-024", "ORDER_LI IGNORE_ERRORS=N valid+invalid batch rollback characterization",
                "PASS" if rollback_observed else "PARTIAL",
                finding=(
                    "All-or-nothing behavior observed for the tested ORDER_LI batch."
                    if rollback_observed
                    else "ORDER_LI rollback behavior differs or remains ambiguous; inspect body and Viewer rows."
                ),
                actual={
                    "seq_order_no": rollback_seq,
                    "http_status": rb_status,
                    "body": rb_body,
                    "viewer_line_count": len(rb_rows),
                    "viewer_rows": rb_rows,
                },
                risk="MEDIUM",
            )
        else:
            add_test(
                "CERT-024", "ORDER_LI rollback characterization", "SKIPPED",
                finding="Could not create rollback-test Header.", risk="MEDIUM",
            )
    else:
        add_test(
            "CERT-024", "ORDER_LI rollback characterization", "SKIPPED",
            finding="Requires successful single Line and A2000_DESTRUCTIVE_PROBES=1.", risk="MEDIUM",
        )

    # --------------------------------------------------------
    # CERT-025 DUPLICATE HEADER
    # --------------------------------------------------------
    if DESTRUCTIVE_PROBES:
        duplicate_order = make_order_no("DH")
        _, first_seq, _ = create_header(
            source_header, duplicate_order, label="CERT-025_duplicate_header_first"
        )
        second_payload = {"IGNORE_ERRORS": "N", "ORDER_HD": [build_header_row(source_header, duplicate_order)]}
        second_status, _, second_body, _ = upload(
            "ORDER_HD", second_payload, label="CERT-025_duplicate_header_second"
        )
        _, _, duplicate_rows = viewer(
            "VR_ORDER_HD",
            ["CTRL_NO", "CUSTOMER", "ORDER_NO", "STORE", "DIV", "STATUS"],
            f"ORDER_NO = '{duplicate_order}'", "CTRL_NO",
            label="CERT-025_duplicate_header_verify",
        )
        duplicate_observed = (
            first_seq is not None
            and second_status == 200
            and isinstance(second_body, dict)
            and second_body.get("status") == "Success"
            and len(duplicate_rows) >= 2
        )
        add_test(
            "CERT-025", "Repost exact ORDER_HD and characterize Header idempotency",
            "PASS" if duplicate_observed else "PARTIAL",
            finding=(
                "Duplicate Header creation reproduced; A2000 does not provide safe idempotency by ORDER_NO."
                if duplicate_observed
                else "Duplicate behavior did not reproduce exactly; inspect raw responses and Viewer rows."
            ),
            actual={
                "order_no": duplicate_order,
                "first_seq": first_seq,
                "second_body": second_body,
                "viewer_count": len(duplicate_rows),
                "viewer_rows": duplicate_rows,
            },
            risk="MEDIUM",
        )
    else:
        add_test(
            "CERT-025", "Duplicate ORDER_HD behavior", "SKIPPED",
            finding="Requires A2000_DESTRUCTIVE_PROBES=1.", risk="MEDIUM",
        )

    # --------------------------------------------------------
    # CERT-026 ORDER_HD ROLLBACK
    # --------------------------------------------------------
    if DESTRUCTIVE_PROBES:
        valid_order = make_order_no("HR")
        invalid_order = make_order_no("HX")
        valid_row = build_header_row(source_header, valid_order)
        invalid_row = {
            "CUST_NO": "__INVALID_CUST__",
            "STORE_NO": "__INVALID_STORE__",
            "ORDER_NO": invalid_order,
            "DIV_NO": "",
        }
        payload = {"IGNORE_ERRORS": "N", "ORDER_HD": [valid_row, invalid_row]}
        hr_status, _, hr_body, _ = upload(
            "ORDER_HD", payload, label="CERT-026_header_rollback_upload"
        )
        _, _, valid_visible = viewer(
            "VR_ORDER_HD",
            ["CTRL_NO", "CUSTOMER", "ORDER_NO", "STORE", "DIV", "STATUS"],
            f"ORDER_NO = '{valid_order}'", "CTRL_NO",
            label="CERT-026_header_rollback_verify",
        )
        header_rollback_observed = (
            hr_status == 200
            and isinstance(hr_body, dict)
            and hr_body.get("status") == "Fail"
            and numeric(hr_body.get("updated")) == 0
            and len(valid_visible) == 0
        )
        add_test(
            "CERT-026", "ORDER_HD IGNORE_ERRORS=N valid+invalid batch rollback characterization",
            "PASS" if header_rollback_observed else "PARTIAL",
            finding=(
                "All-or-nothing behavior reproduced for the tested ORDER_HD batch."
                if header_rollback_observed
                else "Header rollback behavior did not reproduce exactly; inspect raw response and Viewer."
            ),
            actual={
                "http_status": hr_status,
                "body": hr_body,
                "valid_order_visible_count": len(valid_visible),
            },
            risk="MEDIUM",
        )
    else:
        add_test(
            "CERT-026", "ORDER_HD rollback characterization", "SKIPPED",
            finding="Requires A2000_DESTRUCTIVE_PROBES=1.", risk="MEDIUM",
        )


# ============================================================
# CERT-030 / 031 FINAL GROUPED LOG SNAPSHOT
# ============================================================

for endpoint, test_id in [("ORDER_HD", "CERT-030"), ("ORDER_LI", "CERT-031")]:
    latest_no, latest_rows = latest_log_group(
        endpoint, label=f"{test_id}_{endpoint.lower()}_latest_log"
    )
    add_test(
        test_id, f"Capture latest grouped REST log for {endpoint}",
        "PASS" if latest_no is not None else "PARTIAL",
        finding="Latest REST operation group captured for correlation with raw API responses.",
        actual={"latest_log_no": latest_no, "messages": log_messages(latest_rows)},
    )


# ============================================================
# FINAL GATE + REPORTS
# ============================================================

required_ids = {
    "CERT-001", "CERT-002", "CERT-003", "CERT-004", "CERT-005", "CERT-006",
    "CERT-007", "CERT-008", "CERT-009", "CERT-010", "CERT-011", "CERT-012",
}
if WRITE_TESTS:
    required_ids |= {"CERT-020", "CERT-021"}

required_results = {
    test["test_id"]: test["result"]
    for test in TESTS
    if test["test_id"] in required_ids
}
hard_failures = {
    test_id: result
    for test_id, result in required_results.items()
    if result == "FAIL"
}
full_order_pass = any(
    test["test_id"] == "CERT-021" and test["result"] == "PASS"
    for test in TESTS
)

FACTS["required_results"] = required_results
FACTS["hard_failures"] = hard_failures
FACTS["full_order_header_plus_line_pass"] = full_order_pass
FACTS["recommendation"] = (
    "GO_FOR_ADAPTER_IMPLEMENTATION"
    if WRITE_TESTS and full_order_pass and not hard_failures
    else (
        "READ_ONLY_CONTRACT_READY_WRITE_TESTS_NOT_RUN"
        if not WRITE_TESTS and not hard_failures
        else "NO_GO_FIX_BLOCKERS_BEFORE_PRODUCTION"
    )
)

save_json("test_matrix.json", TESTS)
save_json("facts.json", FACTS)
save_json("raw_response_index.json", RAW_INDEX)
save_text("CERTIFICATION_REPORT.md", report_markdown())

copy_lines = [
    "============================================================",
    "COPY THIS RESULT TO CHATGPT",
    "============================================================",
    f"RUN_ID={RUN_ID}",
    f"RUN_DIR={RUN}",
    f"BASE_URL={BASE}",
    f"WRITE_TESTS={WRITE_TESTS}",
    f"DESTRUCTIVE_PROBES={DESTRUCTIVE_PROBES}",
    f"FULL_ORDER_HEADER_PLUS_LINE_PASS={full_order_pass}",
    f"HARD_FAILURES={json.dumps(hard_failures, ensure_ascii=False)}",
    f"RECOMMENDATION={FACTS['recommendation']}",
    "",
    "TEST MATRIX:",
]
for test in TESTS:
    copy_lines.append(
        f"{test['test_id']} | {test['result']} | {test['purpose']} | {test['finding']}"
    )
copy_lines.extend([
    "",
    f"REPORT={RUN / 'CERTIFICATION_REPORT.md'}",
    f"TEST_MATRIX={RUN / 'test_matrix.json'}",
    f"FACTS={RUN / 'facts.json'}",
    f"RAW_RESPONSE_INDEX={RUN / 'raw_response_index.json'}",
    "============================================================",
])
copy_text = "\n".join(copy_lines) + "\n"
save_text("COPY_TO_CHATGPT.txt", copy_text)

emit()
emit(copy_text)
