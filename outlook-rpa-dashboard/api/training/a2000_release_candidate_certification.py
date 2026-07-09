#!/usr/bin/env python3
from __future__ import annotations

import base64
import csv
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


# =============================================================================
# A2000 RELEASE CANDIDATE CERTIFICATION
#
# Purpose:
#   Certify the REST path actually needed by the Outlook/PDF -> A2000 project.
#
# Phases:
#   readonly
#       OAuth, live contracts, Viewers, source context, local master correlation,
#       targeted Viewer discovery, and static code production-blocker scan.
#
#   multiline
#       Creates one AMEXTEST Header and uploads TWO valid real-context ORDER_LI
#       rows in one batch using exact source size distributions.
#
#   duplicate-line
#       Reposts one already-created line from the last successful multiline run
#       and characterizes duplicate behavior. This phase may leave pending data.
#
#   rollback-line
#       Creates a fresh Header, posts one valid line + one deliberately invalid
#       line with IGNORE_ERRORS=N, and checks whether the valid row is rolled back.
#       This phase is expected to fail validation and may leave pending data.
#
#   production-readonly
#       Same as readonly, but intended for production URL. NEVER writes.
#
# Safety:
#   Any write is hard-blocked outside AMEXTEST.
#   Write phases require A2000_ORDER_LI_CLEARED=YES.
#
# Important:
#   The suite does NOT know how to press CLEAR in A2000 Upload Utility.
#   That manual gate is intentional because the project has proven that pending
#   ORDER_LI rows can interfere with REST uploads.
# =============================================================================


PROJECT = Path(
    os.getenv(
        "A2000_PROJECT_ROOT",
        "/workspaces/RPA/outlook-rpa-dashboard",
    )
).resolve()

API_DIR = PROJECT / "api"
TRAINING_ROOT = API_DIR / "training" / "a2000_release_candidate"
STATE_FILE = TRAINING_ROOT / "state.json"

PHASE = os.getenv("A2000_CERT_PHASE", "readonly").strip().lower()
SOURCE_CTRL_NO = int(os.getenv("A2000_SOURCE_CTRL_NO", "3757166"))
CLIENT_NAME = os.getenv("A2000_CLIENT_NAME", "Linqui").strip() or "Linqui"

VALID_PHASES = {
    "readonly",
    "production-readonly",
    "multiline",
    "duplicate-line",
    "rollback-line",
}

WRITE_PHASES = {
    "multiline",
    "duplicate-line",
    "rollback-line",
}

RUN_ID = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
RUN = TRAINING_ROOT / f"{PHASE}_{RUN_ID}"
RUN.mkdir(parents=True, exist_ok=True)

TESTS: list[dict[str, Any]] = []
FACTS: dict[str, Any] = {}
RAW_INDEX: list[dict[str, Any]] = []
TOKEN = ""
TOKEN_EXPIRES_AT_MS = 0


# =============================================================================
# ENV LOADING
# =============================================================================


def load_env_file_if_present() -> str | None:
    """
    Load missing A2000_* values from api/.env or .env without printing secrets.

    Existing shell variables win.
    """
    candidates = [
        API_DIR / ".env",
        PROJECT / ".env",
    ]

    for path in candidates:
        if not path.exists():
            continue

        for raw_line in path.read_text(
            encoding="utf-8",
            errors="replace",
        ).splitlines():
            line = raw_line.strip()

            if (
                not line
                or line.startswith("#")
                or "=" not in line
            ):
                continue

            key, value = line.split("=", 1)
            key = key.strip()

            if not key.startswith("A2000_"):
                continue

            if os.getenv(key):
                continue

            value = value.strip()

            if (
                len(value) >= 2
                and value[0] == value[-1]
                and value[0] in {"'", '"'}
            ):
                value = value[1:-1]

            os.environ[key] = value

        return str(path)

    return None


ENV_SOURCE = load_env_file_if_present()

BASE = os.getenv("A2000_BASE_URL", "").rstrip("/")
CLIENT_ID = os.getenv("A2000_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("A2000_CLIENT_SECRET", "")
ORDER_HD_UPLOAD_ID = os.getenv("A2000_ORDER_HD_UPLOAD_ID", "ORDER_HD").strip()
ORDER_LI_UPLOAD_ID = os.getenv("A2000_ORDER_LI_UPLOAD_ID", "ORDER_LI").strip()
ORDER_LI_CLEAR_CONFIRMED = (
    os.getenv("A2000_ORDER_LI_CLEARED", "").strip().upper()
    == "YES"
)


# =============================================================================
# OUTPUT / FILE HELPERS
# =============================================================================


def emit(text: str = "") -> None:
    print(text, flush=True)


def save_text(name: str, text: str) -> Path:
    path = RUN / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def save_json(name: str, value: Any) -> Path:
    return save_text(
        name,
        json.dumps(
            value,
            indent=2,
            ensure_ascii=False,
            default=str,
        ),
    )


def add_test(
    test_id: str,
    purpose: str,
    result: str,
    *,
    finding: str,
    actual: Any = None,
    risk: str = "NONE",
    blocker: bool = False,
) -> None:
    row = {
        "test_id": test_id,
        "purpose": purpose,
        "result": result,
        "finding": finding,
        "actual": actual,
        "risk": risk,
        "blocker": blocker,
    }

    TESTS.append(row)

    emit(
        f"{test_id} | {result} | {purpose}"
    )
    emit(
        f"  FINDING: {finding}"
    )

    if actual is not None:
        emit(
            "  ACTUAL: "
            + json.dumps(
                actual,
                ensure_ascii=False,
                default=str,
            )
        )


def parse_json_with_duplicates(
    raw: str,
) -> tuple[Any | None, list[str]]:
    duplicates: list[str] = []

    def hook(
        pairs: list[tuple[str, Any]],
    ) -> dict[str, Any]:
        counts = Counter(
            key
            for key, _
            in pairs
        )

        duplicates.extend(
            key
            for key, count
            in counts.items()
            if count > 1
        )

        result: dict[str, Any] = {}

        for key, value in pairs:
            result[key] = value

        return result

    try:
        body = json.loads(
            raw,
            object_pairs_hook=hook,
        )

        return body, sorted(
            set(duplicates)
        )

    except Exception:
        return None, []


def numeric(
    value: Any,
) -> float | None:
    if value in (None, ""):
        return None

    try:
        return float(
            str(value).replace(",", "")
        )

    except Exception:
        return None


def intish(
    value: Any,
) -> int:
    number = numeric(value)

    if number is None:
        return 0

    return int(
        round(number)
    )


def clean(
    value: Any,
) -> str:
    if value is None:
        return ""

    return str(value).strip()


def rows_from(
    body: Any,
    key: str,
) -> list[dict[str, Any]]:
    if not isinstance(body, dict):
        return []

    rows = body.get(key, [])

    if not isinstance(rows, list):
        return []

    return [
        row
        for row in rows
        if isinstance(row, dict)
    ]


# =============================================================================
# HTTP / OAUTH
# =============================================================================


def request_raw(
    method: str,
    path: str,
    payload: Any | None = None,
    *,
    basic: bool = False,
    label: str,
) -> tuple[
    int,
    str,
    Any | None,
    list[str],
    dict[str, str],
]:
    global TOKEN

    url = f"{BASE}{path}"

    headers: dict[str, str] = {
        "Accept": "application/json",
    }

    data: bytes | None = None

    if basic:
        credentials = base64.b64encode(
            f"{CLIENT_ID}:{CLIENT_SECRET}".encode()
        ).decode()

        headers["Authorization"] = (
            f"Basic {credentials}"
        )

        headers["Content-Type"] = (
            "application/x-www-form-urlencoded"
        )

        data = urllib.parse.urlencode(
            payload or {}
        ).encode()

    else:
        headers["Authorization"] = (
            f"Bearer {TOKEN}"
        )

        if payload is not None:
            headers["Content-Type"] = (
                "application/json"
            )

            data = json.dumps(
                payload,
                ensure_ascii=False,
            ).encode()

            save_json(
                f"requests/{label}.json",
                payload,
            )

    req = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method=method,
    )

    response_headers: dict[str, str] = {}

    try:
        with urllib.request.urlopen(
            req,
            timeout=120,
        ) as response:
            status = response.status

            raw = response.read().decode(
                "utf-8",
                errors="replace",
            )

            response_headers = {
                key.lower(): value
                for key, value
                in response.headers.items()
            }

    except urllib.error.HTTPError as exc:
        status = exc.code

        raw = exc.read().decode(
            "utf-8",
            errors="replace",
        )

        response_headers = {
            key.lower(): value
            for key, value
            in exc.headers.items()
        }

    except Exception as exc:
        status = 0
        raw = repr(exc)

    save_text(
        f"responses/{label}.raw.txt",
        raw,
    )

    body, duplicates = parse_json_with_duplicates(
        raw
    )

    if body is not None:
        save_json(
            f"responses/{label}.parsed.json",
            body,
        )

    RAW_INDEX.append(
        {
            "label": label,
            "method": method,
            "path": path,
            "http_status": status,
            "content_type":
            response_headers.get(
                "content-type"
            ),
            "response_bytes":
            len(
                raw.encode("utf-8")
            ),
            "duplicate_keys":
            duplicates,
        }
    )

    return (
        status,
        raw,
        body,
        duplicates,
        response_headers,
    )


def refresh_token(
    *,
    label: str,
) -> bool:
    global TOKEN
    global TOKEN_EXPIRES_AT_MS

    status, _, body, _, _ = request_raw(
        "POST",
        "/api/oauth/token",
        {
            "grant_type":
            "client_credentials",
        },
        basic=True,
        label=label,
    )

    if (
        status != 200
        or not isinstance(body, dict)
        or not body.get("access_token")
    ):
        return False

    TOKEN = str(
        body["access_token"]
    )

    expires_in = int(
        numeric(
            body.get(
                "expires_in"
            )
        )
        or 3600
    )

    TOKEN_EXPIRES_AT_MS = (
        int(
            time.time() * 1000
        )
        +
        expires_in * 1000
        -
        60_000
    )

    FACTS["oauth"] = {
        "http_status": status,
        "token_type":
        body.get("token_type"),
        "expires_in":
        expires_in,
        "token_length":
        len(TOKEN),
    }

    return True


def ensure_fresh_token(
    *,
    label: str,
) -> None:
    now_ms = int(
        time.time() * 1000
    )

    if (
        not TOKEN
        or now_ms
        >= TOKEN_EXPIRES_AT_MS
    ):
        if not refresh_token(
            label=label
        ):
            raise RuntimeError(
                "Could not refresh OAuth token"
            )


def api_call(
    method: str,
    path: str,
    payload: Any | None = None,
    *,
    label: str,
    safe_retry_401: bool = False,
) -> tuple[
    int,
    str,
    Any | None,
    list[str],
    dict[str, str],
]:
    ensure_fresh_token(
        label=f"{label}_oauth_refresh"
    )

    result = request_raw(
        method,
        path,
        payload,
        label=label,
    )

    status = result[0]

    if (
        status == 401
        and safe_retry_401
    ):
        if not refresh_token(
            label=f"{label}_oauth_401"
        ):
            return result

        result = request_raw(
            method,
            path,
            payload,
            label=f"{label}_retry_after_401",
        )

    return result


def viewer(
    name: str,
    columns: list[str],
    filter_sql: str,
    sort: str,
    *,
    label: str,
) -> tuple[
    int,
    Any | None,
    list[dict[str, Any]],
]:
    payload = {
        "COLUMNS":
        ", ".join(columns),

        "FILTER":
        filter_sql,

        "SORT":
        sort,
    }

    status, _, body, _, _ = api_call(
        "POST",
        f"/api/viewers/view/{name}",
        payload,
        label=label,
        safe_retry_401=True,
    )

    return (
        status,
        body,
        rows_from(
            body,
            name,
        ),
    )


def upload(
    upload_id: str,
    payload: dict[str, Any],
    *,
    label: str,
) -> tuple[
    int,
    str,
    Any | None,
    list[str],
]:
    # IMPORTANT:
    # No automatic retry for writes.
    #
    # We ensure the token is fresh before the POST. If the connection becomes
    # ambiguous during the POST, the caller must reconcile using Viewers.
    ensure_fresh_token(
        label=f"{label}_oauth_before_write"
    )

    status, raw, body, duplicates, _ = (
        request_raw(
            "POST",
            f"/api/uploads/upload/{upload_id}",
            payload,
            label=label,
        )
    )

    return (
        status,
        raw,
        body,
        duplicates,
    )


# =============================================================================
# REST LOG HELPERS
# =============================================================================


def group_rest_logs(
    rows: list[dict[str, Any]],
) -> dict[
    int,
    list[dict[str, Any]],
]:
    groups: dict[
        int,
        list[dict[str, Any]],
    ] = defaultdict(list)

    for row in rows:
        value = row.get(
            "UTREST_LOG_NO"
        )

        if value is None:
            continue

        try:
            groups[
                int(value)
            ].append(row)

        except Exception:
            continue

    return dict(groups)


def log_messages(
    rows: list[dict[str, Any]],
) -> list[str]:
    return [
        str(
            row.get("MESSAGE")
        )
        for row in rows
        if row.get("MESSAGE")
        not in (
            None,
            "",
        )
    ]


def order_li_log_groups(
    *,
    label: str,
) -> tuple[
    int,
    dict[
        int,
        list[dict[str, Any]],
    ],
]:
    status, _, rows = viewer(
        "VR_UTREST_LOG",
        [
            "UTREST_LOG_NO",
            "MODULE",
            "ENDPOINT",
            "PAYLOAD_SIZE",
            "MESSAGE",
            "CLIENT_NAME",
            "CLIENT_OWNER",
            "ENTRY_DATE",
            "ENTRY_TIME",
        ],
        (
            f"CLIENT_NAME = "
            f"'{CLIENT_NAME}' "
            "AND MODULE = 'UPLOADS' "
            f"AND ENDPOINT = "
            f"'{ORDER_LI_UPLOAD_ID}'"
        ),
        "UTREST_LOG_NO",
        label=label,
    )

    return (
        status,
        group_rest_logs(rows),
    )


def newest_group_after(
    before_log_no: int | None,
    *,
    label: str,
    attempts: int = 12,
) -> tuple[
    int | None,
    list[dict[str, Any]],
]:
    for _ in range(attempts):
        _, groups = order_li_log_groups(
            label=label,
        )

        current_max = (
            max(groups)
            if groups
            else None
        )

        if (
            current_max is not None
            and (
                before_log_no is None
                or current_max
                > before_log_no
            )
        ):
            return (
                current_max,
                groups[current_max],
            )

        time.sleep(1)

    return None, []


# =============================================================================
# CONTRACT / SOURCE CONTEXT
# =============================================================================


LINE_VIEW_COLUMNS = [
    "CTRL_NO",
    "STYLE",
    "CLR",
    "LINE_NO",
    "WH",
    "CUSTOMER",
    "CUST_NAME",
    "STORE",
    "ORDER_NO",
    "DIV",
    "PRICE",
    "SCALE",
    "SCALE_ABBR",
    "RATIO",
    "ORDER_QTY",
    "OPEN_QTY",
    "OFF_RATIO",
    "OFF_RATIO_APPR",

    *[
        f"OPEN_SZ{i}"
        for i
        in range(
            1,
            19,
        )
    ],
]


HEADER_VIEW_COLUMNS = [
    "CTRL_NO",
    "CUSTOMER",
    "CUST_NAME",
    "ORDER_NO",
    "STORE",
    "ORDER_DATE",
    "START_DATE",
    "CANCEL_DATE",
    "DIV",
    "TERMS",
    "TERMS_DESCR",
    "DEF_WH",
    "SHIP_VIA",
    "STATUS",
    "ORDER_TYPE",
    "ENTRY_DATE",
    "ENTERED_BY",
]


def size_vector(
    row: dict[str, Any],
    prefix: str = "OPEN_SZ",
) -> list[int]:
    return [
        intish(
            row.get(
                f"{prefix}{index}"
            )
        )
        for index
        in range(
            1,
            19,
        )
    ]


def normalize_ratio(
    vector: list[int],
) -> list[int]:
    positives = [
        value
        for value in vector
        if value > 0
    ]

    if not positives:
        return [
            0
            for _ in vector
        ]

    divisor = positives[0]

    for value in positives[1:]:
        divisor = math.gcd(
            divisor,
            value,
        )

    if divisor <= 0:
        return [
            0
            for _ in vector
        ]

    return [
        (
            value // divisor
            if value > 0
            else 0
        )
        for value in vector
    ]


def compact_vector(
    vector: list[int],
) -> str:
    values = [
        f"SZ{index}:{value}"
        for index, value
        in enumerate(
            vector,
            start=1,
        )
        if value
    ]

    return (
        ",".join(values)
        if values
        else "EMPTY"
    )


def source_line_spec(
    row: dict[str, Any],
    header: dict[str, Any],
) -> dict[str, Any] | None:
    if (
        not row.get("STYLE")
        or row.get("CLR") in (None, "")
    ):
        return None

    if (
        clean(row.get("CUSTOMER"))
        !=
        clean(header.get("CUSTOMER"))
    ):
        return None

    if (
        clean(row.get("STORE"))
        !=
        clean(header.get("STORE"))
    ):
        return None

    if (
        clean(row.get("DIV"))
        !=
        clean(header.get("DIV"))
    ):
        return None

    vector = size_vector(row)

    if not any(vector):
        return None

    bucket_total = sum(vector)
    order_qty = numeric(
        row.get("ORDER_QTY")
    )
    open_qty = numeric(
        row.get("OPEN_QTY")
    )

    if (
        open_qty is not None
        and int(round(open_qty))
        != bucket_total
    ):
        return None

    ratio = normalize_ratio(vector)

    if not any(ratio):
        return None

    return {
        "source_ctrl_no":
        intish(
            row.get("CTRL_NO")
        ),

        "source_line_no":
        intish(
            row.get("LINE_NO")
        ),

        "style":
        clean(
            row.get("STYLE")
        ),

        "color":
        clean(
            row.get("CLR")
        ),

        "warehouse":
        clean(
            row.get("WH")
        )
        or clean(
            header.get("DEF_WH")
        ),

        "price":
        numeric(
            row.get("PRICE")
        )
        or 1.0,

        "scale":
        clean(
            row.get("SCALE")
        ),

        "scale_abbr":
        clean(
            row.get("SCALE_ABBR")
        ),

        "ratio_field":
        row.get("RATIO"),

        "order_qty":
        order_qty,

        "open_qty":
        open_qty,

        "vector":
        vector,

        "vector_compact":
        compact_vector(vector),

        "normalized_ratio":
        ratio,

        "normalized_ratio_compact":
        compact_vector(ratio),

        "pack_total":
        sum(ratio),

        "bucket_total":
        bucket_total,

        "viewer_row":
        row,
    }


def load_source_context(
) -> tuple[
    dict[str, Any],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    header_http, _, header_rows = viewer(
        "VR_ORDER_HD",
        HEADER_VIEW_COLUMNS,
        f"CTRL_NO = {SOURCE_CTRL_NO}",
        "CTRL_NO",
        label="SRC-001_header",
    )

    if (
        header_http != 200
        or len(header_rows) != 1
    ):
        raise RuntimeError(
            "Source Header precondition failed"
        )

    source_header = header_rows[0]

    line_http, _, line_rows = viewer(
        "VR_ORDER_LI",
        LINE_VIEW_COLUMNS,
        f"CTRL_NO = {SOURCE_CTRL_NO}",
        "LINE_NO",
        label="SRC-002_lines",
    )

    if (
        line_http != 200
        or not line_rows
    ):
        raise RuntimeError(
            "Source Lines precondition failed"
        )

    specs = []

    seen = set()

    for row in line_rows:
        spec = source_line_spec(
            row,
            source_header,
        )

        if not spec:
            continue

        key = (
            spec["style"],
            spec["color"],
            spec["warehouse"],
            spec["price"],
        )

        if key in seen:
            continue

        seen.add(key)
        specs.append(spec)

    if not specs:
        raise RuntimeError(
            "No usable ratio-preserving source Lines found"
        )

    FACTS["source_header"] = (
        source_header
    )

    FACTS["source_line_specs"] = [
        {
            key:
            value
            for key, value
            in spec.items()
            if key != "viewer_row"
        }
        for spec in specs
    ]

    return (
        source_header,
        line_rows,
        specs,
    )


# =============================================================================
# HEADER / LINE BUILDERS
# =============================================================================


def make_order_no(
    tag: str,
) -> str:
    stamp = datetime.now(
        timezone.utc
    ).strftime(
        "%y%m%d%H%M%S"
    )

    return (
        f"RC{tag}{stamp}"
    )[:25]


def current_dates(
) -> tuple[str, str, str]:
    now = datetime.now(
        timezone.utc
    )

    return (
        now.strftime(
            "%m/%d/%y"
        ),
        (
            now
            +
            timedelta(days=7)
        ).strftime(
            "%m/%d/%y"
        ),
        (
            now
            +
            timedelta(days=14)
        ).strftime(
            "%m/%d/%y"
        ),
    )


def build_header_row(
    source_header: dict[str, Any],
    order_no: str,
) -> dict[str, Any]:
    order_date, start_date, cancel_date = (
        current_dates()
    )

    row: dict[str, Any] = {
        "CUST_NO":
        source_header["CUSTOMER"],

        "STORE_NO":
        str(
            source_header["STORE"]
        ),

        "ORDER_NO":
        order_no,

        "ORDER_DATE":
        order_date,

        "START_DATE":
        start_date,

        "CANCEL_DATE":
        cancel_date,

        "DIV_NO":
        source_header["DIV"],

        "TERM_NO":
        source_header["TERMS"],
    }

    if source_header.get("SHIP_VIA"):
        row["SHIP_VIA_NO"] = (
            source_header["SHIP_VIA"]
        )

    if source_header.get("DEF_WH"):
        row["DEF_WHOUSE"] = (
            source_header["DEF_WH"]
        )

    if source_header.get("ORDER_TYPE"):
        row["ORDER_TYPE"] = (
            source_header["ORDER_TYPE"]
        )

    return row


def build_line_row(
    *,
    seq_order_no: int,
    order_no: str,
    source_header: dict[str, Any],
    spec: dict[str, Any],
    line_no: int,
    exact_source_quantities: bool = True,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "SEQ_ORDER_NO":
        int(seq_order_no),

        "LINE_NO":
        int(line_no),

        "CUST_NO":
        source_header["CUSTOMER"],

        "STORE_NO":
        str(
            source_header["STORE"]
        ),

        "ORDER_NO":
        order_no,

        "STYLE":
        spec["style"],

        "COLOR_NO":
        spec["color"],

        "SALES_PRICE":
        spec["price"],

        "WHOUSE":
        spec["warehouse"],
    }

    vector = (
        spec["vector"]
        if exact_source_quantities
        else spec["normalized_ratio"]
    )

    for index, value in enumerate(
        vector,
        start=1,
    ):
        if value > 0:
            row[
                f"QTY_SZ{index}"
            ] = value

    return row


def successful_upload_body(
    status: int,
    body: Any,
    *,
    minimum_updated: int = 1,
) -> bool:
    return (
        status == 200
        and isinstance(
            body,
            dict,
        )
        and body.get("status")
        ==
        "Success"
        and intish(
            body.get("updated")
        )
        >=
        minimum_updated
    )


def create_header(
    source_header: dict[str, Any],
    *,
    tag: str,
    label: str,
) -> tuple[
    str,
    int,
    dict[str, Any],
    list[dict[str, Any]],
]:
    order_no = make_order_no(tag)

    _, _, before_rows = viewer(
        "VR_ORDER_HD",
        [
            "CTRL_NO",
            "ORDER_NO",
        ],
        (
            f"ORDER_NO = "
            f"'{order_no}'"
        ),
        "CTRL_NO",
        label=f"{label}_before",
    )

    if before_rows:
        raise RuntimeError(
            "Unique test ORDER_NO already visible before write"
        )

    header_row = build_header_row(
        source_header,
        order_no,
    )

    payload = {
        "IGNORE_ERRORS":
        "N",

        ORDER_HD_UPLOAD_ID: [
            header_row
        ],
    }

    status, raw, body, duplicates = upload(
        ORDER_HD_UPLOAD_ID,
        payload,
        label=f"{label}_upload",
    )

    save_json(
        f"{label}_upload_metadata.json",
        {
            "http_status":
            status,

            "duplicate_keys":
            duplicates,

            "raw_sha256":
            hashlib.sha256(
                raw.encode(
                    "utf-8"
                )
            ).hexdigest(),
        },
    )

    if (
        not successful_upload_body(
            status,
            body,
        )
        or not isinstance(
            body,
            dict,
        )
        or not isinstance(
            body.get("data"),
            list,
        )
        or not body["data"]
        or body["data"][0].get(
            "SEQ_ORDER_NO"
        )
        is None
    ):
        raise RuntimeError(
            "ORDER_HD did not return a successful SEQ_ORDER_NO"
        )

    seq_order_no = int(
        body["data"][0][
            "SEQ_ORDER_NO"
        ]
    )

    _, _, after_rows = viewer(
        "VR_ORDER_HD",
        HEADER_VIEW_COLUMNS,
        (
            f"CTRL_NO = "
            f"{seq_order_no} "
            f"AND ORDER_NO = "
            f"'{order_no}'"
        ),
        "CTRL_NO",
        label=f"{label}_after",
    )

    if len(after_rows) != 1:
        raise RuntimeError(
            "ORDER_HD succeeded but Viewer verification did not find exactly one Header"
        )

    return (
        order_no,
        seq_order_no,
        header_row,
        after_rows,
    )


# =============================================================================
# LIVE CONTRACTS
# =============================================================================


def read_define(
    path: str,
    required_key: str,
    *,
    label: str,
) -> tuple[
    int,
    Any,
    int,
]:
    status, _, body, _, _ = api_call(
        "GET",
        path,
        label=label,
        safe_retry_401=True,
    )

    count = 0

    if (
        status == 200
        and isinstance(
            body,
            dict,
        )
        and required_key in body
    ):
        if required_key in {
            ORDER_HD_UPLOAD_ID,
            ORDER_LI_UPLOAD_ID,
        }:
            rows = body.get(
                required_key,
                [],
            )

            if (
                isinstance(rows, list)
                and rows
                and isinstance(
                    rows[0],
                    dict,
                )
            ):
                count = len(
                    rows[0]
                )

        else:
            count = len(
                [
                    item.strip()
                    for item in str(
                        body.get(
                            "COLUMNS",
                            "",
                        )
                    ).split(",")
                    if item.strip()
                ]
            )

    return status, body, count


def certify_live_contracts(
) -> None:
    specs = [
        (
            "LIVE-001",
            f"{ORDER_HD_UPLOAD_ID} upload define",
            f"/api/uploads/define/{ORDER_HD_UPLOAD_ID}",
            ORDER_HD_UPLOAD_ID,
            60
            if ORDER_HD_UPLOAD_ID
            == "ORDER_HD"
            else None,
        ),
        (
            "LIVE-002",
            f"{ORDER_LI_UPLOAD_ID} upload define",
            f"/api/uploads/define/{ORDER_LI_UPLOAD_ID}",
            ORDER_LI_UPLOAD_ID,
            48
            if ORDER_LI_UPLOAD_ID
            == "ORDER_LI"
            else None,
        ),
        (
            "LIVE-003",
            "VR_ORDER_HD define",
            "/api/viewers/define/VR_ORDER_HD",
            "COLUMNS",
            135,
        ),
        (
            "LIVE-004",
            "VR_ORDER_LI define",
            "/api/viewers/define/VR_ORDER_LI",
            "COLUMNS",
            218,
        ),
        (
            "LIVE-005",
            "VR_UTREST_LOG define",
            "/api/viewers/define/VR_UTREST_LOG",
            "COLUMNS",
            13,
        ),
    ]

    FACTS["live_contracts"] = {}

    for (
        test_id,
        purpose,
        path,
        required_key,
        expected_count,
    ) in specs:
        status, body, count = read_define(
            path,
            required_key,
            label=test_id,
        )

        usable = (
            status == 200
            and isinstance(
                body,
                dict,
            )
            and required_key in body
        )

        drift = (
            expected_count is not None
            and count != expected_count
        )

        FACTS[
            "live_contracts"
        ][test_id] = {
            "path":
            path,

            "http_status":
            status,

            "count":
            count,

            "expected_count":
            expected_count,

            "drift":
            drift,
        }

        if not usable:
            add_test(
                test_id,
                purpose,
                "FAIL",
                finding=(
                    "Live contract is not usable."
                ),
                actual=FACTS[
                    "live_contracts"
                ][test_id],
                blocker=True,
            )

        elif drift:
            add_test(
                test_id,
                purpose,
                "WARN",
                finding=(
                    "Contract is reachable but field/column count drifted from the certified AMEXTEST baseline."
                ),
                actual=FACTS[
                    "live_contracts"
                ][test_id],
                risk="MEDIUM",
            )

        else:
            add_test(
                test_id,
                purpose,
                "PASS",
                finding=(
                    "Live contract is reachable and matches the certified count where a baseline is known."
                ),
                actual=FACTS[
                    "live_contracts"
                ][test_id],
            )


# =============================================================================
# LOCAL MASTER CORRELATION
# =============================================================================


def read_csv_rows(
    path: Path,
) -> list[dict[str, str]]:
    if not path.exists():
        return []

    with path.open(
        "r",
        encoding="utf-8-sig",
        newline="",
    ) as handle:
        return list(
            csv.DictReader(handle)
        )


def local_master_correlation(
    specs: list[dict[str, Any]],
) -> None:
    cache_dir = (
        API_DIR
        / "masters"
        / "cache"
    )

    upc_path = (
        cache_dir
        / "upc.csv"
    )

    sku_path = (
        cache_dir
        / "sku.csv"
    )

    upc_rows = read_csv_rows(
        upc_path
    )

    sku_rows = read_csv_rows(
        sku_path
    )

    result: list[
        dict[str, Any]
    ] = []

    for spec in specs[:4]:
        style = spec["style"].upper()
        color = spec["color"].upper()

        upc_matches = [
            row
            for row in upc_rows
            if clean(
                row.get("style")
            ).upper()
            ==
            style
            and clean(
                row.get("clr")
            ).upper()
            ==
            color
        ]

        sku_matches = [
            row
            for row in sku_rows
            if clean(
                row.get("style")
            ).upper()
            ==
            style
            and clean(
                row.get("clr")
            ).upper()
            ==
            color
        ]

        active_buckets = {
            index
            for index, value
            in enumerate(
                spec["vector"],
                start=1,
            )
            if value > 0
        }

        master_size_nums = {
            intish(
                row.get(
                    "size_num"
                )
            )
            for row in upc_matches
            if intish(
                row.get(
                    "size_num"
                )
            )
            in range(
                1,
                19,
            )
        }

        bucket_coverage = (
            bool(active_buckets)
            and active_buckets.issubset(
                master_size_nums
            )
        )

        item = {
            "style":
            style,

            "color":
            color,

            "source_scale":
            spec["scale"],

            "source_scale_abbr":
            spec["scale_abbr"],

            "source_active_buckets":
            sorted(
                active_buckets
            ),

            "upc_master_count":
            len(upc_matches),

            "sku_master_count":
            len(sku_matches),

            "master_size_nums":
            sorted(
                master_size_nums
            ),

            "bucket_coverage":
            bucket_coverage,

            "upc_rows":
            [
                {
                    "upc":
                    row.get("upc"),

                    "size_name":
                    row.get(
                        "size_name"
                    ),

                    "size_num":
                    row.get(
                        "size_num"
                    ),

                    "scale":
                    row.get("scale"),

                    "scale_abbr":
                    row.get(
                        "scale_abbr"
                    ),
                }
                for row
                in upc_matches
            ],
        }

        result.append(item)

    FACTS[
        "local_master_correlation"
    ] = result

    save_json(
        "master_correlation.json",
        result,
    )

    if not upc_rows:
        add_test(
            "MASTER-001",
            "Local UPC master cache availability",
            "WARN",
            finding=(
                "api/masters/cache/upc.csv was not found or was empty. Size-to-bucket mapping cannot be preflighted from the local cache."
            ),
            actual={
                "path":
                str(upc_path)
            },
            risk="MEDIUM",
        )

        return

    coverage_count = sum(
        1
        for item in result
        if item["bucket_coverage"]
    )

    add_test(
        "MASTER-001",
        "Correlate source OPEN_SZn buckets with local VR_UPC_STYLE size_num cache",
        (
            "PASS"
            if coverage_count
            ==
            len(result)
            else "WARN"
        ),
        finding=(
            f"{coverage_count}/{len(result)} selected source Style/Color combinations have active Viewer buckets fully covered by UPC master size_num values."
        ),
        actual=result,
        risk=(
            "NONE"
            if coverage_count
            ==
            len(result)
            else "MEDIUM"
        ),
    )


# =============================================================================
# TARGETED VIEWER DISCOVERY USING REAL MASTER NAMES FROM THE PROJECT
# =============================================================================


def targeted_master_viewer_discovery(
    spec: dict[str, Any],
) -> None:
    viewer_names = [
        "VR_SKU",
        "VR_SKU_Z",
        "VR_UPC_STYLE",
    ]

    discoveries = []

    for name in viewer_names:
        status, _, body, _, _ = api_call(
            "GET",
            f"/api/viewers/define/{name}",
            label=f"MASTER-VIEW-{name}_define",
            safe_retry_401=True,
        )

        if (
            status != 200
            or not isinstance(
                body,
                dict,
            )
            or "COLUMNS"
            not in body
        ):
            discoveries.append(
                {
                    "viewer":
                    name,

                    "define_http":
                    status,

                    "accessible":
                    False,
                }
            )
            continue

        columns = [
            item.strip()
            for item in str(
                body.get(
                    "COLUMNS",
                    "",
                )
            ).split(",")
            if item.strip()
        ]

        relevant = [
            column
            for column in columns
            if re.search(
                (
                    r"STYLE|CLR|COLOR|"
                    r"SCALE|SIZE|SZ|"
                    r"RATIO|PACK|SKU|UPC|DIV"
                ),
                column,
                re.I,
            )
        ][:40]

        filter_parts = []

        if "STYLE" in columns:
            filter_parts.append(
                f"STYLE = '{spec['style']}'"
            )

        if "CLR" in columns:
            filter_parts.append(
                f"CLR = '{spec['color']}'"
            )

        elif "COLOR_NO" in columns:
            filter_parts.append(
                f"COLOR_NO = '{spec['color']}'"
            )

        query_rows: list[
            dict[str, Any]
        ] = []

        query_http = None

        if (
            relevant
            and filter_parts
        ):
            sort = (
                "STYLE"
                if "STYLE" in columns
                else relevant[0]
            )

            query_http, _, query_rows = viewer(
                name,
                relevant,
                " AND ".join(
                    filter_parts
                ),
                sort,
                label=f"MASTER-VIEW-{name}_query",
            )

        discoveries.append(
            {
                "viewer":
                name,

                "define_http":
                status,

                "accessible":
                True,

                "column_count":
                len(columns),

                "relevant_columns":
                relevant,

                "filter":
                " AND ".join(
                    filter_parts
                ),

                "query_http":
                query_http,

                "query_count":
                len(query_rows),

                "sample_rows":
                query_rows[:25],
            }
        )

    FACTS[
        "targeted_master_viewers"
    ] = discoveries

    save_json(
        "targeted_master_viewers.json",
        discoveries,
    )

    accessible = [
        item
        for item in discoveries
        if item.get("accessible")
    ]

    add_test(
        "MASTER-002",
        "Targeted A2000 Viewer discovery for project master names VR_SKU, VR_SKU_Z and VR_UPC_STYLE",
        (
            "PASS"
            if accessible
            else "WARN"
        ),
        finding=(
            f"{len(accessible)}/{len(discoveries)} targeted project-backed Viewer names are accessible through REST."
        ),
        actual=discoveries,
        risk=(
            "NONE"
            if accessible
            else "LOW"
        ),
    )


# =============================================================================
# STATIC PRODUCTION CODE SCAN
# =============================================================================


def file_text(
    path: Path,
) -> str:
    if not path.exists():
        return ""

    return path.read_text(
        encoding="utf-8",
        errors="replace",
    )


def production_code_scan(
) -> None:
    citi_parser = (
        API_DIR
        / "src"
        / "po"
        / "parsers"
        / "cititrends.js"
    )

    parser_index = (
        API_DIR
        / "src"
        / "po"
        / "parsers"
        / "index.js"
    )

    export_batch = (
        API_DIR
        / "src"
        / "a2000"
        / "exportBatch.js"
    )

    server_js = (
        API_DIR
        / "src"
        / "server.js"
    )

    a2000_dir = (
        API_DIR
        / "src"
        / "a2000"
    )

    citi_text = file_text(
        citi_parser
    )

    parser_index_text = file_text(
        parser_index
    )

    export_text = file_text(
        export_batch
    )

    server_text = file_text(
        server_js
    )

    findings = []

    if (
        "qty_sz1: int(detail[6])"
        in citi_text
    ):
        findings.append(
            {
                "id":
                "CODE-BLOCKER-001",

                "severity":
                "BLOCKER",

                "finding":
                (
                    "Citi parser currently places every PDF size quantity in qty_sz1 instead of mapping size_raw to A2000 Size Num / QTY_SZn."
                ),

                "file":
                str(
                    citi_parser.relative_to(
                        PROJECT
                    )
                ),
            }
        )

    if (
        "['style_code', 'color_code', 'warehouse_code', 'qty_sz1']"
        in parser_index_text
    ):
        findings.append(
            {
                "id":
                "CODE-BLOCKER-002",

                "severity":
                "BLOCKER",

                "finding":
                (
                    "Parser quality gate requires qty_sz1 specifically. A valid sized A2000 line may use QTY_SZ4..QTY_SZ7 and have qty_sz1 empty."
                ),

                "file":
                str(
                    parser_index.relative_to(
                        PROJECT
                    )
                ),
            }
        )

    if (
        "row.QTY_SZ1 = clean(line.qty_sz1 ?? line.quantity ?? line.qty_total)"
        in export_text
    ):
        findings.append(
            {
                "id":
                "CODE-BLOCKER-003",

                "severity":
                "BLOCKER",

                "finding":
                (
                    "CSV export fallback can collapse qty_total into QTY_SZ1 when no qty_sz1 exists, which reproduces the out-of-ratio failure observed in AMEXTEST."
                ),

                "file":
                str(
                    export_batch.relative_to(
                        PROJECT
                    )
                ),
            }
        )

    if (
        "row.QTY_SZ1 = cleanExportValue(line.qty_sz1 ?? line.quantity ?? line.qty_total)"
        in server_text
    ):
        findings.append(
            {
                "id":
                "CODE-BLOCKER-004",

                "severity":
                "BLOCKER",

                "finding":
                (
                    "The /po/export-a2000-import lab/export path writes only QTY_SZ1 and does not preserve qty_sz2..qty_sz18."
                ),

                "file":
                str(
                    server_js.relative_to(
                        PROJECT
                    )
                ),
            }
        )

    rest_adapter_files = (
        list(
            a2000_dir.glob(
                "*RestAdapter*.js"
            )
        )
        +
        list(
            a2000_dir.glob(
                "*restAdapter*.js"
            )
        )
    )

    if not rest_adapter_files:
        findings.append(
            {
                "id":
                "CODE-BLOCKER-005",

                "severity":
                "BLOCKER",

                "finding":
                (
                    "No A2000 REST Adapter file is present in api/src/a2000. The live API path is certified, but the project code is still CSV-oriented."
                ),

                "file":
                str(
                    a2000_dir.relative_to(
                        PROJECT
                    )
                ),
            }
        )

    job_patterns = [
        "HEADER_CREATED_LINES_FAILED",
        "reconciliation_required",
        "a2000_seq_order_no",
        "idempotency_key",
    ]

    all_api_js = ""

    for path in (
        API_DIR
        / "src"
    ).rglob("*.js"):
        all_api_js += (
            "\n"
            +
            file_text(path)
        )

    missing_job_patterns = [
        pattern
        for pattern in job_patterns
        if pattern not in all_api_js
    ]

    if missing_job_patterns:
        findings.append(
            {
                "id":
                "CODE-BLOCKER-006",

                "severity":
                "BLOCKER",

                "finding":
                (
                    "The API source does not yet show the persistent REST saga/idempotency markers required to avoid duplicate Headers and resume Lines safely."
                ),

                "missing_patterns":
                missing_job_patterns,
            }
        )

    FACTS[
        "production_code_scan"
    ] = findings

    save_json(
        "production_code_scan.json",
        findings,
    )

    blockers = [
        item
        for item in findings
        if item["severity"]
        ==
        "BLOCKER"
    ]

    add_test(
        "CODE-001",
        "Static project scan for known A2000 REST production blockers",
        (
            "FAIL"
            if blockers
            else "PASS"
        ),
        finding=(
            f"{len(blockers)} blocking code findings remain before production."
        ),
        actual=findings,
        risk=(
            "HIGH"
            if blockers
            else "NONE"
        ),
        blocker=bool(blockers),
    )


# =============================================================================
# READ-ONLY CORE
# =============================================================================


def run_readonly_core(
) -> tuple[
    dict[str, Any],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    certify_live_contracts()

    source_header, source_rows, specs = (
        load_source_context()
    )

    add_test(
        "SRC-001",
        "Read exact source Header context",
        "PASS",
        finding=(
            "Source Sales Order Header was loaded by exact CTRL_NO."
        ),
        actual={
            "ctrl_no":
            source_header.get(
                "CTRL_NO"
            ),

            "customer":
            source_header.get(
                "CUSTOMER"
            ),

            "store":
            source_header.get(
                "STORE"
            ),

            "division":
            source_header.get(
                "DIV"
            ),

            "terms":
            source_header.get(
                "TERMS"
            ),

            "warehouse":
            source_header.get(
                "DEF_WH"
            ),

            "ship_via":
            source_header.get(
                "SHIP_VIA"
            ),
        },
    )

    add_test(
        "SRC-002",
        "Read real source Lines and derive size distributions",
        "PASS",
        finding=(
            f"{len(source_rows)} source Viewer rows loaded; {len(specs)} distinct usable ratio-preserving Style/Color contexts derived."
        ),
        actual=[
            {
                key:
                value
                for key, value
                in spec.items()
                if key != "viewer_row"
            }
            for spec in specs
        ],
    )

    local_master_correlation(
        specs
    )

    targeted_master_viewer_discovery(
        specs[0]
    )

    production_code_scan()

    return (
        source_header,
        source_rows,
        specs,
    )


# =============================================================================
# PHASE: MULTILINE SUCCESS
# =============================================================================


def run_multiline(
    source_header: dict[str, Any],
    specs: list[dict[str, Any]],
) -> None:
    if not ORDER_LI_CLEAR_CONFIRMED:
        add_test(
            "WRITE-GATE-001",
            "Manual ORDER_LI pending-file clean confirmation",
            "FAIL",
            finding=(
                "Write phase blocked. Inspect ORDER_LI Upload Utility and set A2000_ORDER_LI_CLEARED=YES only after it is empty/CLEAR was performed in AMEXTEST."
            ),
            risk="HIGH",
            blocker=True,
        )
        return

    if len(specs) < 2:
        add_test(
            "MULTI-001",
            "Select two distinct real source Lines",
            "FAIL",
            finding=(
                "At least two usable distinct Style/Color source Lines are required."
            ),
            blocker=True,
        )
        return

    selected = specs[:2]

    order_no, seq, header_row, header_rows = (
        create_header(
            source_header,
            tag="ML",
            label="MULTI-001_header",
        )
    )

    add_test(
        "MULTI-001",
        "Create one unique Header for the two-Line batch",
        "PASS",
        finding=(
            "ORDER_HD returned SEQ_ORDER_NO and VR_ORDER_HD exposed the same CTRL_NO."
        ),
        actual={
            "order_no":
            order_no,

            "seq_order_no":
            seq,

            "header_payload":
            header_row,

            "viewer_count":
            len(header_rows),
        },
        risk="MEDIUM",
    )

    line_rows = [
        build_line_row(
            seq_order_no=seq,
            order_no=order_no,
            source_header=source_header,
            spec=spec,
            line_no=index,
            exact_source_quantities=True,
        )
        for index, spec
        in enumerate(
            selected,
            start=1,
        )
    ]

    payload = {
        "IGNORE_ERRORS":
        "N",

        ORDER_LI_UPLOAD_ID:
        line_rows,
    }

    _, before_groups = (
        order_li_log_groups(
            label="MULTI-002_log_before",
        )
    )

    before_log_no = (
        max(before_groups)
        if before_groups
        else None
    )

    status, raw, body, duplicates = upload(
        ORDER_LI_UPLOAD_ID,
        payload,
        label="MULTI-002_lines_upload",
    )

    new_log_no, new_log_rows = (
        newest_group_after(
            before_log_no,
            label="MULTI-002_log_after",
        )
    )

    _, _, viewer_rows = viewer(
        "VR_ORDER_LI",
        LINE_VIEW_COLUMNS,
        f"CTRL_NO = {seq}",
        "LINE_NO",
        label="MULTI-002_verify",
    )

    distribution_checks = []

    expected_by_line = {
        int(
            row["LINE_NO"]
        ):
        row
        for row in line_rows
    }

    actual_by_line = {
        intish(
            row.get(
                "LINE_NO"
            )
        ):
        row
        for row in viewer_rows
    }

    for line_no, expected in (
        expected_by_line.items()
    ):
        actual = actual_by_line.get(
            line_no
        )

        checks = {
            "line_no":
            line_no,

            "viewer_found":
            actual is not None,

            "style_match":
            bool(
                actual
                and clean(
                    actual.get(
                        "STYLE"
                    )
                )
                ==
                clean(
                    expected.get(
                        "STYLE"
                    )
                )
            ),

            "color_match":
            bool(
                actual
                and clean(
                    actual.get(
                        "CLR"
                    )
                )
                ==
                clean(
                    expected.get(
                        "COLOR_NO"
                    )
                )
            ),

            "bucket_matches":
            {},
        }

        for index in range(
            1,
            19,
        ):
            expected_qty = intish(
                expected.get(
                    f"QTY_SZ{index}"
                )
            )

            actual_qty = intish(
                actual.get(
                    f"OPEN_SZ{index}"
                )
                if actual
                else None
            )

            if (
                expected_qty
                or actual_qty
            ):
                checks[
                    "bucket_matches"
                ][
                    f"SZ{index}"
                ] = {
                    "expected":
                    expected_qty,

                    "actual":
                    actual_qty,

                    "match":
                    expected_qty
                    ==
                    actual_qty,
                }

        checks[
            "all_bucket_matches"
        ] = all(
            item["match"]
            for item in checks[
                "bucket_matches"
            ].values()
        )

        distribution_checks.append(
            checks
        )

    body_success = successful_upload_body(
        status,
        body,
        minimum_updated=2,
    )

    viewer_success = (
        len(viewer_rows)
        ==
        2
        and all(
            item["viewer_found"]
            and item["style_match"]
            and item["color_match"]
            and item[
                "all_bucket_matches"
            ]
            for item
            in distribution_checks
        )
    )

    log_text = "\n".join(
        log_messages(
            new_log_rows
        )
    )

    log_success = (
        "updated: 2"
        in log_text.lower()
        and "errors: 0"
        in log_text.lower()
    )

    full_success = (
        body_success
        and viewer_success
        and log_success
    )

    FACTS["multiline"] = {
        "order_no":
        order_no,

        "seq_order_no":
        seq,

        "http_status":
        status,

        "body":
        body,

        "duplicate_json_keys":
        duplicates,

        "new_log_no":
        new_log_no,

        "new_log_messages":
        log_messages(
            new_log_rows
        ),

        "viewer_count":
        len(viewer_rows),

        "distribution_checks":
        distribution_checks,

        "full_success":
        full_success,
    }

    add_test(
        "MULTI-002",
        "Upload two valid ORDER_LI rows in one IGNORE_ERRORS=N batch and verify exact size distributions",
        (
            "PASS"
            if full_success
            else "FAIL"
        ),
        finding=(
            "Two-Line batch succeeded, updated two rows, and Viewer size buckets matched the exact source quantities."
            if full_success
            else
            "Two-Line batch did not satisfy body + Viewer distribution + REST-log success criteria."
        ),
        actual=FACTS["multiline"],
        risk="MEDIUM",
        blocker=not full_success,
    )

    if full_success:
        state = {
            "certified_at":
            datetime.now(
                timezone.utc
            ).isoformat(),

            "source_ctrl_no":
            SOURCE_CTRL_NO,

            "source_header":
            source_header,

            "order_no":
            order_no,

            "seq_order_no":
            seq,

            "header_row":
            header_row,

            "line_rows":
            line_rows,

            "viewer_rows":
            viewer_rows,
        }

        TRAINING_ROOT.mkdir(
            parents=True,
            exist_ok=True,
        )

        STATE_FILE.write_text(
            json.dumps(
                state,
                indent=2,
                ensure_ascii=False,
                default=str,
            ),
            encoding="utf-8",
        )

        FACTS[
            "state_file"
        ] = str(
            STATE_FILE
        )


# =============================================================================
# STATE FOR FOLLOW-UP PHASES
# =============================================================================


def load_state(
) -> dict[str, Any]:
    if not STATE_FILE.exists():
        raise RuntimeError(
            (
                "No successful multiline state file found. "
                "Run A2000_CERT_PHASE=multiline first."
            )
        )

    state = json.loads(
        STATE_FILE.read_text(
            encoding="utf-8"
        )
    )

    required = {
        "order_no",
        "seq_order_no",
        "line_rows",
        "source_header",
    }

    if not required.issubset(
        state
    ):
        raise RuntimeError(
            "State file is incomplete"
        )

    return state


# =============================================================================
# PHASE: DUPLICATE LINE
# =============================================================================


def run_duplicate_line(
) -> None:
    if not ORDER_LI_CLEAR_CONFIRMED:
        add_test(
            "WRITE-GATE-001",
            "Manual ORDER_LI pending-file clean confirmation",
            "FAIL",
            finding=(
                "Duplicate phase blocked until ORDER_LI pending data is inspected and cleared in AMEXTEST."
            ),
            risk="HIGH",
            blocker=True,
        )
        return

    state = load_state()

    seq = int(
        state["seq_order_no"]
    )

    order_no = str(
        state["order_no"]
    )

    line_rows = state[
        "line_rows"
    ]

    _, _, before_rows = viewer(
        "VR_ORDER_LI",
        LINE_VIEW_COLUMNS,
        f"CTRL_NO = {seq}",
        "LINE_NO",
        label="DUP-001_before",
    )

    before_count = len(
        before_rows
    )

    if (
        before_count
        <
        len(line_rows)
    ):
        add_test(
            "DUP-001",
            "Duplicate Line test precondition",
            "FAIL",
            finding=(
                "Previously certified Lines are no longer fully visible."
            ),
            actual={
                "before_count":
                before_count,

                "state_line_count":
                len(line_rows),
            },
            blocker=True,
        )
        return

    duplicate_row = dict(
        line_rows[0]
    )

    payload = {
        "IGNORE_ERRORS":
        "N",

        ORDER_LI_UPLOAD_ID: [
            duplicate_row
        ],
    }

    _, before_groups = (
        order_li_log_groups(
            label="DUP-001_log_before",
        )
    )

    before_log_no = (
        max(before_groups)
        if before_groups
        else None
    )

    status, _, body, duplicates = upload(
        ORDER_LI_UPLOAD_ID,
        payload,
        label="DUP-001_upload",
    )

    new_log_no, new_log_rows = (
        newest_group_after(
            before_log_no,
            label="DUP-001_log_after",
        )
    )

    _, _, after_rows = viewer(
        "VR_ORDER_LI",
        LINE_VIEW_COLUMNS,
        f"CTRL_NO = {seq}",
        "LINE_NO",
        label="DUP-001_after",
    )

    after_count = len(
        after_rows
    )

    log_text = "\n".join(
        log_messages(
            new_log_rows
        )
    )

    already_on_file = (
        "already on file"
        in log_text.lower()
    )

    duplicate_line_numbers = Counter(
        intish(
            row.get(
                "LINE_NO"
            )
        )
        for row in after_rows
    )

    visible_duplicate = any(
        count > 1
        for count
        in duplicate_line_numbers.values()
        if count
    )

    safe_rejection = (
        after_count == before_count
        and not visible_duplicate
        and (
            already_on_file
            or (
                isinstance(
                    body,
                    dict,
                )
                and body.get("status")
                ==
                "Fail"
                and intish(
                    body.get("updated")
                )
                ==
                0
            )
        )
    )

    FACTS["duplicate_line"] = {
        "order_no":
        order_no,

        "seq_order_no":
        seq,

        "http_status":
        status,

        "body":
        body,

        "duplicate_json_keys":
        duplicates,

        "before_count":
        before_count,

        "after_count":
        after_count,

        "visible_duplicate":
        visible_duplicate,

        "already_on_file":
        already_on_file,

        "new_log_no":
        new_log_no,

        "new_log_messages":
        log_messages(
            new_log_rows
        ),

        "safe_rejection":
        safe_rejection,

        "cleanup_required":
        True,
    }

    add_test(
        "DUP-001",
        "Repost an already-created ORDER_LI row and characterize duplicate behavior",
        (
            "PASS"
            if safe_rejection
            else "FAIL"
        ),
        finding=(
            "Duplicate Line was rejected without increasing Viewer row count."
            if safe_rejection
            else
            "Duplicate behavior is unsafe or inconclusive."
        ),
        actual=FACTS[
            "duplicate_line"
        ],
        risk="HIGH",
        blocker=not safe_rejection,
    )


# =============================================================================
# PHASE: ORDER_LI ROLLBACK
# =============================================================================


def run_rollback_line(
    source_header: dict[str, Any],
    specs: list[dict[str, Any]],
) -> None:
    if not ORDER_LI_CLEAR_CONFIRMED:
        add_test(
            "WRITE-GATE-001",
            "Manual ORDER_LI pending-file clean confirmation",
            "FAIL",
            finding=(
                "Rollback phase blocked until ORDER_LI pending data is inspected and cleared in AMEXTEST."
            ),
            risk="HIGH",
            blocker=True,
        )
        return

    if len(specs) < 2:
        add_test(
            "ROLL-001",
            "Rollback test source precondition",
            "FAIL",
            finding=(
                "Need at least two source specs."
            ),
            blocker=True,
        )
        return

    order_no, seq, _, _ = create_header(
        source_header,
        tag="RB",
        label="ROLL-001_header",
    )

    valid_row = build_line_row(
        seq_order_no=seq,
        order_no=order_no,
        source_header=source_header,
        spec=specs[0],
        line_no=1,
        exact_source_quantities=True,
    )

    invalid_row = build_line_row(
        seq_order_no=seq,
        order_no=order_no,
        source_header=source_header,
        spec=specs[1],
        line_no=2,
        exact_source_quantities=True,
    )

    invalid_row["STYLE"] = (
        "ZZ_CERT_BAD_STYLE"
    )

    payload = {
        "IGNORE_ERRORS":
        "N",

        ORDER_LI_UPLOAD_ID: [
            valid_row,
            invalid_row,
        ],
    }

    _, before_groups = (
        order_li_log_groups(
            label="ROLL-002_log_before",
        )
    )

    before_log_no = (
        max(before_groups)
        if before_groups
        else None
    )

    status, _, body, duplicates = upload(
        ORDER_LI_UPLOAD_ID,
        payload,
        label="ROLL-002_upload",
    )

    new_log_no, new_log_rows = (
        newest_group_after(
            before_log_no,
            label="ROLL-002_log_after",
        )
    )

    _, _, after_rows = viewer(
        "VR_ORDER_LI",
        LINE_VIEW_COLUMNS,
        f"CTRL_NO = {seq}",
        "LINE_NO",
        label="ROLL-002_verify",
    )

    body_failed_zero = (
        status == 200
        and isinstance(
            body,
            dict,
        )
        and body.get("status")
        ==
        "Fail"
        and intish(
            body.get("updated")
        )
        ==
        0
    )

    viewer_zero = (
        len(after_rows) == 0
    )

    rollback_confirmed = (
        body_failed_zero
        and viewer_zero
    )

    FACTS["rollback_line"] = {
        "order_no":
        order_no,

        "seq_order_no":
        seq,

        "http_status":
        status,

        "body":
        body,

        "duplicate_json_keys":
        duplicates,

        "viewer_count":
        len(after_rows),

        "new_log_no":
        new_log_no,

        "new_log_messages":
        log_messages(
            new_log_rows
        ),

        "rollback_confirmed":
        rollback_confirmed,

        "cleanup_required":
        True,
    }

    add_test(
        "ROLL-002",
        "Upload one valid Line and one deliberately invalid Line with IGNORE_ERRORS=N",
        (
            "PASS"
            if rollback_confirmed
            else "FAIL"
        ),
        finding=(
            "ORDER_LI behaved all-or-nothing for the tested batch: updated=0 and the valid first Line was not visible."
            if rollback_confirmed
            else
            "ORDER_LI rollback behavior was not confirmed."
        ),
        actual=FACTS[
            "rollback_line"
        ],
        risk="HIGH",
        blocker=not rollback_confirmed,
    )


# =============================================================================
# REPORT / GO-NO-GO
# =============================================================================


def production_gates(
) -> dict[str, Any]:
    test_by_id = {
        test["test_id"]:
        test
        for test in TESTS
    }

    live_contracts_ok = all(
        test_by_id.get(test_id, {}).get(
            "result"
        )
        in {
            "PASS",
            "WARN",
        }
        for test_id in [
            "LIVE-001",
            "LIVE-002",
            "LIVE-003",
            "LIVE-004",
            "LIVE-005",
        ]
    )

    source_context_ok = (
        test_by_id.get(
            "SRC-001",
            {},
        ).get("result")
        ==
        "PASS"
        and
        test_by_id.get(
            "SRC-002",
            {},
        ).get("result")
        ==
        "PASS"
    )

    code_blockers = [
        item
        for item in FACTS.get(
            "production_code_scan",
            []
        )
        if item.get("severity")
        ==
        "BLOCKER"
    ]

    multiline_pass = (
        FACTS.get(
            "multiline",
            {},
        ).get(
            "full_success"
        )
        is True
    )

    duplicate_pass = (
        FACTS.get(
            "duplicate_line",
            {},
        ).get(
            "safe_rejection"
        )
        is True
    )

    rollback_pass = (
        FACTS.get(
            "rollback_line",
            {},
        ).get(
            "rollback_confirmed"
        )
        is True
    )

    shared_upload_ids = (
        ORDER_HD_UPLOAD_ID
        ==
        "ORDER_HD"
        or
        ORDER_LI_UPLOAD_ID
        ==
        "ORDER_LI"
    )

    return {
        "api_contracts":
        live_contracts_ok,

        "source_context":
        source_context_ok,

        "multiline":
        multiline_pass,

        "duplicate_line":
        duplicate_pass,

        "rollback_line":
        rollback_pass,

        "code_blocker_count":
        len(code_blockers),

        "shared_upload_ids":
        shared_upload_ids,

        "dedicated_upload_ids":
        not shared_upload_ids,
    }


def final_recommendation(
    gates: dict[str, Any],
) -> str:
    if PHASE in {
        "readonly",
        "production-readonly",
    }:
        if (
            gates["api_contracts"]
            and gates["source_context"]
        ):
            return (
                "API_CAPABILITY_CERTIFIED_CODE_FIXES_AND_WRITE_BEHAVIOR_GATES_REMAIN"
            )

        return (
            "NO_GO_READONLY_CONTRACT_OR_SOURCE_BLOCKER"
        )

    if PHASE == "multiline":
        return (
            "MULTILINE_GATE_PASS_CONTINUE_DUPLICATE_AND_ROLLBACK"
            if gates["multiline"]
            else
            "NO_GO_FIX_MULTILINE"
        )

    if PHASE == "duplicate-line":
        return (
            "DUPLICATE_LINE_GATE_PASS_CLEAR_ORDER_LI_THEN_RUN_ROLLBACK"
            if gates[
                "duplicate_line"
            ]
            else
            "NO_GO_DUPLICATE_LINE_UNSAFE"
        )

    if PHASE == "rollback-line":
        return (
            "ORDER_LI_BEHAVIOR_CERTIFIED_IMPLEMENT_PRODUCTION_ADAPTER"
            if gates[
                "rollback_line"
            ]
            else
            "NO_GO_ORDER_LI_ROLLBACK_NOT_CONFIRMED"
        )

    return "UNKNOWN"


def report_markdown(
    gates: dict[str, Any],
    recommendation: str,
) -> str:
    lines = [
        "# A2000 RELEASE CANDIDATE CERTIFICATION",
        "",
        f"- Run ID: `{RUN_ID}`",
        f"- Phase: `{PHASE}`",
        f"- Base URL: `{BASE}`",
        f"- ORDER_HD Upload ID: `{ORDER_HD_UPLOAD_ID}`",
        f"- ORDER_LI Upload ID: `{ORDER_LI_UPLOAD_ID}`",
        f"- Env source: `{ENV_SOURCE}`",
        f"- Recommendation: `{recommendation}`",
        "",
        "## Production gates",
        "",
        "```json",
        json.dumps(
            gates,
            indent=2,
            ensure_ascii=False,
        ),
        "```",
        "",
        "## Test matrix",
        "",
        "| Test | Result | Risk | Blocker | Purpose | Finding |",
        "|---|---|---|---|---|---|",
    ]

    for test in TESTS:
        lines.append(
            "| "
            +
            " | ".join(
                [
                    str(
                        test[
                            "test_id"
                        ]
                    ).replace(
                        "|",
                        "\\|",
                    ),
                    str(
                        test[
                            "result"
                        ]
                    ),
                    str(
                        test[
                            "risk"
                        ]
                    ),
                    str(
                        test[
                            "blocker"
                        ]
                    ),
                    str(
                        test[
                            "purpose"
                        ]
                    ).replace(
                        "|",
                        "\\|",
                    ).replace(
                        "\n",
                        " ",
                    ),
                    str(
                        test[
                            "finding"
                        ]
                    ).replace(
                        "|",
                        "\\|",
                    ).replace(
                        "\n",
                        " ",
                    ),
                ]
            )
            +
            " |"
        )

    lines.extend(
        [
            "",
            "## Facts",
            "",
            "```json",
            json.dumps(
                FACTS,
                indent=2,
                ensure_ascii=False,
                default=str,
            ),
            "```",
            "",
            "## Raw response index",
            "",
            "```json",
            json.dumps(
                RAW_INDEX,
                indent=2,
                ensure_ascii=False,
                default=str,
            ),
            "```",
        ]
    )

    return (
        "\n".join(lines)
        +
        "\n"
    )


# =============================================================================
# MAIN
# =============================================================================


def main() -> int:
    emit(
        "=" * 80
    )

    emit(
        "A2000 RELEASE CANDIDATE CERTIFICATION"
    )

    emit(
        "=" * 80
    )

    emit(
        f"RUN_ID={RUN_ID}"
    )

    emit(
        f"PHASE={PHASE}"
    )

    emit(
        f"RUN_DIR={RUN}"
    )

    emit(
        f"BASE_URL={BASE or 'NOT_SET'}"
    )

    emit(
        f"ENV_SOURCE={ENV_SOURCE or 'NONE'}"
    )

    emit(
        f"CLIENT_ID_SET={bool(CLIENT_ID)}"
    )

    emit(
        f"CLIENT_SECRET_SET={bool(CLIENT_SECRET)}"
    )

    emit(
        "SECRETS_WILL_NOT_BE_PRINTED=YES"
    )

    emit(
        f"ORDER_HD_UPLOAD_ID={ORDER_HD_UPLOAD_ID}"
    )

    emit(
        f"ORDER_LI_UPLOAD_ID={ORDER_LI_UPLOAD_ID}"
    )

    emit(
        f"ORDER_LI_CLEAR_CONFIRMED={ORDER_LI_CLEAR_CONFIRMED}"
    )

    if PHASE not in VALID_PHASES:
        add_test(
            "ENV-001",
            "Certification phase",
            "FAIL",
            finding=(
                f"Invalid phase: {PHASE}"
            ),
            blocker=True,
        )

        return 2

    if (
        not BASE
        or not CLIENT_ID
        or not CLIENT_SECRET
    ):
        add_test(
            "ENV-001",
            "A2000 environment",
            "FAIL",
            finding=(
                "Missing A2000_BASE_URL, A2000_CLIENT_ID or A2000_CLIENT_SECRET."
            ),
            blocker=True,
        )

        return 3

    write_phase = (
        PHASE in WRITE_PHASES
    )

    is_amextest = (
        "amextest.a2000cloud.com"
        in BASE.lower()
        and
        "/ords/amxtest"
        in BASE.lower()
    )

    if (
        write_phase
        and not is_amextest
    ):
        add_test(
            "ENV-001",
            "Write safety guard",
            "FAIL",
            finding=(
                "WRITE PHASE BLOCKED OUTSIDE AMEXTEST."
            ),
            actual={
                "base_url":
                BASE,

                "phase":
                PHASE,
            },
            risk="CRITICAL",
            blocker=True,
        )

        return 4

    add_test(
        "ENV-001",
        "Environment and write safety",
        "PASS",
        finding=(
            "Required variables are available. Writes are hard-blocked outside AMEXTEST."
        ),
        actual={
            "base_url":
            BASE,

            "phase":
            PHASE,

            "is_amextest":
            is_amextest,

            "env_source":
            ENV_SOURCE,
        },
    )

    if not refresh_token(
        label="AUTH-001"
    ):
        add_test(
            "AUTH-001",
            "OAuth client_credentials",
            "FAIL",
            finding=(
                "Could not obtain Bearer token."
            ),
            blocker=True,
        )

        return 5

    add_test(
        "AUTH-001",
        "OAuth client_credentials",
        "PASS",
        finding=(
            "Bearer token obtained without printing token or secret."
        ),
        actual=FACTS[
            "oauth"
        ],
    )

    try:
        (
            source_header,
            _,
            specs,
        ) = run_readonly_core()

        if PHASE in {
            "readonly",
            "production-readonly",
        }:
            pass

        elif PHASE == "multiline":
            run_multiline(
                source_header,
                specs,
            )

        elif PHASE == "duplicate-line":
            run_duplicate_line()

        elif PHASE == "rollback-line":
            run_rollback_line(
                source_header,
                specs,
            )

    except Exception as exc:
        add_test(
            "UNHANDLED-001",
            "Unhandled certification exception",
            "FAIL",
            finding=str(exc),
            actual={
                "exception_type":
                type(exc).__name__,
            },
            risk="HIGH",
            blocker=True,
        )

    gates = production_gates()

    recommendation = (
        final_recommendation(
            gates
        )
    )

    FACTS[
        "production_gates"
    ] = gates

    FACTS[
        "recommendation"
    ] = recommendation

    save_json(
        "test_matrix.json",
        TESTS,
    )

    save_json(
        "facts.json",
        FACTS,
    )

    save_json(
        "raw_response_index.json",
        RAW_INDEX,
    )

    save_text(
        "CERTIFICATION_REPORT.md",
        report_markdown(
            gates,
            recommendation,
        ),
    )

    hard_failures = {
        test["test_id"]:
        test["finding"]
        for test in TESTS
        if (
            test["result"]
            ==
            "FAIL"
            and test["blocker"]
        )
    }

    emit()
    emit(
        "=" * 80
    )

    emit(
        "COPY THIS RESULT TO CHATGPT"
    )

    emit(
        "=" * 80
    )

    emit(
        f"RUN_ID={RUN_ID}"
    )

    emit(
        f"PHASE={PHASE}"
    )

    emit(
        f"RUN_DIR={RUN}"
    )

    emit(
        f"BASE_URL={BASE}"
    )

    emit(
        f"ORDER_HD_UPLOAD_ID={ORDER_HD_UPLOAD_ID}"
    )

    emit(
        f"ORDER_LI_UPLOAD_ID={ORDER_LI_UPLOAD_ID}"
    )

    emit(
        "HARD_FAILURES="
        +
        json.dumps(
            hard_failures,
            ensure_ascii=False,
            separators=(
                ",",
                ":",
            ),
        )
    )

    emit(
        "PRODUCTION_GATES="
        +
        json.dumps(
            gates,
            ensure_ascii=False,
            separators=(
                ",",
                ":",
            ),
        )
    )

    emit(
        f"RECOMMENDATION={recommendation}"
    )

    emit()

    emit(
        "TEST MATRIX:"
    )

    for test in TESTS:
        emit(
            f"{test['test_id']} | "
            f"{test['result']} | "
            f"BLOCKER={test['blocker']} | "
            f"{test['purpose']} | "
            f"{test['finding']}"
        )

    if (
        PHASE
        in {
            "duplicate-line",
            "rollback-line",
        }
    ):
        emit()
        emit(
            "POST_PHASE_MANUAL_ACTION=INSPECT_AND_CLEAR_ORDER_LI_PENDING_FILE_IN_AMEXTEST_BEFORE_ANY_OTHER_WRITE_TEST"
        )

    emit()
    emit(
        f"REPORT={RUN / 'CERTIFICATION_REPORT.md'}"
    )

    emit(
        f"FACTS={RUN / 'facts.json'}"
    )

    emit(
        f"TEST_MATRIX={RUN / 'test_matrix.json'}"
    )

    emit(
        f"RAW_RESPONSE_INDEX={RUN / 'raw_response_index.json'}"
    )

    emit(
        f"STATE_FILE={STATE_FILE}"
    )

    emit(
        "=" * 80
    )

    return (
        1
        if hard_failures
        else 0
    )


if __name__ == "__main__":
    raise SystemExit(
        main()
    )
