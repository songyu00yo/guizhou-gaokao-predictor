"""Build runtime university profiles from versioned public sources.

The function in this module is intentionally separate from the online API's
CollegesChat cache. It writes a caller-owned, reproducible source cache under
``raw_dir`` and can rebuild profiles from that cache without network access.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import re
import ssl
import subprocess
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from colleges_chat import (
    COLLEGES_CHAT_GENERATED_AT,
    COLLEGES_CHAT_LICENSE,
    COLLEGES_CHAT_LICENSE_URL,
    COLLEGES_CHAT_NAV_URL,
    COLLEGES_CHAT_RAW_BASE_URL,
    COLLEGES_CHAT_SOURCE_VERSION,
    normalize_colleges_chat_name,
    parse_colleges_chat_markdown,
    parse_colleges_chat_nav,
)


MOE_PAGE_URL = "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/A03/202606/t20260618_1441074.html"
MOE_XLS_URL = "https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/A03/202606/W020260618416094865984.xls"
MOE_YEAR = 2026
MOE_LICENSE = "教育部公开名单页面未声明明确开放许可"

# A fixed commit makes offline cache contents and source attribution repeatable.
DAO_REPO = "DaoSword/China-Education-Data"
DAO_REVISION = "2a810d061b4670964e8ff845accc32942531f0aa"
DAO_BASE_URL = f"https://raw.githubusercontent.com/{DAO_REPO}/{DAO_REVISION}/"
DAO_WIDE_PATH = "数据收集-高等教育/04-数据宽表/高等教育数据宽表v20230118.csv"
DAO_LIST_PATH = "数据收集-高等教育/01-数据源/01-学校名单/教育部-全国普通高等学校名单.csv"
DAO_WIDE_URL = DAO_BASE_URL + urllib.parse.quote(DAO_WIDE_PATH, safe="/")
DAO_LIST_URL = DAO_BASE_URL + urllib.parse.quote(DAO_LIST_PATH, safe="/")
DAO_LICENSE_URL = f"https://github.com/{DAO_REPO}/blob/{DAO_REVISION}/LICENSE"
DAO_LICENSE = "CC BY 4.0"
DAO_YEAR = 2023

EOL_SEARCH_URL = "https://api.eol.cn/web/api/"
EOL_SCHOOL_INFO_BASE_URL = "https://static-data.gaokao.cn/www/2.0/school"
EOL_LICENSE = "来源未标注明确开放许可，不应默认可任意再分发"

_USER_AGENT = "GaokaoVolunteerPublicProfiles/1.0"
_MAX_DOWNLOAD_BYTES = 12_000_000
_DOWNLOAD_ATTEMPTS = 3
MOE_EXPECTED_TITLE = "全国普通高等学校名单"
MOE_EXPECTED_DATE = "截至2026年6月17日"
_CONTACT_PATTERNS = (
    re.compile(r"(?i)(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])"),
    re.compile(r"(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)"),
    re.compile(r"(?<!\d)0\d{2,3}[\s-]?\d{7,8}(?!\d)"),
    re.compile(r"(?i)\b(?:https?://|www\.)\S+"),
    re.compile(r"(?i)(?:qq号|qq|q号|企鹅号|扣扣)\s*[:：]?\s*\d{5,12}"),
    re.compile(r"(?i)(?:微信号|微信|wechat|vx|v信)\s*[:：]?\s*[a-z0-9_-]{3,30}"),
    re.compile(r"(?:联系方式|联系电话|手机号|联系我|加我微信|加微信|私聊|私信)\s*[:：]?[^\n]*"),
)
_MAX_REVIEW_ANSWERS_PER_QUESTION = 3
_MAX_REVIEW_BODY_CHARS = 2000
_REVIEW_EXCERPT_SUFFIX = "（节选，完整回答见来源）"


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _read_cached(path: Path, url: str, *, offline: bool, year: int | None, license_name: str) -> tuple[bytes | None, dict[str, Any]]:
    """Reuse cache only when its provenance and content digest both match."""
    meta_path = path.with_suffix(path.suffix + ".meta.json")
    invalid_cache = ""
    if path.is_file() or meta_path.exists():
        if not path.is_file():
            invalid_cache = "缓存元数据存在但原始文件缺失"
        elif not meta_path.is_file():
            invalid_cache = "原始文件缺少元数据，不能确认来源和完整性"
        else:
            try:
                cached_metadata = json.loads(meta_path.read_text(encoding="utf-8"))
                cached_data = path.read_bytes()
                if not isinstance(cached_metadata, dict):
                    raise ValueError("元数据不是 JSON 对象")
                expected_hash = str(cached_metadata.get("sha256") or "").lower()
                expected_bytes = cached_metadata.get("bytes")
                actual_hash = hashlib.sha256(cached_data).hexdigest()
                if cached_metadata.get("source_url") != url:
                    invalid_cache = "缓存元数据来源 URL 不匹配"
                elif not expected_hash or expected_hash != actual_hash:
                    invalid_cache = "缓存 SHA-256 校验失败"
                elif expected_bytes is not None and (
                    not isinstance(expected_bytes, int)
                    or isinstance(expected_bytes, bool)
                    or expected_bytes != len(cached_data)
                ):
                    invalid_cache = "缓存字节数校验失败"
                else:
                    metadata = {
                        **cached_metadata,
                        "year": year,
                        "license": license_name,
                        "status": "cached",
                        "bytes": len(cached_data),
                    }
                    # Older cache sidecars have a trusted URL and digest but no
                    # byte count; add the count after validating that digest.
                    if expected_bytes is None:
                        _write_json(meta_path, metadata)
                    return cached_data, metadata
            except (OSError, ValueError, TypeError) as exc:
                invalid_cache = f"缓存元数据或文件无法读取：{exc}"
    elif offline:
        return None, {"source_url": url, "status": "missing_cache", "error": f"离线缓存不存在：{path.name}"}

    if offline:
        return None, {
            "source_url": url,
            "status": "invalid_cache",
            "error": f"离线缓存无效：{invalid_cache or path.name}",
        }

    last_error = invalid_cache
    for attempt in range(_DOWNLOAD_ATTEMPTS):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "*/*"})
            try:
                with urllib.request.urlopen(request, timeout=25) as response:
                    data = response.read(_MAX_DOWNLOAD_BYTES + 1)
            except urllib.error.URLError as exc:
                # macOS curl can validate chains through platform trust when the
                # standalone Python/OpenSSL trust store cannot. TLS stays enabled.
                if sys.platform != "darwin" or not isinstance(exc.reason, ssl.SSLCertVerificationError):
                    raise
                data = subprocess.run([
                    "/usr/bin/curl", "-q", "--fail", "--silent", "--show-error", "--location",
                    "--proto", "=https", "--proto-redir", "=https", "--max-time", "25",
                    "--max-filesize", str(_MAX_DOWNLOAD_BYTES), "--user-agent", _USER_AGENT, url,
                ], check=True, capture_output=True, timeout=30).stdout
            if len(data) > _MAX_DOWNLOAD_BYTES:
                raise ValueError(f"下载文件超过 {_MAX_DOWNLOAD_BYTES} 字节限制")
            metadata = {
                "source_url": url,
                "year": year,
                "license": license_name,
                "status": "downloaded",
                "fetched_at": int(time.time()),
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
            }
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
            _write_json(meta_path, metadata)
            return data, metadata
        except Exception as exc:  # A source outage must not prevent other schools from building.
            last_error = str(exc)
            if attempt + 1 < _DOWNLOAD_ATTEMPTS:
                time.sleep(0.2 * (attempt + 1))
    prefix = f"缓存无效（{invalid_cache}）；" if invalid_cache else ""
    return None, {"source_url": url, "status": "unavailable", "error": f"{prefix}下载失败（尝试{_DOWNLOAD_ATTEMPTS}次）：{last_error}"}


def _csv_rows(data: bytes) -> list[dict[str, str]]:
    text = data.decode("utf-8-sig", errors="replace")
    return [dict(row) for row in csv.DictReader(io.StringIO(text))]


def _parse_moe_rows(rows: list[list[str]]) -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    """Parse rows and require the expected official title and cutoff date."""
    header_index = next(
        (i for i, row in enumerate(rows) if "序号" in row and "学校名称" in row),
        None,
    )
    if header_index is None:
        raise ValueError("教育部附件中找不到学校名单表头")
    heading = unicodedata.normalize(
        "NFKC", " ".join(cell.strip() for row in rows[:header_index] for cell in row if cell.strip())
    )
    compact_heading = re.sub(r"\s+", "", heading)
    if MOE_EXPECTED_TITLE not in compact_heading:
        raise ValueError("教育部附件标题不匹配全国普通高等学校名单")
    if not re.search(r"截至\s*2026\s*年\s*0?6\s*月\s*0?17\s*日", heading):
        raise ValueError("教育部附件日期不匹配截至2026年6月17日")
    headers = rows[header_index]
    result: dict[str, dict[str, str]] = {}
    for values in rows[header_index + 1 :]:
        row = {headers[i].strip(): (values[i].strip() if i < len(values) else "") for i in range(len(headers))}
        name = row.get("学校名称", "").strip()
        if not name or name.startswith("附件") or not row.get("学校标识码"):
            continue
        key = normalize_colleges_chat_name(name)
        if key:
            result[key] = {
                "school": name,
                "school_code": row.get("学校标识码", ""),
                "department": row.get("主管部门", ""),
                "location": row.get("所在地", ""),
                "tier": row.get("办学层次", ""),
            }
    if not result:
        raise ValueError("教育部附件中没有可识别的高校记录")
    return result, {"title": MOE_EXPECTED_TITLE, "date": MOE_EXPECTED_DATE, "roster_count": len(result)}


def _read_moe_xls(data: bytes) -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    """Parse the verified official .xls directly with xlrd; no derived CSV cache."""
    try:
        import xlrd  # type: ignore[import-not-found]
        book = xlrd.open_workbook(file_contents=data, on_demand=True)
        sheet = book.sheet_by_index(0)
        rows: list[list[str]] = []
        for row_index in range(sheet.nrows):
            values: list[str] = []
            for cell in sheet.row(row_index):
                value = cell.value
                if cell.ctype == xlrd.XL_CELL_EMPTY or value is None:
                    values.append("")
                elif isinstance(value, float) and value.is_integer():
                    values.append(str(int(value)))
                else:
                    values.append(str(value).strip())
            rows.append(values)
        roster, validation = _parse_moe_rows(rows)
        book.release_resources()
        return roster, validation
    except ImportError as exc:
        raise RuntimeError("解析教育部 .xls 需要安装 xlrd") from exc
    except Exception as exc:
        raise ValueError(f"教育部 XLS 解析失败：{exc}") from exc


def _eol_search_url(school: str) -> str:
    query = urllib.parse.urlencode(
        {"keyword": school, "page": 1, "size": 5, "uri": "apidata/api/gk/school/lists"}
    )
    return f"{EOL_SEARCH_URL}?{query}"


def _retrieved_at(metadata: dict[str, Any]) -> str:
    timestamp = metadata.get("fetched_at")
    try:
        return datetime.fromtimestamp(int(timestamp), tz=timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


def _fetch_eol_record(raw_dir: Path, school: str, *, offline: bool) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    key = normalize_colleges_chat_name(school)
    url = _eol_search_url(school)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]
    cache_path = raw_dir / "public_profiles" / "eol" / "search" / f"{digest}.json"
    raw, metadata = _read_cached(cache_path, url, offline=offline, year=None, license_name=EOL_LICENSE)
    state: dict[str, Any] = {
        "source_url": url,
        "license": EOL_LICENSE,
        "retrieved_at": _retrieved_at(metadata) if raw is not None else "",
        "cache_status": metadata.get("status", "unavailable"),
    }
    if raw is None:
        return None, {**state, "error": metadata.get("error", "中国教育在线查询失败")}
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        return None, {**state, "error": f"中国教育在线返回内容无法解析：{exc}"}
    if not isinstance(payload, dict) or str(payload.get("code")) != "0000":
        return None, {**state, "error": "中国教育在线接口未返回成功结果"}
    items = (payload.get("data") or {}).get("item") if isinstance(payload.get("data"), dict) else None
    if not isinstance(items, list):
        return None, {**state, "error": "中国教育在线响应缺少 data.item 院校列表"}
    exact = [
        item
        for item in items
        if isinstance(item, dict) and normalize_colleges_chat_name(str(item.get("name") or "")) == key
    ]
    if not exact:
        return None, {**state, "status": "not_found", "error": "data.item 中没有规范名精确匹配项"}
    if len(exact) != 1:
        return None, {**state, "status": "ambiguous", "error": f"data.item 有 {len(exact)} 条同名精确记录，未采用"}
    return {"item": exact[0], "url": url, "retrieved_at": state["retrieved_at"]}, {
        **state,
        "status": "exact_unique",
        "matched_name": str(exact[0].get("name") or ""),
        "school_id": str(exact[0].get("school_id") or ""),
    }


def _fetch_eol_school_info(
    raw_dir: Path,
    school: str,
    school_id: str,
    *,
    offline: bool,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    if not school_id.isdigit():
        return None, {"status": "no_school_id", "error": "精确 EOL 记录未提供数字 school_id"}
    url = f"{EOL_SCHOOL_INFO_BASE_URL}/{school_id}/info.json"
    cache_path = raw_dir / "public_profiles" / "eol" / "info" / f"{school_id}.json"
    raw, metadata = _read_cached(cache_path, url, offline=offline, year=None, license_name=EOL_LICENSE)
    state: dict[str, Any] = {
        "source_url": url,
        "license": EOL_LICENSE,
        "retrieved_at": _retrieved_at(metadata) if raw is not None else "",
        "cache_status": metadata.get("status", "unavailable"),
    }
    if raw is None:
        return None, {**state, "error": metadata.get("error", "院校详情接口查询失败")}
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
        record = payload.get("data") if isinstance(payload, dict) else None
    except (UnicodeDecodeError, ValueError) as exc:
        return None, {**state, "error": f"院校详情响应无法解析：{exc}"}
    if not isinstance(record, dict) or normalize_colleges_chat_name(str(record.get("name") or "")) != normalize_colleges_chat_name(school):
        return None, {**state, "status": "name_mismatch", "error": "info.json data.name 与院校规范名不匹配"}
    return {"record": record, "url": url, "retrieved_at": state["retrieved_at"]}, {
        **state,
        "status": "exact_name_match",
        "matched_name": str(record.get("name") or ""),
    }


def _exact_rows(rows: list[dict[str, str]], key: str) -> list[dict[str, str]]:
    return [row for row in rows if normalize_colleges_chat_name(row.get("学校名称", "")) == key]


def _unique_exact_row(rows: list[dict[str, str]], key: str) -> dict[str, str] | None:
    matches = _exact_rows(rows, key)
    if not matches:
        return None
    # Identical duplicate rows can occur in merged datasets; conflicting rows
    # remain ambiguous instead of silently choosing a campus or entity.
    unique = {json.dumps(row, ensure_ascii=False, sort_keys=True) for row in matches}
    return matches[0] if len(unique) == 1 else None


def _safe_url(value: str) -> str:
    value = (value or "").strip()
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return ""
    return value if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def _existing_profile_fields(
    school: str,
    moe: dict[str, dict[str, str]],
    historical_rows: list[dict[str, str]],
) -> tuple[dict[str, str], dict[str, str] | None]:
    key = normalize_colleges_chat_name(school)
    official_record = moe.get(key)
    historical_row = _unique_exact_row(historical_rows, key)
    fields = {
        "city": str((official_record or {}).get("location") or "").strip()
        or str((historical_row or {}).get("所在城市") or "").strip(),
        "ownership": str((historical_row or {}).get("学校性质") or "").strip(),
        "tier": str((official_record or {}).get("tier") or "").strip()
        or str((historical_row or {}).get("办学层次") or "").strip(),
        "category": str((historical_row or {}).get("学校类别") or "").strip(),
        "official_site": _safe_url(str((historical_row or {}).get("学校官网") or "")),
    }
    return fields, historical_row


def _sanitize_review(text: str) -> str:
    cleaned = text
    for pattern in _CONTACT_PATTERNS:
        cleaned = pattern.sub("[联系方式已省略]", cleaned)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"(?:\s*\[联系方式已省略\]\s*){2,}", " [联系方式已省略] ", cleaned)
    return cleaned.strip()


def _review_date_parts(date: str) -> tuple[int, int, int] | None:
    match = re.search(r"(?<!\d)(20\d{2})(?!\d)", date or "")
    if not match:
        return None
    trailing_numbers = re.findall(r"\d+", (date or "")[match.end() :])
    year = int(match.group(1))
    month = int(trailing_numbers[0]) if trailing_numbers else 0
    day = int(trailing_numbers[1]) if len(trailing_numbers) > 1 else 0
    if month and not 1 <= month <= 12:
        return None
    if day and not 1 <= day <= 31:
        return None
    return year, month, day


def _review_year(date: str) -> int | None:
    parts = _review_date_parts(date)
    return parts[0] if parts else None


def _cache_page(raw_dir: Path, path: str, *, offline: bool) -> tuple[str | None, dict[str, Any]]:
    # The nav parser only accepts universities/*.md; retain an explicit path
    # check before using remote-derived data as a cache path.
    normalized_path = Path(path)
    if normalized_path.is_absolute() or ".." in normalized_path.parts or not path.startswith("universities/"):
        return None, {"source_url": "", "status": "invalid_path", "error": "生活问卷索引路径不安全"}
    file_path = raw_dir / "public_profiles" / "colleges-chat" / path
    url = COLLEGES_CHAT_RAW_BASE_URL + path
    data, metadata = _read_cached(
        file_path,
        url,
        offline=offline,
        year=2026,
        license_name=COLLEGES_CHAT_LICENSE,
    )
    if data is None:
        return None, metadata
    return data.decode("utf-8-sig", errors="replace"), metadata


def _make_review_rows(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    sources = {source.get("id", ""): source for source in payload.get("sources", []) if source.get("id")}
    source_url = str(payload.get("source_url") or "")
    license_name = str(payload.get("license") or COLLEGES_CHAT_LICENSE)
    reviews: list[dict[str, Any]] = []
    total_answers = 0
    for question in payload.get("questions", []):
        title = _sanitize_review(str(question.get("question", "")))
        if not title:
            continue
        question_reviews: list[tuple[dict[str, Any], tuple[int, int, int] | None, str]] = []
        for answer in question.get("answers", []):
            body = _sanitize_review(str(answer.get("text", "")))
            if not body:
                continue
            total_answers += 1
            answer_id = str(answer.get("id") or "")
            source = sources.get(answer_id, {})
            date = str(source.get("date") or "")
            if len(body) > _MAX_REVIEW_BODY_CHARS:
                body = body[:_MAX_REVIEW_BODY_CHARS] + _REVIEW_EXCERPT_SUFFIX
            row = {
                "title": title,
                "summary": body,
                "source_type": "CollegesChat 学生问卷",
                "confidence": "中",
                "verify_hint": f"问卷回答 {answer_id or '未标注'}；日期 {date or '未提供'}；非官方体验信息",
                "source": answer_id,
                "date": date,
                "year": _review_year(date),
                "source_url": source_url,
                "license": license_name,
                "source_version": payload.get("source_version", COLLEGES_CHAT_SOURCE_VERSION),
            }
            question_reviews.append((row, _review_date_parts(date), answer_id))

        # Known dates sort newest first; unknown dates follow. IDs resolve date
        # ties deterministically while Python's stable sort preserves duplicate IDs.
        question_reviews.sort(
            key=lambda item: (
                item[1] is None,
                -(item[1][0]) if item[1] else 0,
                -(item[1][1]) if item[1] else 0,
                -(item[1][2]) if item[1] else 0,
                item[2],
            )
        )
        reviews.extend(row for row, _, _ in question_reviews[:_MAX_REVIEW_ANSWERS_PER_QUESTION])
    return reviews, total_answers


def _build_one_profile(
    school: str,
    *,
    moe: dict[str, dict[str, str]],
    historical_rows: list[dict[str, str]],
    page_result: dict[str, Any] | None,
    page_error: dict[str, Any] | None,
    source_states: dict[str, dict[str, Any]],
    historical_roster: dict[str, dict[str, str]],
    eol_result: dict[str, Any] | None,
    eol_info: dict[str, Any] | None,
    eol_error: dict[str, Any] | None,
) -> dict[str, Any]:
    key = normalize_colleges_chat_name(school)
    official_record = moe.get(key)
    historical_roster_record = historical_roster.get(key)
    fields, historical_row = _existing_profile_fields(school, moe, historical_rows)
    historical_ambiguous = bool(_exact_rows(historical_rows, key)) and historical_row is None

    # Values are copied only from fields with a clear source; no labels,
    # tuition ranges, phones, or current URLs are inferred.
    city = fields["city"]
    ownership = fields["ownership"]
    tier = fields["tier"]
    category = fields["category"]
    official_site = fields["official_site"]
    eol_item = (eol_result or {}).get("item", {})
    eol_field_values = {
        "city": str(eol_item.get("city_name") or "").strip(),
        "ownership": str(eol_item.get("nature_name") or "").strip(),
        "tier": str(eol_item.get("level_name") or "").strip(),
        "category": str(eol_item.get("type_name") or "").strip(),
    }
    eol_filled_fields: list[str] = []
    for field, value in eol_field_values.items():
        if value and not fields[field]:
            fields[field] = value
            eol_filled_fields.append(field)
    city = fields["city"]
    ownership = fields["ownership"]
    tier = fields["tier"]
    category = fields["category"]
    if eol_info and not official_site:
        candidate_site = _safe_url(str((eol_info.get("record") or {}).get("school_site") or ""))
        if candidate_site:
            official_site = candidate_site
            fields["official_site"] = candidate_site
            eol_filled_fields.append("official_site")

    sections: dict[str, list[dict[str, Any]]] = {
        "basic": [],
        "admission": [],
        "major_strength": [],
        "life": [],
        "development": [],
    }
    summary: list[dict[str, Any]] = []
    missing: list[str] = []

    if official_record:
        summary.append(
            {
                "type": "教育部普通高校名单",
                "title": "教育部普通高校名单（截至2026年6月17日）",
                "status": "精确校名匹配",
                "confidence": "高",
                "year": MOE_YEAR,
                "source_url": MOE_PAGE_URL,
                "license": MOE_LICENSE,
            }
        )
        sections["basic"].append(
            {
                "title": "2026名册状态",
                "value": "列入教育部截至2026年6月17日全国普通高等学校名单",
                "source": "教育部",
                "source_url": MOE_PAGE_URL,
                "year": MOE_YEAR,
                "license": MOE_LICENSE,
                "confidence": "高",
            }
        )
    elif source_states.get("moe", {}).get("parsed"):
        missing.append("official_roster_2026_exact_match")
        summary.append(
            {
                "type": "教育部普通高校名单",
                "title": "教育部普通高校名单（截至2026年6月17日）",
                "status": "未找到精确规范名；请核对是否更名、停办或属于分校区",
                "confidence": "高",
                "year": MOE_YEAR,
                "source_url": MOE_PAGE_URL,
                "license": MOE_LICENSE,
            }
        )
    else:
        missing.append("official_roster_2026")
        summary.append(
            {
                "type": "教育部普通高校名单",
                "title": "教育部2026年名单",
                "status": source_states.get("moe", {}).get("error", "附件未能读取"),
                "confidence": "待补充",
                "year": MOE_YEAR,
                "source_url": MOE_PAGE_URL,
                "license": MOE_LICENSE,
            }
        )

    if not official_record and historical_roster_record:
        summary.append(
            {
                "type": "教育部高校名单（历史副本）",
                "title": "DaoSword 收录的教育部高校名单 CSV",
                "status": "仅为历史副本精确匹配，不能视为2026名册核验",
                "confidence": "中",
                "year": DAO_YEAR,
                "source_url": DAO_LIST_URL,
                "license": DAO_LICENSE,
                "license_url": DAO_LICENSE_URL,
            }
        )
        sections["basic"].append(
            {
                "title": "历史名单记录",
                "value": "出现在 DaoSword 收录的历史教育部名单 CSV 中；此记录不代表2026名册状态",
                "source": "DaoSword/China-Education-Data",
                "source_url": DAO_LIST_URL,
                "year": DAO_YEAR,
                "license": DAO_LICENSE,
                "license_url": DAO_LICENSE_URL,
                "confidence": "中",
            }
        )

    if historical_row:
        summary.append(
            {
                "type": "高校基础信息（历史）",
                "title": "高校综合信息表 v20230118",
                "status": "历史记录，字段可能已变化",
                "confidence": "中",
                "year": DAO_YEAR,
                "source_url": DAO_WIDE_URL,
                "license": DAO_LICENSE,
                "license_url": DAO_LICENSE_URL,
            }
        )
        for title, value in (
            ("城市（历史资料）", historical_row.get("所在城市", "").strip()),
            ("办学性质（历史资料）", historical_row.get("学校性质", "").strip()),
            ("办学层次（历史资料）", historical_row.get("办学层次", "").strip()),
            ("学校类别（历史资料）", historical_row.get("学校类别", "").strip()),
            ("官网（历史资料）", _safe_url(historical_row.get("学校官网", ""))),
        ):
            if value:
                sections["basic"].append(
                    {
                        "title": title,
                        "value": value,
                        "source": "高校综合信息表 v20230118",
                        "source_url": DAO_WIDE_URL,
                        "year": DAO_YEAR,
                        "license": DAO_LICENSE,
                        "license_url": DAO_LICENSE_URL,
                        "confidence": "中",
                    }
                )
        second_round_disciplines = str(historical_row.get("双一流建设_第二轮_学科名单") or "").strip()
        if second_round_disciplines.casefold() not in {"", "0", "0.0", "false", "nan", "none", "无"}:
            sections["major_strength"].append(
                {
                    "title": "第二轮“双一流”建设学科（2022年名单，2023年资料）",
                    "value": second_round_disciplines,
                    "status": "历史名单信息，不代表现行建设或评估结果",
                    "source": "高校综合信息表 v20230118",
                    "source_url": DAO_WIDE_URL,
                    "year": DAO_YEAR,
                    "program_year": 2022,
                    "license": DAO_LICENSE,
                    "license_url": DAO_LICENSE_URL,
                    "confidence": "中",
                }
            )
        if historical_ambiguous:
            missing.append("historical_school_record_ambiguous")
    elif source_states.get("dao_wide", {}).get("status") in {"downloaded", "cached"}:
        missing.extend(["historical_city", "ownership", "historical_tier", "official_site"])
    else:
        missing.extend(["historical_basic_information"])

    if eol_result:
        eol_url = str(eol_result.get("url") or "")
        eol_retrieved = str(eol_result.get("retrieved_at") or "")
        summary.append(
            {
                "type": "中国教育在线公开接口",
                "title": "中国教育在线院校列表接口",
                "status": (
                    "规范名精确且唯一匹配；未提供官方核验年份，不代表教育部2026核验"
                    + (f"；补充字段：{', '.join(eol_filled_fields)}" if eol_filled_fields else "")
                ),
                "confidence": "中",
                "source_url": eol_url,
                "retrieved_at": eol_retrieved,
                "license": EOL_LICENSE,
            }
        )
        for field, title, value in (
            ("city", "城市（中国教育在线）", eol_field_values["city"]),
            ("ownership", "办学性质（中国教育在线）", eol_field_values["ownership"]),
            ("tier", "办学层次（中国教育在线）", eol_field_values["tier"]),
            ("category", "类别（中国教育在线）", eol_field_values["category"]),
        ):
            if field in eol_filled_fields and value:
                sections["basic"].append(
                    {
                        "title": title,
                        "value": value,
                        "source": "中国教育在线公开接口",
                        "source_url": eol_url,
                        "retrieved_at": eol_retrieved,
                        "license": EOL_LICENSE,
                        "confidence": "中",
                    }
                )
    elif eol_error and eol_error.get("search"):
        search_state = eol_error["search"]
        summary.append(
            {
                "type": "中国教育在线公开接口",
                "title": "中国教育在线院校列表接口",
                "status": search_state.get("error", "没有可用的精确唯一匹配"),
                "confidence": "待补充",
                "source_url": search_state.get("source_url", ""),
                "retrieved_at": search_state.get("retrieved_at", ""),
                "license": EOL_LICENSE,
            }
        )

    if eol_info:
        info_url = str(eol_info.get("url") or "")
        info_retrieved = str(eol_info.get("retrieved_at") or "")
        site_from_info = _safe_url(str((eol_info.get("record") or {}).get("school_site") or ""))
        summary.append(
            {
                "type": "中国教育在线院校详情接口",
                "title": "中国教育在线学校详情 info.json",
                "status": "data.name 精确匹配并使用 school_site 字段" if site_from_info and "official_site" in eol_filled_fields else "data.name 精确匹配；未取得可用 school_site",
                "confidence": "中",
                "source_url": info_url,
                "retrieved_at": info_retrieved,
                "license": EOL_LICENSE,
            }
        )
        if site_from_info and "official_site" in eol_filled_fields:
            sections["basic"].append(
                {
                    "title": "官网（中国教育在线名称核验）",
                    "value": site_from_info,
                    "source": "中国教育在线院校详情 info.json",
                    "source_url": info_url,
                    "retrieved_at": info_retrieved,
                    "license": EOL_LICENSE,
                    "confidence": "中",
                }
            )
    elif eol_error and eol_error.get("info"):
        info_state = eol_error["info"]
        summary.append(
            {
                "type": "中国教育在线院校详情接口",
                "title": "中国教育在线学校详情 info.json",
                "status": info_state.get("error", "详情接口不可用"),
                "confidence": "待补充",
                "source_url": info_state.get("source_url", ""),
                "retrieved_at": info_state.get("retrieved_at", ""),
                "license": EOL_LICENSE,
            }
        )

    if not city:
        missing.append("city")
    if not ownership:
        missing.append("ownership")
    if not tier:
        missing.append("tier")
    # The pinned table has no verified tuition range field. Keep it absent.
    missing.append("tuition_range")
    if not official_site:
        missing.append("official_site")

    reviews: list[dict[str, Any]] = []
    review_count_total = 0
    review_count_selected = 0
    if page_result and page_result.get("available"):
        reviews, review_count_total = _make_review_rows(page_result)
        review_count_selected = len(reviews)
        summary.append(
            {
                "type": "CollegesChat 学生问卷",
                "title": "CollegesChat/university-information",
                "status": (
                    f"原始有效回答 {review_count_total} 条；保留 {review_count_selected} 条，"
                    "每题最多3条较新回答"
                ),
                "confidence": "中",
                "year": 2026,
                "source_url": page_result.get("source_url", ""),
                "license": page_result.get("license", COLLEGES_CHAT_LICENSE),
                "license_url": COLLEGES_CHAT_LICENSE_URL,
                "source_version": page_result.get("source_version", COLLEGES_CHAT_SOURCE_VERSION),
                "updated": page_result.get("last_updated", COLLEGES_CHAT_GENERATED_AT),
            }
        )
        if reviews:
            dates = [item["date"] for item in reviews if item.get("date")]
            latest = max(dates) if dates else "日期未提供"
            sections["life"].append(
                {
                    "title": "学生生活问卷",
                    "value": (
                        f"展示 {review_count_selected} 条可追溯回答（原始有效回答 {review_count_total} 条），"
                        f"每题最多3条较新回答；最新标注日期：{latest}。内容为学生体验，不代表学校官方承诺。"
                    ),
                    "source": "CollegesChat 学生问卷",
                    "source_url": page_result.get("source_url", ""),
                    "year": 2026,
                    "license": page_result.get("license", COLLEGES_CHAT_LICENSE),
                    "license_url": COLLEGES_CHAT_LICENSE_URL,
                    "confidence": "中",
                }
            )
    else:
        missing.append("student_reviews")
        summary.append(
            {
                "type": "CollegesChat 学生问卷",
                "title": "CollegesChat/university-information",
                "status": (page_error or {}).get("error", "没有精确匹配且可用的院校问卷"),
                "confidence": "待补充",
                "year": 2026,
                "source_url": (page_error or {}).get("source_url", COLLEGES_CHAT_NAV_URL),
                "license": COLLEGES_CHAT_LICENSE,
            }
        )

    if not any(row.get("title", "").startswith("官网（") for row in sections["basic"]):
        missing.append("historical_official_site")
    # Keep missing_fields predictable even when multiple data paths agree.
    missing_fields = list(dict.fromkeys(missing))
    profile_year = MOE_YEAR if official_record else (DAO_YEAR if historical_row or historical_roster_record else None)
    primary_source_url = MOE_PAGE_URL if official_record else (DAO_WIDE_URL if historical_row else (DAO_LIST_URL if historical_roster_record else ""))
    primary_license = MOE_LICENSE if official_record else (DAO_LICENSE if historical_row or historical_roster_record else "")

    headline: dict[str, Any] = {}
    for field, value in (("city", city), ("ownership", ownership), ("tier", tier), ("category", category)):
        if value:
            headline[field] = value

    # Avoid claiming a current roster membership when only old data matched.
    official_roster = "listed" if official_record else ("not_matched" if source_states.get("moe", {}).get("parsed") else "unavailable")
    return {
        "school": school,
        "headline": headline,
        "sections": sections,
        "reviews": reviews,
        "review_count_total": review_count_total,
        "review_count_selected": review_count_selected,
        "official": {
            "official_site": official_site,
            "admission_site": "",
            "admission_phone": "",
            "public_source_type": (
                "中国教育在线 school_site（data.name 精确匹配）"
                if official_site and "official_site" in eol_filled_fields
                else ("高校综合信息表 v20230118（历史记录）" if official_site else "")
            ),
        },
        "source_summary": summary,
        "source_url": primary_source_url,
        "year": profile_year,
        "license": primary_license,
        "missing_fields": missing_fields,
        "official_roster_2026": official_roster,
    }


def build_profiles(schools: list[str], raw_dir: Path, *, offline: bool = False) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Build school profiles from cached/downloaded public source files.

    Matching is exact after whitespace normalization. The supplied key is kept
    in the output, and every requested school receives a profile even when all
    sources are missing. ``report`` records source and per-school failures.
    """
    raw_dir = Path(raw_dir)
    source_root = raw_dir / "public_profiles"
    source_root.mkdir(parents=True, exist_ok=True)
    errors: list[dict[str, str]] = []

    # Download the current official roster, a historical fallback data table,
    # and the pinned CollegesChat index once. None touch the API service cache.
    moe_xls_path = source_root / "moe" / "colleges-2026.xls"
    moe_xls, moe_state = _read_cached(
        moe_xls_path, MOE_XLS_URL, offline=offline, year=MOE_YEAR, license_name=MOE_LICENSE
    )
    source_states: dict[str, dict[str, Any]] = {"moe": moe_state}
    moe_roster: dict[str, dict[str, str]] = {}
    if moe_xls is not None:
        try:
            moe_roster, validation = _read_moe_xls(moe_xls)
            source_states["moe"] = {
                **moe_state,
                "page_url": MOE_PAGE_URL,
                "attachment_url": MOE_XLS_URL,
                "year": MOE_YEAR,
                "license": MOE_LICENSE,
                "status": "parsed",
                "cache_status": moe_state.get("status"),
                "parsed": True,
                **validation,
            }
        except Exception as exc:
            source_states["moe"] = {
                **moe_state,
                "status": "invalid_payload",
                "error": str(exc),
            }

    dao_path = source_root / "dao" / "university-wide-v20230118.csv"
    dao_data, dao_state = _read_cached(
        dao_path, DAO_WIDE_URL, offline=offline, year=DAO_YEAR, license_name=DAO_LICENSE
    )
    source_states["dao_wide"] = dao_state
    historical_rows: list[dict[str, str]] = []
    if dao_data is not None:
        try:
            historical_rows = _csv_rows(dao_data)
            source_states["dao_wide"]["status"] = dao_state.get("status", "cached")
        except Exception as exc:
            source_states["dao_wide"] = {**dao_state, "status": "unavailable", "error": f"CSV解析失败：{exc}"}

    # The CSV roster in this project is historical and only used if the official
    # attachment cannot be parsed; it is never presented as a 2026 verification.
    dao_list_path = source_root / "dao" / "moe-school-list-historical.csv"
    historical_roster: dict[str, dict[str, str]] = {}
    if not moe_roster:
        dao_list_data, dao_list_state = _read_cached(
            dao_list_path, DAO_LIST_URL, offline=offline, year=DAO_YEAR, license_name=DAO_LICENSE
        )
        source_states["dao_list"] = dao_list_state
        if dao_list_data:
            try:
                # Keep a standalone parsed fallback; no 2026 label is attached.
                rows = _csv_rows(dao_list_data)
                historical_roster = {
                    normalize_colleges_chat_name(row.get("学校名称", "")): row
                    for row in rows
                    if row.get("学校名称", "").strip()
                }
                source_states["dao_list"]["parsed_school_count"] = len(historical_roster)
                source_states["dao_list"]["historical_only"] = True
            except Exception as exc:
                source_states["dao_list"] = {**dao_list_state, "status": "unavailable", "error": f"CSV解析失败：{exc}"}

    eol_targets: dict[str, list[str]] = {}
    for school in schools:
        existing, _ = _existing_profile_fields(school, moe_roster, historical_rows)
        missing_eol_fields = [field for field, value in existing.items() if not value]
        if missing_eol_fields:
            eol_targets[school] = missing_eol_fields

    eol_results: dict[str, dict[str, Any]] = {}
    eol_errors: dict[str, dict[str, Any]] = {}
    eol_search_states: dict[str, dict[str, Any]] = {}
    if eol_targets:
        with ThreadPoolExecutor(max_workers=min(4, len(eol_targets))) as pool:
            future_map = {
                pool.submit(_fetch_eol_record, raw_dir, school, offline=offline): school
                for school in eol_targets
            }
            for future in as_completed(future_map):
                school = future_map[future]
                try:
                    result, state = future.result()
                except Exception as exc:
                    result, state = None, {"status": "unavailable", "error": str(exc)}
                eol_search_states[school] = state
                if result:
                    eol_results[school] = result
                else:
                    eol_errors[school] = {"search": state}
                    errors.append({"school": school, "source": "中国教育在线公开接口", "error": str(state.get("error", "接口查询失败"))})

    eol_info_results: dict[str, dict[str, Any]] = {}
    eol_info_states: dict[str, dict[str, Any]] = {}
    eol_info_targets: dict[str, str] = {}
    for school, result in eol_results.items():
        existing, _ = _existing_profile_fields(school, moe_roster, historical_rows)
        school_id = str(result.get("item", {}).get("school_id") or "").strip()
        if not existing["official_site"]:
            eol_info_targets[school] = school_id
    if eol_info_targets:
        with ThreadPoolExecutor(max_workers=min(4, len(eol_info_targets))) as pool:
            future_map = {
                pool.submit(_fetch_eol_school_info, raw_dir, school, school_id, offline=offline): school
                for school, school_id in eol_info_targets.items()
            }
            for future in as_completed(future_map):
                school = future_map[future]
                try:
                    result, state = future.result()
                except Exception as exc:
                    result, state = None, {"status": "unavailable", "error": str(exc)}
                eol_info_states[school] = state
                if result:
                    eol_info_results[school] = result
                else:
                    eol_errors.setdefault(school, {})["info"] = state
                    errors.append({"school": school, "source": "中国教育在线院校详情接口", "error": str(state.get("error", "详情接口查询失败"))})

    if eol_targets:
        source_states["eol"] = {
            "license": EOL_LICENSE,
            "requested_school_count": len(eol_targets),
            "schools": {
                school: {
                    "missing_fields": eol_targets[school],
                    "search": eol_search_states.get(school),
                    "info": eol_info_states.get(school),
                }
                for school in eol_targets
            },
        }

    nav_path = source_root / "colleges-chat" / "nav.txt"
    nav_data, nav_state = _read_cached(
        nav_path,
        COLLEGES_CHAT_NAV_URL,
        offline=offline,
        year=2026,
        license_name=COLLEGES_CHAT_LICENSE,
    )
    source_states["colleges_chat_nav"] = nav_state
    nav_items: list[dict[str, str]] = []
    if nav_data is not None:
        try:
            nav_items = parse_colleges_chat_nav(nav_data.decode("utf-8-sig", errors="replace"))
        except Exception as exc:
            source_states["colleges_chat_nav"] = {**nav_state, "status": "unavailable", "error": f"问卷索引解析失败：{exc}"}
    by_exact_name: dict[str, list[dict[str, str]]] = {}
    for item in nav_items:
        by_exact_name.setdefault(item["normalized"], []).append(item)

    selected: dict[str, dict[str, str]] = {}
    for school in schools:
        key = normalize_colleges_chat_name(school)
        matches = by_exact_name.get(key, [])
        if len(matches) == 1:
            selected[school] = matches[0]
        elif len(matches) > 1:
            errors.append({"school": school, "source": "CollegesChat", "error": "规范名对应多个资料页，跳过以避免误合并"})

    page_texts: dict[str, str] = {}
    page_states: dict[str, dict[str, Any]] = {}
    if selected:
        workers = min(4, len(selected))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            future_map = {
                pool.submit(_cache_page, raw_dir, item["path"], offline=offline): school
                for school, item in selected.items()
            }
            for future in as_completed(future_map):
                school = future_map[future]
                try:
                    text, state = future.result()
                except Exception as exc:
                    text, state = None, {"status": "unavailable", "error": str(exc)}
                page_states[school] = state
                if text is not None:
                    page_texts[school] = text
                elif state.get("error"):
                    errors.append({"school": school, "source": "CollegesChat", "error": str(state["error"])})

    page_payloads: dict[str, dict[str, Any]] = {}
    for school, text in page_texts.items():
        try:
            item = selected[school]
            parsed = parse_colleges_chat_markdown(text, item["path"])
            # Validate the page's own title too. An index entry with a stale or
            # redirected document must not be attached to another institution.
            if normalize_colleges_chat_name(parsed.get("school", "")) != normalize_colleges_chat_name(school):
                raise ValueError("索引路径的文档标题与规范校名不一致")
            pinned_blob_url = (
                f"https://github.com/CollegesChat/university-information/blob/"
                f"{COLLEGES_CHAT_SOURCE_VERSION}/docs/{item['path']}"
            )
            parsed["source_url"] = pinned_blob_url
            parsed["source_version"] = COLLEGES_CHAT_SOURCE_VERSION
            parsed["last_updated"] = COLLEGES_CHAT_GENERATED_AT
            page_payloads[school] = parsed
        except Exception as exc:
            errors.append({"school": school, "source": "CollegesChat", "error": str(exc)})
            page_states[school] = {**page_states.get(school, {}), "status": "invalid", "error": str(exc)}

    profiles: dict[str, dict[str, Any]] = {}
    missing_by_school: dict[str, list[str]] = {}
    for school in schools:
        page_error = page_states.get(school)
        if not page_error and not selected.get(school):
            page_error = {
                "source_url": COLLEGES_CHAT_NAV_URL,
                "error": (
                    "CollegesChat 索引未载入" if not nav_items else "CollegesChat 没有精确规范名匹配"
                ),
            }
        profile = _build_one_profile(
            school,
            moe=moe_roster,
            historical_rows=historical_rows,
            page_result=page_payloads.get(school),
            page_error=page_error,
            source_states=source_states,
            historical_roster=historical_roster,
            eol_result=eol_results.get(school),
            eol_info=eol_info_results.get(school),
            eol_error=eol_errors.get(school),
        )
        profiles[school] = profile
        missing_by_school[school] = profile["missing_fields"]

    # A compact report keeps failures diagnosable for large input lists.
    for key, state in source_states.items():
        if state.get("error"):
            errors.append({"source": key, "error": str(state["error"])})
    report = {
        "requested_count": len(schools),
        "profile_count": len(profiles),
        "official_roster_2026_matched": sum(1 for item in profiles.values() if item["official_roster_2026"] == "listed"),
        "historical_basic_matched": sum(1 for item in profiles.values() if "高校综合信息表 v20230118" in [row.get("title") for row in item["source_summary"]]),
        "reviews_available": sum(1 for item in profiles.values() if item["reviews"]),
        "missing_fields_by_school": missing_by_school,
        "sources": source_states,
        "errors": errors,
        "offline": offline,
    }
    _write_json(source_root / "build-report.json", report)
    return profiles, report


__all__ = ["build_profiles"]
