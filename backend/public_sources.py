from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

import pdfplumber


class SourceFetchError(RuntimeError):
    """Raised when a public source cannot be fetched and verified."""


_MAX_ATTEMPTS = 3
_REQUEST_TIMEOUT_SECONDS = 30
_PDF_CONTENT_TYPES = {"application/pdf", "application/octet-stream"}

# The 2024 and 2025 PDFs below are mirrors of the official announcement (their
# pages attribute the files to 贵州省招生考试院); 2026 is the direct official
# 招考院 attachment supplied with the source request.
SEGMENT_SOURCES: dict[int, str] = {
    2024: "https://www.gyzkzx.cn/images/site63/20240626/2cfda1dfe06927e5ce5b0f.pdf",
    2025: "https://www.jhgk.cn/upload/file/20250625/1750845736130052913.pdf",
    2026: "https://zsksy.guizhou.gov.cn/zlxz/202606/P020260625601945906859.pdf",
}


def _sidecar_path(destination: Path) -> Path:
    return destination.with_name(destination.name + ".source.json")


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


class _HTTPSRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Request:
        if urlparse(newurl).scheme.lower() != "https":
            raise SourceFetchError(f"Refusing non-HTTPS redirect to {newurl!r}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _request_pdf(url: str) -> tuple[bytes, str, str]:
    request = Request(url, headers={"User-Agent": "GuizhouAdmissionsResearch/1.0"})
    opener = build_opener(_HTTPSRedirectHandler())
    with opener.open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
        final_url = response.geturl()
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        return response.read(), content_type, final_url


def _read_valid_cache(url: str, destination: Path) -> dict[str, Any] | None:
    sidecar = _sidecar_path(destination)
    if not destination.is_file() or not sidecar.is_file():
        return None
    try:
        metadata = json.loads(sidecar.read_text(encoding="utf-8"))
        data = destination.read_bytes()
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    digest = hashlib.sha256(data).hexdigest()
    if not isinstance(metadata, dict) or (
        metadata.get("url") != url
        or metadata.get("sha256") != digest
        or metadata.get("bytes") != len(data)
        or not data.startswith(b"%PDF-")
        or metadata.get("content_type") not in _PDF_CONTENT_TYPES
    ):
        return None
    return metadata


def fetch_source(
    url: str,
    destination: Path,
    *,
    expected_kind: str = "pdf",
    offline: bool = False,
) -> dict[str, Any]:
    """Fetch and cache a public PDF, verifying its type and recording provenance."""
    destination = Path(destination)
    if expected_kind != "pdf":
        raise ValueError(f"Unsupported expected_kind {expected_kind!r}; only 'pdf' is supported")
    parsed = urlparse(url)
    if parsed.scheme.lower() != "https" or not parsed.netloc:
        raise ValueError("Public sources must use an absolute HTTPS URL")

    cached = _read_valid_cache(url, destination)
    if cached is not None:
        return {**cached, "path": str(destination), "reused": True}
    if offline:
        raise SourceFetchError(f"Offline source cache is missing or invalid for {url}: {destination}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            data, content_type, final_url = _request_pdf(url)
            if urlparse(final_url).scheme.lower() != "https":
                raise SourceFetchError(f"Refusing non-HTTPS final URL {final_url!r}")
            if content_type not in _PDF_CONTENT_TYPES:
                raise SourceFetchError(
                    f"Expected a PDF content type, received {content_type or '(missing)'} from {final_url}"
                )
            if not data.startswith(b"%PDF-"):
                raise SourceFetchError(f"Response from {final_url} does not have a PDF file signature")

            metadata: dict[str, Any] = {
                "url": url,
                "retrieved_at": datetime.now(timezone.utc).isoformat(),
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
                "content_type": content_type,
            }
            _atomic_write(destination, data)
            _atomic_write(
                _sidecar_path(destination),
                (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
            )
            return {**metadata, "path": str(destination), "reused": False}
        except Exception as exc:
            failures.append(f"attempt {attempt}: {type(exc).__name__}: {exc}")
            if attempt < _MAX_ATTEMPTS:
                time.sleep(0.1 * attempt)

    raise SourceFetchError(f"Failed to fetch verified PDF after {_MAX_ATTEMPTS} attempts for {url}: " + "; ".join(failures))


def _parse_score(token: str) -> int | None:
    match = re.fullmatch(r"(\d+)(?:分)?(?:及以上|以上|\+)?", token)
    return int(match.group(1)) if match else None


def _parse_integer_tokens(value: str) -> list[int]:
    return [int(token) for token in re.findall(r"(?<![\w.])\d+(?![\w.])", value)]


def _read_labeled_values(lines: list[str], start: int, label: str) -> tuple[list[str], int]:
    """Read a labeled PDF row, allowing the values to wrap onto following lines."""
    cursor = start
    while cursor < len(lines) and not lines[cursor].strip():
        cursor += 1
    if cursor >= len(lines):
        raise ValueError(f"Missing PDF row {label!r}")

    line = re.sub(r"\s+", " ", lines[cursor]).strip()
    match = re.match(rf"^{re.escape(label)}\s*(.*)$", line)
    if not match:
        raise ValueError(f"Expected PDF row {label!r}, found {line[:80]!r}")
    values = match.group(1).split()
    cursor += 1
    while cursor < len(lines):
        next_line = re.sub(r"\s+", " ", lines[cursor]).strip()
        if not next_line:
            cursor += 1
            continue
        if next_line.startswith(("分数", "本段人数", "累计人数", "累计比例")):
            break
        values.extend(next_line.split())
        cursor += 1
    return values, cursor


def _source_url_for(path: Path) -> str | None:
    sidecar = _sidecar_path(path)
    if not sidecar.is_file():
        return None
    try:
        metadata = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid source metadata file {sidecar}: {exc}") from exc
    return metadata.get("url")


def parse_segment_pdf(path: Path, year: int) -> dict[str, Any]:
    """Parse an official physics score-band PDF into deterministic score-to-rank rows."""
    path = Path(path)
    with pdfplumber.open(path) as pdf:
        page_texts = [(page.extract_text() or "") for page in pdf.pages]
    text = "\n".join(page_texts)
    lines = text.splitlines()
    normalized_lines = [
        cleaned
        for line in lines
        if (cleaned := re.sub(r"\s+", " ", line).strip())
        and not re.fullmatch(r"第\s*\d+\s*页[，,]\s*共\s*\d+\s*页", cleaned)
    ]
    first_score_line = next((i for i, line in enumerate(normalized_lines) if line.startswith("分数")), None)
    if first_score_line is None:
        raise ValueError(f"No score-band table found in {path}")
    title = " ".join(normalized_lines[:first_score_line])
    if f"{year}年" not in title:
        raise ValueError(f"PDF title does not identify requested year {year}: {title[:160]!r}")
    if "物理" not in title or "历史" in title:
        raise ValueError(f"PDF title is not for the physics subject: {title[:160]!r}")

    rows: list[dict[str, int | float]] = []
    previous_score: int | None = None
    previous_cumulative = 0
    zero_count_rows = 0
    score_groups = 0
    cursor = 0
    while cursor < len(normalized_lines):
        line = normalized_lines[cursor]
        if not line.startswith("分数"):
            cursor += 1
            continue

        score_tokens = line[len("分数") :].split()
        scores = [_parse_score(token) for token in score_tokens]
        if not scores or any(score is None for score in scores):
            raise ValueError(f"Could not parse score labels in {line[:160]!r}")
        score_values = [int(score) for score in scores if score is not None]
        band_values, next_cursor = _read_labeled_values(normalized_lines, cursor + 1, "本段人数")
        cumulative_values, next_cursor = _read_labeled_values(normalized_lines, next_cursor, "累计人数")
        # The official PDFs include a percentage row after rank totals. It is not
        # needed for rank reconstruction, but consuming it prevents it being
        # mistaken for the next malformed score group.
        if next_cursor < len(normalized_lines) and normalized_lines[next_cursor].startswith("累计比例"):
            _, next_cursor = _read_labeled_values(normalized_lines, next_cursor, "累计比例")
        bands = [number for value in band_values for number in _parse_integer_tokens(value)]
        cumulatives = [number for value in cumulative_values for number in _parse_integer_tokens(value)]
        if len(bands) != len(score_values) or len(cumulatives) != len(score_values):
            raise ValueError(
                f"PDF score group has inconsistent column counts: {len(score_values)} scores, "
                f"{len(bands)} band counts, {len(cumulatives)} cumulative counts"
            )

        score_groups += 1
        for score, band_count, cumulative in zip(score_values, bands, cumulatives):
            if previous_score is not None and score >= previous_score:
                raise ValueError(f"Scores are not strictly descending near {score}")
            if band_count < 0 or cumulative < 0:
                raise ValueError(f"Negative count found at score {score}")
            if cumulative < previous_cumulative:
                raise ValueError(f"Cumulative ranks decrease at score {score}")
            if cumulative - previous_cumulative != band_count:
                raise ValueError(
                    f"Band count does not reconcile with cumulative ranks at score {score}: "
                    f"{band_count} != {cumulative} - {previous_cumulative}"
                )
            if band_count == 0:
                zero_count_rows += 1
            else:
                rank_low = previous_cumulative + 1
                rank_high = cumulative
                rows.append(
                    {
                        "score": score,
                        "rank_low": rank_low,
                        "rank_high": rank_high,
                        "rank_mid": (rank_low + rank_high) / 2,
                    }
                )
            previous_score = score
            previous_cumulative = cumulative
        cursor = next_cursor

    if not rows or score_groups == 0:
        raise ValueError(f"No score-band rows parsed from {path}")

    return {
        "schema_version": 2,
        "year": year,
        "source_url": _source_url_for(path),
        "rows": sorted(rows, key=lambda row: row["score"]),
        "validation": {
            "score_groups": score_groups,
            "row_count": len(rows),
            "zero_count_rows_omitted": zero_count_rows,
            "total_candidates": previous_cumulative,
            "cumulative_consistent": True,
            "scores_descending": True,
            "title_year_matches": True,
            "physics_subject_confirmed": True,
        },
    }
