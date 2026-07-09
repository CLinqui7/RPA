# A2000 PRE-PRODUCTION CERTIFICATION REPORT

- Run ID: `20260708_205833`
- Base URL: `https://amextest.a2000cloud.com:8890/ords/amxtest`
- Write tests: `True`
- Destructive probes: `False`
- Source CTRL_NO: `3757166`

## Test matrix

| Test ID | Result | Risk | Purpose | Finding |
|---|---|---|---|---|
| CERT-000 | PASS | NONE | Environment and write safety guard | Required variables are present. Writes are blocked outside AMEXTEST. |
| CERT-001 | PASS | NONE | OAuth client_credentials | Bearer token obtained successfully without printing the token. |
| CERT-002 | PASS | NONE | ORDER_HD upload define | Define reachable. Field/column count=60. |
| CERT-003 | PASS | NONE | ORDER_LI upload define | Define reachable. Field/column count=48. |
| CERT-004 | PASS | NONE | VR_ORDER_HD viewer define | Define reachable. Field/column count=135. |
| CERT-005 | PASS | NONE | VR_ORDER_LI viewer define | Define reachable. Field/column count=218. |
| CERT-006 | PASS | NONE | VR_UTREST_LOG viewer define | Define reachable. Field/column count=13. |
| CERT-007 | PASS | NONE | Compare csv.js columns against live Upload defines | Live REST contract compared to current csv.js. REST ORDER_LI uses STORE_NO. |
| CERT-008 | PASS | NONE | Viewer request schema and exact zero-result filter | POST Viewer accepts COLUMNS, FILTER singular and SORT; nonexistent ORDER_NO returns an empty list. |
| CERT-009 | PASS | NONE | Read exact source Sales Order Header context | Exact source Header context loaded for controlled Line tests. |
| CERT-010 | PASS | NONE | Read source Lines and derive a real positive OPEN_SZn bucket | A real STYLE, CLR, SCALE and positive size bucket were selected from the tenant; Header DIV must match Line DIV. |
| CERT-011 | PASS | NONE | Behaviorally verify Viewer projection and SORT on non-empty rows | Requested columns are projected and source LINE_NO values are sorted. |
| CERT-012 | PASS | NONE | Read and group REST logs by UTREST_LOG_NO | REST log rows are grouped by repeated UTREST_LOG_NO to reconstruct an operation. |
| CERT-020 | PASS | MEDIUM | Create unique ORDER_HD and verify SEQ_ORDER_NO ↔ VR_ORDER_HD.CTRL_NO | Header creation must return SEQ_ORDER_NO and Viewer must expose the same value as CTRL_NO. |
| CERT-021 | FAIL | MEDIUM | Create one ORDER_LI from a real tenant business context and verify with VR_ORDER_LI | Single Line failed and the latest log shows multi-line contamination/staging symptoms. |
| CERT-022 | SKIPPED | MEDIUM | Duplicate ORDER_LI behavior | Requires successful single Line and A2000_DESTRUCTIVE_PROBES=1. |
| CERT-023 | SKIPPED | MEDIUM | Two valid ORDER_LI rows in one batch | Requires a successful single Line. |
| CERT-024 | SKIPPED | MEDIUM | ORDER_LI rollback characterization | Requires successful single Line and A2000_DESTRUCTIVE_PROBES=1. |
| CERT-025 | SKIPPED | MEDIUM | Duplicate ORDER_HD behavior | Requires A2000_DESTRUCTIVE_PROBES=1. |
| CERT-026 | SKIPPED | MEDIUM | ORDER_HD rollback characterization | Requires A2000_DESTRUCTIVE_PROBES=1. |
| CERT-030 | PASS | NONE | Capture latest grouped REST log for ORDER_HD | Latest REST operation group captured for correlation with raw API responses. |
| CERT-031 | PASS | NONE | Capture latest grouped REST log for ORDER_LI | Latest REST operation group captured for correlation with raw API responses. |

## Facts

```json
{
  "oauth": {
    "http_status": 200,
    "token_type": "bearer",
    "expires_in": 3600,
    "token_length": 22
  },
  "contract_audit": {
    "ORDER_HD": {
      "csv_fields": 59,
      "define_fields": 60,
      "match": 59,
      "csv_only": [],
      "define_only": [
        "SHIP_ACT_NO"
      ]
    },
    "ORDER_LI": {
      "csv_fields": 41,
      "define_fields": 48,
      "match": 40,
      "csv_only": [
        "_NO"
      ],
      "define_only": [
        "STORE_NO",
        "USER_REF1",
        "USER_REF2",
        "USER_REF3",
        "USER_REF4",
        "USER_REF5",
        "USER_DT_REF1",
        "USER_DT_REF2"
      ]
    }
  },
  "source_header": {
    "CTRL_NO": 3757166,
    "CUSTOMER": "CITI",
    "CUST_NAME": "CITI TRENDS INC",
    "ORDER_NO": "194387",
    "STORE": "1",
    "ORDER_DATE": "2026-03-04T00:00:00Z",
    "START_DATE": "2026-07-27T00:00:00Z",
    "CANCEL_DATE": "2026-07-31T00:00:00Z",
    "DIV": "AL",
    "TERMS": "X6",
    "TERMS_DESCR": "CIT ROG NET 60",
    "DEF_WH": "PE",
    "SHIP_VIA": "ROUTING",
    "STATUS": "OPEN"
  },
  "source_line": {
    "CTRL_NO": 3757166,
    "STYLE": "11KS306S9962",
    "CLR": "0C9",
    "LINE_NO": 1,
    "WH": "PE",
    "CUSTOMER": "CITI",
    "STORE": "1",
    "ORDER_NO": "194387",
    "DIV": "AL",
    "PRICE": 7.1429,
    "SCALE": "v0",
    "STATUS": "OPEN",
    "ORDER_QTY": 576,
    "OPEN_QTY": 576,
    "OPEN_SZ1": 0,
    "OPEN_SZ2": 0,
    "OPEN_SZ3": 0,
    "OPEN_SZ4": 96,
    "OPEN_SZ5": 192,
    "OPEN_SZ6": 192,
    "OPEN_SZ7": 96,
    "OPEN_SZ8": 0,
    "OPEN_SZ9": 0,
    "OPEN_SZ10": 0,
    "OPEN_SZ11": 0,
    "OPEN_SZ12": 0,
    "OPEN_SZ13": 0,
    "OPEN_SZ14": 0,
    "OPEN_SZ15": 0,
    "OPEN_SZ16": 0,
    "OPEN_SZ17": 0,
    "OPEN_SZ18": 0
  },
  "source_size_bucket": 4,
  "required_results": {
    "CERT-001": "PASS",
    "CERT-002": "PASS",
    "CERT-003": "PASS",
    "CERT-004": "PASS",
    "CERT-005": "PASS",
    "CERT-006": "PASS",
    "CERT-007": "PASS",
    "CERT-008": "PASS",
    "CERT-009": "PASS",
    "CERT-010": "PASS",
    "CERT-011": "PASS",
    "CERT-012": "PASS",
    "CERT-020": "PASS",
    "CERT-021": "FAIL"
  },
  "hard_failures": {
    "CERT-021": "FAIL"
  },
  "full_order_header_plus_line_pass": false,
  "recommendation": "NO_GO_FIX_BLOCKERS_BEFORE_PRODUCTION"
}
```

## Raw response index

```json
[
  {
    "label": "CERT-001_oauth",
    "method": "POST",
    "path": "/api/oauth/token",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 81
  },
  {
    "label": "CERT-002_define",
    "method": "GET",
    "path": "/api/uploads/define/ORDER_HD",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 1383
  },
  {
    "label": "CERT-003_define",
    "method": "GET",
    "path": "/api/uploads/define/ORDER_LI",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 1045
  },
  {
    "label": "CERT-004_define",
    "method": "GET",
    "path": "/api/viewers/define/VR_ORDER_HD",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 1708
  },
  {
    "label": "CERT-005_define",
    "method": "GET",
    "path": "/api/viewers/define/VR_ORDER_LI",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 2598
  },
  {
    "label": "CERT-006_define",
    "method": "GET",
    "path": "/api/viewers/define/VR_UTREST_LOG",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 249
  },
  {
    "label": "CERT-008_zero_result",
    "method": "POST",
    "path": "/api/viewers/view/VR_ORDER_HD",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 23
  },
  {
    "label": "CERT-009_source_header",
    "method": "POST",
    "path": "/api/viewers/view/VR_ORDER_HD",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 353
  },
  {
    "label": "CERT-010_source_lines",
    "method": "POST",
    "path": "/api/viewers/view/VR_ORDER_LI",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 2006
  },
  {
    "label": "CERT-012_log_baseline",
    "method": "POST",
    "path": "/api/viewers/view/VR_UTREST_LOG",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 33850
  },
  {
    "label": "CERT-020_single_header_before",
    "method": "POST",
    "path": "/api/viewers/view/VR_ORDER_HD",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 23
  },
  {
    "label": "CERT-020_single_header_upload",
    "method": "POST",
    "path": "/api/uploads/upload/ORDER_HD",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [
      "errors"
    ],
    "response_bytes": 470
  },
  {
    "label": "CERT-020_single_header_after",
    "method": "POST",
    "path": "/api/viewers/view/VR_ORDER_HD",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 190
  },
  {
    "label": "CERT-021_single_line_upload",
    "method": "POST",
    "path": "/api/uploads/upload/ORDER_LI",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [
      "errors"
    ],
    "response_bytes": 310
  },
  {
    "label": "CERT-021_single_line_verify",
    "method": "POST",
    "path": "/api/viewers/view/VR_ORDER_LI",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 23
  },
  {
    "label": "CERT-021_single_line_latest_log",
    "method": "POST",
    "path": "/api/viewers/view/VR_UTREST_LOG",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 14474
  },
  {
    "label": "CERT-030_order_hd_latest_log",
    "method": "POST",
    "path": "/api/viewers/view/VR_UTREST_LOG",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 6936
  },
  {
    "label": "CERT-031_order_li_latest_log",
    "method": "POST",
    "path": "/api/viewers/view/VR_UTREST_LOG",
    "http_status": 200,
    "content_type": "application/json",
    "duplicate_keys": [],
    "response_bytes": 14474
  }
]
```
