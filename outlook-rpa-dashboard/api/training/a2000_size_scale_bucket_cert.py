#!/usr/bin/env python3
from __future__ import annotations

import base64
import csv
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT = Path(
    os.getenv(
        "A2000_PROJECT_ROOT",
        "/workspaces/RPA/outlook-rpa-dashboard",
    )
).resolve()

API_DIR = PROJECT / "api"
SOURCE_CTRL_NO = int(
    os.getenv(
        "A2000_SOURCE_CTRL_NO",
        "3757166",
    )
)

RUN_ID = datetime.now(
    timezone.utc
).strftime(
    "%Y%m%d_%H%M%S"
)

RUN = (
    API_DIR
    / "training"
    / "a2000_size_scale_bucket_cert"
    / f"cert_{RUN_ID}"
)

RUN.mkdir(
    parents=True,
    exist_ok=True,
)

TOKEN = ""


# =============================================================================
# ENV
# =============================================================================


def load_env_file() -> str | None:
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

            key, value = line.split(
                "=",
                1,
            )

            key = key.strip()

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


ENV_SOURCE = load_env_file()

BASE = os.getenv(
    "A2000_BASE_URL",
    "",
).rstrip("/")

CLIENT_ID = os.getenv(
    "A2000_CLIENT_ID",
    "",
)

CLIENT_SECRET = os.getenv(
    "A2000_CLIENT_SECRET",
    "",
)

SUPABASE_URL = os.getenv(
    "SUPABASE_URL",
    "",
).rstrip("/")

SUPABASE_KEY = os.getenv(
    "SUPABASE_SERVICE_ROLE_KEY",
    "",
)


# =============================================================================
# HELPERS
# =============================================================================


def emit(
    key: str,
    value: Any,
) -> None:
    print(
        f"{key}={value}",
        flush=True,
    )


def save_text(
    name: str,
    text: str,
) -> Path:
    path = RUN / name

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    path.write_text(
        text,
        encoding="utf-8",
    )

    return path


def save_json(
    name: str,
    value: Any,
) -> Path:
    return save_text(
        name,
        json.dumps(
            value,
            indent=2,
            ensure_ascii=False,
            default=str,
        ),
    )


def clean(
    value: Any,
) -> str:
    if value is None:
        return ""

    return str(
        value
    ).strip()


def numeric(
    value: Any,
) -> float | None:
    if value in (
        None,
        "",
    ):
        return None

    try:
        return float(
            str(
                value
            ).replace(
                ",",
                "",
            )
        )

    except Exception:
        return None


def intish(
    value: Any,
) -> int:
    number = numeric(
        value
    )

    if number is None:
        return 0

    return int(
        round(
            number
        )
    )


def normalize_token(
    value: Any,
) -> str:
    text = clean(
        value
    ).upper()

    text = re.sub(
        r"[\s._\-/]+",
        "",
        text,
    )

    return text


def vector_from_row(
    row: dict[str, Any],
    prefix: str,
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
        for value
        in vector
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
        for value
        in vector
    ]


def active_buckets(
    vector: list[int],
) -> list[int]:
    return [
        index
        for index, value
        in enumerate(
            vector,
            start=1,
        )
        if value > 0
    ]


def compact_vector(
    vector: list[int],
) -> str:
    parts = [
        f"SZ{index}:{value}"
        for index, value
        in enumerate(
            vector,
            start=1,
        )
        if value > 0
    ]

    return (
        ",".join(
            parts
        )
        if parts
        else "EMPTY"
    )


def parse_json(
    raw: str,
) -> Any | None:
    try:
        return json.loads(
            raw
        )

    except Exception:
        return None


# =============================================================================
# HTTP
# =============================================================================


def request(
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
]:
    url = f"{BASE}{path}"

    headers = {
        "Accept":
        "application/json",
    }

    data: bytes | None = None

    if basic:
        credentials = (
            base64
            .b64encode(
                (
                    f"{CLIENT_ID}:"
                    f"{CLIENT_SECRET}"
                ).encode()
            )
            .decode()
        )

        headers[
            "Authorization"
        ] = (
            f"Basic {credentials}"
        )

        headers[
            "Content-Type"
        ] = (
            "application/"
            "x-www-form-urlencoded"
        )

        data = (
            urllib.parse
            .urlencode(
                payload or {}
            )
            .encode()
        )

    else:
        headers[
            "Authorization"
        ] = (
            f"Bearer {TOKEN}"
        )

        if payload is not None:
            headers[
                "Content-Type"
            ] = (
                "application/json"
            )

            data = (
                json.dumps(
                    payload
                )
                .encode()
            )

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

    try:
        with urllib.request.urlopen(
            req,
            timeout=120,
        ) as response:
            status = response.status

            raw = (
                response
                .read()
                .decode(
                    "utf-8",
                    errors="replace",
                )
            )

    except urllib.error.HTTPError as exc:
        status = exc.code

        raw = (
            exc
            .read()
            .decode(
                "utf-8",
                errors="replace",
            )
        )

    save_text(
        f"responses/{label}.raw.txt",
        raw,
    )

    body = parse_json(
        raw
    )

    if body is not None:
        save_json(
            f"responses/{label}.parsed.json",
            body,
        )

    return (
        status,
        raw,
        body,
    )


def oauth() -> None:
    global TOKEN

    status, _, body = request(
        "POST",
        "/api/oauth/token",
        {
            "grant_type":
            "client_credentials",
        },
        basic=True,
        label="AUTH",
    )

    if (
        status != 200
        or not isinstance(
            body,
            dict,
        )
        or not body.get(
            "access_token"
        )
    ):
        raise RuntimeError(
            "OAuth failed"
        )

    TOKEN = str(
        body[
            "access_token"
        ]
    )

    emit(
        "OAUTH_HTTP",
        status,
    )

    emit(
        "OAUTH_RESULT",
        "PASS",
    )

    emit(
        "TOKEN_TYPE",
        body.get(
            "token_type"
        ),
    )

    emit(
        "TOKEN_EXPIRES_IN",
        body.get(
            "expires_in"
        ),
    )


def viewer(
    name: str,
    columns: list[str],
    filter_sql: str,
    sort: str,
    *,
    label: str,
) -> tuple[
    int,
    list[dict[str, Any]],
]:
    status, _, body = request(
        "POST",
        (
            "/api/viewers/view/"
            f"{name}"
        ),
        {
            "COLUMNS":
            ", ".join(
                columns
            ),

            "FILTER":
            filter_sql,

            "SORT":
            sort,
        },
        label=label,
    )

    rows = (
        body.get(
            name,
            [],
        )
        if isinstance(
            body,
            dict,
        )
        else []
    )

    return (
        status,
        (
            rows
            if isinstance(
                rows,
                list,
            )
            else []
        ),
    )


# =============================================================================
# LOCAL MASTER CACHE
# =============================================================================


def read_csv(
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
            csv.DictReader(
                handle
            )
        )


# =============================================================================
# SUPABASE READ-ONLY
# =============================================================================


def supabase_get(
    path: str,
) -> tuple[
    int,
    Any | None,
]:
    if (
        not SUPABASE_URL
        or not SUPABASE_KEY
    ):
        return (
            0,
            None,
        )

    req = urllib.request.Request(
        (
            f"{SUPABASE_URL}"
            f"/rest/v1/{path}"
        ),
        headers={
            "Accept":
            "application/json",

            "apikey":
            SUPABASE_KEY,

            "Authorization":
            f"Bearer {SUPABASE_KEY}",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(
            req,
            timeout=120,
        ) as response:
            status = response.status

            raw = (
                response
                .read()
                .decode(
                    "utf-8",
                    errors="replace",
                )
            )

    except urllib.error.HTTPError as exc:
        status = exc.code

        raw = (
            exc
            .read()
            .decode(
                "utf-8",
                errors="replace",
            )
        )

    save_text(
        "responses/SUPABASE_CITI.raw.txt",
        raw,
    )

    body = parse_json(
        raw
    )

    if body is not None:
        save_json(
            "responses/SUPABASE_CITI.parsed.json",
            body,
        )

    return (
        status,
        body,
    )


# =============================================================================
# MAIN
# =============================================================================


def main() -> int:
    print(
        "=" * 80
    )

    print(
        "A2000 SIZE / SCALE / BUCKET CERTIFICATION"
    )

    print(
        "=" * 80
    )

    emit(
        "RUN_ID",
        RUN_ID,
    )

    emit(
        "RUN_DIR",
        RUN,
    )

    emit(
        "ENV_SOURCE",
        ENV_SOURCE,
    )

    emit(
        "BASE_URL",
        BASE,
    )

    emit(
        "CLIENT_ID_SET",
        bool(
            CLIENT_ID
        ),
    )

    emit(
        "CLIENT_SECRET_SET",
        bool(
            CLIENT_SECRET
        ),
    )

    emit(
        "SUPABASE_READ_ENABLED",
        bool(
            SUPABASE_URL
            and
            SUPABASE_KEY
        ),
    )

    if (
        not BASE
        or not CLIENT_ID
        or not CLIENT_SECRET
    ):
        emit(
            "ENV_RESULT",
            "FAIL",
        )

        return 2

    oauth()

    header_columns = [
        "CTRL_NO",
        "CUSTOMER",
        "STORE",
        "ORDER_NO",
        "DIV",
        "TERMS",
        "DEF_WH",
        "SHIP_VIA",
        "STATUS",
    ]

    line_columns = [
        "CTRL_NO",
        "STYLE",
        "CLR",
        "LINE_NO",
        "WH",
        "CUSTOMER",
        "STORE",
        "ORDER_NO",
        "DIV",
        "PRICE",
        "SCALE",
        "SCALE_ABBR",
        "RATIO",
        "ORDER_QTY",
        "OPEN_QTY",

        *[
            f"OPEN_SZ{i}"
            for i
            in range(
                1,
                19,
            )
        ],
    ]

    header_http, header_rows = viewer(
        "VR_ORDER_HD",
        header_columns,
        (
            f"CTRL_NO = "
            f"{SOURCE_CTRL_NO}"
        ),
        "CTRL_NO",
        label="SOURCE_HEADER",
    )

    emit(
        "SOURCE_HEADER_HTTP",
        header_http,
    )

    emit(
        "SOURCE_HEADER_COUNT",
        len(
            header_rows
        ),
    )

    if len(
        header_rows
    ) != 1:
        return 3

    source_header = header_rows[0]

    lines_http, source_lines = viewer(
        "VR_ORDER_LI",
        line_columns,
        (
            f"CTRL_NO = "
            f"{SOURCE_CTRL_NO}"
        ),
        "LINE_NO",
        label="SOURCE_LINES",
    )

    emit(
        "SOURCE_LINES_HTTP",
        lines_http,
    )

    emit(
        "SOURCE_LINES_COUNT",
        len(
            source_lines
        ),
    )

    if not source_lines:
        return 4

    sku_z_columns = [
        "STYLE",
        "CLR",
        "STYLE_DESCR",
        "CLR_DESC",
        "SKU",
        "SKU_DESCR",
        "SCALE",
        "SCALE_ABBR",
        "SIZE_NUM",
        "SIZE_NAME",
        "SCALE_QTY",
        "SCALE_PACK_QTY",
        "PACK_QTY",
        "DIV",
        "MASTER_STYLE",
        "STYLE_ALIAS",
        "SKU_ACTIVE",
    ]

    upc_columns = [
        "UPC_NO",
        "STYLE",
        "STYLE_DESC",
        "CLR",
        "CLR_DESC",
        "SIZE_NUM",
        "SIZE_NAME",
        "NRF_SIZE",
        "SCALE",
        "SCALE_ABBR",
        "DIV",
        "PACK_QTY",
        "SCALE_PACK_QTY",
        "SKU",
        "SKU_DESCR",
    ]

    sku_columns = [
        "STYLE",
        "CLR",
        "STYLE_DESCR",
        "CLR_DESC",
        "SKU",
        "SKU_DESCR",
        "SCALE",
        "SCALE_ABBR",
        "SCALE_PACK_QTY",
        "PACK_QTY",
        "DIV",
        "MASTER_STYLE",
        "STYLE_ALIAS",
        "SKU_ACTIVE",
    ]

    local_upc_rows = read_csv(
        (
            API_DIR
            / "masters"
            / "cache"
            / "upc.csv"
        )
    )

    local_sku_rows = read_csv(
        (
            API_DIR
            / "masters"
            / "cache"
            / "sku.csv"
        )
    )

    results = []

    direct_confirmed_count = 0
    ordinal_confirmed_count = 0

    live_scale_maps: dict[
        tuple[str, str],
        list[dict[str, Any]],
    ] = {}

    for source_line in source_lines:
        style = clean(
            source_line.get(
                "STYLE"
            )
        )

        color = clean(
            source_line.get(
                "CLR"
            )
        )

        source_vector = vector_from_row(
            source_line,
            "OPEN_SZ",
        )

        source_ratio = normalize_ratio(
            source_vector
        )

        source_active = active_buckets(
            source_vector
        )

        sku_z_http, sku_z_rows = viewer(
            "VR_SKU_Z",
            sku_z_columns,
            (
                f"STYLE = "
                f"'{style}' "
                f"AND CLR = "
                f"'{color}'"
            ),
            "SIZE_NUM",
            label=(
                f"SKU_Z_{style}_{color}"
            ),
        )

        upc_http, upc_rows = viewer(
            "VR_UPC_STYLE",
            upc_columns,
            (
                f"STYLE = "
                f"'{style}' "
                f"AND CLR = "
                f"'{color}'"
            ),
            "SIZE_NUM",
            label=(
                f"UPC_{style}_{color}"
            ),
        )

        sku_http, sku_rows = viewer(
            "VR_SKU",
            sku_columns,
            (
                f"STYLE = "
                f"'{style}' "
                f"AND CLR = "
                f"'{color}'"
            ),
            "STYLE",
            label=(
                f"SKU_{style}_{color}"
            ),
        )

        live_scale_maps[
            (
                style.upper(),
                color.upper(),
            )
        ] = sku_z_rows

        direct_vector = [
            0
            for _ in range(
                18
            )
        ]

        valid_direct_rows = 0

        for row in sku_z_rows:
            size_num = intish(
                row.get(
                    "SIZE_NUM"
                )
            )

            scale_qty = intish(
                row.get(
                    "SCALE_QTY"
                )
            )

            if (
                1 <= size_num <= 18
            ):
                direct_vector[
                    size_num - 1
                ] = scale_qty

                valid_direct_rows += 1

        ordinal_vector = [
            0
            for _ in range(
                18
            )
        ]

        for index, row in enumerate(
            sku_z_rows,
            start=1,
        ):
            if index > 18:
                break

            ordinal_vector[
                index - 1
            ] = intish(
                row.get(
                    "SCALE_QTY"
                )
            )

        normalized_direct = normalize_ratio(
            direct_vector
        )

        normalized_ordinal = normalize_ratio(
            ordinal_vector
        )

        direct_match = (
            normalized_direct
            ==
            source_ratio
        )

        ordinal_match = (
            normalized_ordinal
            ==
            source_ratio
        )

        if direct_match:
            direct_confirmed_count += 1

        if ordinal_match:
            ordinal_confirmed_count += 1

        scale_pack_values = sorted(
            {
                intish(
                    row.get(
                        "SCALE_PACK_QTY"
                    )
                )
                for row in sku_z_rows
                if intish(
                    row.get(
                        "SCALE_PACK_QTY"
                    )
                )
                > 0
            }
        )

        pack_values = sorted(
            {
                intish(
                    row.get(
                        "PACK_QTY"
                    )
                )
                for row in sku_z_rows
                if intish(
                    row.get(
                        "PACK_QTY"
                    )
                )
                > 0
            }
        )

        direct_pack_total = sum(
            direct_vector
        )

        local_upc_matches = [
            row
            for row in local_upc_rows
            if normalize_token(
                row.get(
                    "style"
                )
            )
            ==
            normalize_token(
                style
            )
            and normalize_token(
                row.get(
                    "clr"
                )
            )
            ==
            normalize_token(
                color
            )
        ]

        local_sku_matches = [
            row
            for row in local_sku_rows
            if normalize_token(
                row.get(
                    "style"
                )
            )
            ==
            normalize_token(
                style
            )
            and normalize_token(
                row.get(
                    "clr"
                )
            )
            ==
            normalize_token(
                color
            )
        ]

        size_name_to_bucket = {}

        for row in sku_z_rows:
            size_name = clean(
                row.get(
                    "SIZE_NAME"
                )
            )

            size_num = intish(
                row.get(
                    "SIZE_NUM"
                )
            )

            if (
                size_name
                and
                1 <= size_num <= 18
            ):
                size_name_to_bucket[
                    size_name
                ] = size_num

        result = {
            "source": {
                "ctrl_no":
                source_line.get(
                    "CTRL_NO"
                ),

                "line_no":
                source_line.get(
                    "LINE_NO"
                ),

                "style":
                style,

                "color":
                color,

                "division":
                source_line.get(
                    "DIV"
                ),

                "scale":
                source_line.get(
                    "SCALE"
                ),

                "scale_abbr":
                source_line.get(
                    "SCALE_ABBR"
                ),

                "order_qty":
                source_line.get(
                    "ORDER_QTY"
                ),

                "open_qty":
                source_line.get(
                    "OPEN_QTY"
                ),

                "source_vector":
                source_vector,

                "source_vector_compact":
                compact_vector(
                    source_vector
                ),

                "source_ratio":
                source_ratio,

                "source_ratio_compact":
                compact_vector(
                    source_ratio
                ),

                "source_active_buckets":
                source_active,
            },

            "vr_sku_z": {
                "http_status":
                sku_z_http,

                "row_count":
                len(
                    sku_z_rows
                ),

                "rows":
                sku_z_rows,

                "valid_direct_rows":
                valid_direct_rows,

                "direct_scale_qty_vector":
                direct_vector,

                "direct_scale_qty_compact":
                compact_vector(
                    direct_vector
                ),

                "normalized_direct":
                normalized_direct,

                "normalized_direct_compact":
                compact_vector(
                    normalized_direct
                ),

                "direct_match":
                direct_match,

                "ordinal_scale_qty_vector":
                ordinal_vector,

                "ordinal_scale_qty_compact":
                compact_vector(
                    ordinal_vector
                ),

                "normalized_ordinal":
                normalized_ordinal,

                "normalized_ordinal_compact":
                compact_vector(
                    normalized_ordinal
                ),

                "ordinal_match":
                ordinal_match,

                "scale_pack_qty_values":
                scale_pack_values,

                "pack_qty_values":
                pack_values,

                "direct_pack_total":
                direct_pack_total,

                "size_name_to_bucket":
                size_name_to_bucket,
            },

            "vr_upc_style": {
                "http_status":
                upc_http,

                "row_count":
                len(
                    upc_rows
                ),

                "rows":
                upc_rows,
            },

            "vr_sku": {
                "http_status":
                sku_http,

                "row_count":
                len(
                    sku_rows
                ),

                "rows":
                sku_rows,
            },

            "local_cache": {
                "upc_count":
                len(
                    local_upc_matches
                ),

                "upc_rows":
                local_upc_matches,

                "sku_count":
                len(
                    local_sku_matches
                ),

                "sku_rows":
                local_sku_matches,
            },
        }

        results.append(
            result
        )

        print()
        print(
            "=" * 80
        )

        print(
            "SOURCE LINE"
        )

        print(
            "=" * 80
        )

        emit(
            "SOURCE_LINE_NO",
            source_line.get(
                "LINE_NO"
            ),
        )

        emit(
            "STYLE",
            style,
        )

        emit(
            "COLOR",
            color,
        )

        emit(
            "SOURCE_SCALE",
            source_line.get(
                "SCALE"
            ),
        )

        emit(
            "SOURCE_SCALE_ABBR",
            source_line.get(
                "SCALE_ABBR"
            ),
        )

        emit(
            "SOURCE_VECTOR",
            compact_vector(
                source_vector
            ),
        )

        emit(
            "SOURCE_RATIO",
            compact_vector(
                source_ratio
            ),
        )

        emit(
            "SOURCE_ACTIVE_BUCKETS",
            source_active,
        )

        emit(
            "VR_SKU_Z_HTTP",
            sku_z_http,
        )

        emit(
            "VR_SKU_Z_COUNT",
            len(
                sku_z_rows
            ),
        )

        print(
            "VR_SKU_Z_ROWS="
        )

        print(
            json.dumps(
                sku_z_rows,
                indent=2,
                ensure_ascii=False,
            )
        )

        emit(
            "DIRECT_SCALE_QTY_VECTOR",
            compact_vector(
                direct_vector
            ),
        )

        emit(
            "NORMALIZED_DIRECT",
            compact_vector(
                normalized_direct
            ),
        )

        emit(
            "DIRECT_MATCH_SOURCE_RATIO",
            direct_match,
        )

        emit(
            "ORDINAL_SCALE_QTY_VECTOR",
            compact_vector(
                ordinal_vector
            ),
        )

        emit(
            "NORMALIZED_ORDINAL",
            compact_vector(
                normalized_ordinal
            ),
        )

        emit(
            "ORDINAL_MATCH_SOURCE_RATIO",
            ordinal_match,
        )

        emit(
            "SCALE_PACK_QTY_VALUES",
            scale_pack_values,
        )

        emit(
            "PACK_QTY_VALUES",
            pack_values,
        )

        emit(
            "DIRECT_PACK_TOTAL",
            direct_pack_total,
        )

        emit(
            "SIZE_NAME_TO_BUCKET",
            size_name_to_bucket,
        )

        emit(
            "VR_UPC_STYLE_COUNT",
            len(
                upc_rows
            ),
        )

        print(
            "VR_UPC_STYLE_ROWS="
        )

        print(
            json.dumps(
                upc_rows,
                indent=2,
                ensure_ascii=False,
            )
        )

    save_json(
        "mapping_results.json",
        results,
    )

    source_count = len(
        results
    )

    if (
        source_count > 0
        and direct_confirmed_count
        ==
        source_count
    ):
        mapping_verdict = (
            "CONFIRMED_SIZE_NUM_IS_QTY_SIZE_BUCKET"
        )

    elif (
        source_count > 0
        and ordinal_confirmed_count
        ==
        source_count
    ):
        mapping_verdict = (
            "CONFIRMED_SCALE_ROW_ORDINAL_IS_QTY_SIZE_BUCKET"
        )

    else:
        mapping_verdict = (
            "UNRESOLVED_NEED_SCALE_MASTER_RULE"
        )

    # =====================================================================
    # OPTIONAL SUPABASE: latest CITI lines and live size-name mapping
    # =====================================================================

    supabase_summary = {
        "enabled":
        bool(
            SUPABASE_URL
            and
            SUPABASE_KEY
        ),

        "http_status":
        0,

        "order_count":
        0,

        "line_count":
        0,

        "size_line_count":
        0,

        "mapped_size_line_count":
        0,

        "mappings":
        [],
    }

    if supabase_summary[
        "enabled"
    ]:
        select = (
            "id,document_id,parser_name,"
            "customer_code,store_code,"
            "order_no,division_code,created_at,"
            "purchase_order_lines("
            "id,line_no,style_code,color_code,"
            "size_raw,size_code,qty_total,"
            "qty_sz1,qty_sz2,qty_sz3,qty_sz4,"
            "qty_sz5,qty_sz6,qty_sz7,qty_sz8,"
            "qty_sz9,qty_sz10,qty_sz11,qty_sz12,"
            "qty_sz13,qty_sz14,qty_sz15,qty_sz16,"
            "qty_sz17,qty_sz18"
            ")"
        )

        query = urllib.parse.urlencode(
            {
                "select":
                select,

                "customer_code":
                "eq.CITI",

                "order":
                "created_at.desc",

                "limit":
                "5",
            }
        )

        supabase_http, orders = supabase_get(
            f"purchase_orders?{query}"
        )

        supabase_summary[
            "http_status"
        ] = supabase_http

        if isinstance(
            orders,
            list,
        ):
            supabase_summary[
                "order_count"
            ] = len(
                orders
            )

            for order in orders:
                lines = (
                    order.get(
                        "purchase_order_lines",
                        [],
                    )
                    or []
                )

                for line in lines:
                    supabase_summary[
                        "line_count"
                    ] += 1

                    size_raw = clean(
                        line.get(
                            "size_raw"
                        )
                        or line.get(
                            "size_code"
                        )
                    )

                    style = clean(
                        line.get(
                            "style_code"
                        )
                    )

                    color = clean(
                        line.get(
                            "color_code"
                        )
                    )

                    if (
                        not size_raw
                        or not style
                        or not color
                    ):
                        continue

                    supabase_summary[
                        "size_line_count"
                    ] += 1

                    scale_rows = live_scale_maps.get(
                        (
                            style.upper(),
                            color.upper(),
                        ),
                        [],
                    )

                    exact = [
                        row
                        for row in scale_rows
                        if normalize_token(
                            row.get(
                                "SIZE_NAME"
                            )
                        )
                        ==
                        normalize_token(
                            size_raw
                        )
                    ]

                    mapping = {
                        "purchase_order_id":
                        order.get(
                            "id"
                        ),

                        "order_no":
                        order.get(
                            "order_no"
                        ),

                        "line_no":
                        line.get(
                            "line_no"
                        ),

                        "style":
                        style,

                        "color":
                        color,

                        "size_raw":
                        size_raw,

                        "qty_total":
                        line.get(
                            "qty_total"
                        ),

                        "live_scale_row_count":
                        len(
                            scale_rows
                        ),

                        "exact_size_name_match_count":
                        len(
                            exact
                        ),

                        "matched_rows":
                        exact,
                    }

                    if len(
                        exact
                    ) == 1:
                        supabase_summary[
                            "mapped_size_line_count"
                        ] += 1

                    supabase_summary[
                        "mappings"
                    ].append(
                        mapping
                    )

    save_json(
        "supabase_size_mapping.json",
        supabase_summary,
    )

    emit(
        "MAPPING_VERDICT",
        mapping_verdict,
    )

    emit(
        "SOURCE_COMBINATION_COUNT",
        source_count,
    )

    emit(
        "DIRECT_CONFIRMED_COUNT",
        direct_confirmed_count,
    )

    emit(
        "ORDINAL_CONFIRMED_COUNT",
        ordinal_confirmed_count,
    )

    emit(
        "SUPABASE_HTTP",
        supabase_summary[
            "http_status"
        ],
    )

    emit(
        "SUPABASE_ORDER_COUNT",
        supabase_summary[
            "order_count"
        ],
    )

    emit(
        "SUPABASE_LINE_COUNT",
        supabase_summary[
            "line_count"
        ],
    )

    emit(
        "SUPABASE_SIZE_LINE_COUNT",
        supabase_summary[
            "size_line_count"
        ],
    )

    emit(
        "SUPABASE_MAPPED_SIZE_LINE_COUNT",
        supabase_summary[
            "mapped_size_line_count"
        ],
    )

    print()
    print(
        "=" * 80
    )

    print(
        "COPY THIS RESULT TO CHATGPT"
    )

    print(
        "=" * 80
    )

    emit(
        "RUN_ID",
        RUN_ID,
    )

    emit(
        "RUN_DIR",
        RUN,
    )

    emit(
        "SOURCE_CTRL_NO",
        SOURCE_CTRL_NO,
    )

    emit(
        "SOURCE_COMBINATION_COUNT",
        source_count,
    )

    emit(
        "DIRECT_CONFIRMED_COUNT",
        direct_confirmed_count,
    )

    emit(
        "ORDINAL_CONFIRMED_COUNT",
        ordinal_confirmed_count,
    )

    emit(
        "MAPPING_VERDICT",
        mapping_verdict,
    )

    for result in results:
        source = result[
            "source"
        ]

        sku_z = result[
            "vr_sku_z"
        ]

        emit(
            "MAP",
            (
                f"STYLE:{source['style']}"
                f"|COLOR:{source['color']}"
                f"|SCALE:{source['scale']}"
                f"|SCALE_ABBR:{source['scale_abbr']}"
                f"|SOURCE_RATIO:{source['source_ratio_compact']}"
                f"|ACTIVE_BUCKETS:{source['source_active_buckets']}"
                f"|SKU_Z_ROWS:{sku_z['row_count']}"
                f"|DIRECT:{sku_z['normalized_direct_compact']}"
                f"|DIRECT_MATCH:{sku_z['direct_match']}"
                f"|ORDINAL:{sku_z['normalized_ordinal_compact']}"
                f"|ORDINAL_MATCH:{sku_z['ordinal_match']}"
                f"|SCALE_PACK_QTY:{sku_z['scale_pack_qty_values']}"
                f"|SIZE_NAME_TO_BUCKET:{sku_z['size_name_to_bucket']}"
            ),
        )

    emit(
        "SUPABASE_READ_ENABLED",
        supabase_summary[
            "enabled"
        ],
    )

    emit(
        "SUPABASE_HTTP",
        supabase_summary[
            "http_status"
        ],
    )

    emit(
        "SUPABASE_ORDER_COUNT",
        supabase_summary[
            "order_count"
        ],
    )

    emit(
        "SUPABASE_LINE_COUNT",
        supabase_summary[
            "line_count"
        ],
    )

    emit(
        "SUPABASE_SIZE_LINE_COUNT",
        supabase_summary[
            "size_line_count"
        ],
    )

    emit(
        "SUPABASE_MAPPED_SIZE_LINE_COUNT",
        supabase_summary[
            "mapped_size_line_count"
        ],
    )

    for mapping in (
        supabase_summary[
            "mappings"
        ][:30]
    ):
        emit(
            "PDF_SIZE_MAP",
            (
                f"ORDER:{mapping['order_no']}"
                f"|LINE:{mapping['line_no']}"
                f"|STYLE:{mapping['style']}"
                f"|COLOR:{mapping['color']}"
                f"|SIZE_RAW:{mapping['size_raw']}"
                f"|QTY:{mapping['qty_total']}"
                f"|LIVE_SCALE_ROWS:{mapping['live_scale_row_count']}"
                f"|MATCH_COUNT:{mapping['exact_size_name_match_count']}"
                f"|MATCHED:{mapping['matched_rows']}"
            ),
        )

    emit(
        "RESULT_FILES",
        RUN,
    )

    print(
        "=" * 80
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(
        main()
    )
