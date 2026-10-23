from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend import public_sources


PDF_BYTES = b"%PDF-1.7\nminimal test pdf bytes"
URL = "https://example.gov.cn/segment.pdf"


def test_fetch_source_caches_verified_pdf_with_provenance(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    destination = tmp_path / "segment.pdf"
    requests: list[str] = []

    def request(url: str) -> tuple[bytes, str, str]:
        requests.append(url)
        return PDF_BYTES, "application/octet-stream", url

    monkeypatch.setattr(public_sources, "_request_pdf", request)
    first = public_sources.fetch_source(URL, destination)
    second = public_sources.fetch_source(URL, destination, offline=True)
    sidecar = json.loads((tmp_path / "segment.pdf.source.json").read_text(encoding="utf-8"))

    assert len(requests) == 1
    assert destination.read_bytes() == PDF_BYTES
    assert first["reused"] is False
    assert second["reused"] is True
    assert sidecar["url"] == URL
    assert sidecar["sha256"] == hashlib.sha256(PDF_BYTES).hexdigest()
    assert sidecar["bytes"] == len(PDF_BYTES)
    assert sidecar["content_type"] == "application/octet-stream"
    assert sidecar["retrieved_at"]


def test_fetch_source_rejects_html_and_retries_three_times(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    destination = tmp_path / "segment.pdf"
    requests = 0

    def request(url: str) -> tuple[bytes, str, str]:
        nonlocal requests
        requests += 1
        return b"<html>not a PDF</html>", "text/html", url

    monkeypatch.setattr(public_sources, "_request_pdf", request)
    monkeypatch.setattr(public_sources.time, "sleep", lambda _: None)
    with pytest.raises(public_sources.SourceFetchError, match="after 3 attempts"):
        public_sources.fetch_source(URL, destination)

    assert requests == 3
    assert not destination.exists()
    assert not (tmp_path / "segment.pdf.source.json").exists()


def test_fetch_source_detects_corrupt_cache_in_offline_mode(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    destination = tmp_path / "segment.pdf"
    monkeypatch.setattr(public_sources, "_request_pdf", lambda url: (PDF_BYTES, "application/pdf", url))
    public_sources.fetch_source(URL, destination)
    destination.write_bytes(b"%PDF-corrupted after download")

    with pytest.raises(public_sources.SourceFetchError, match="cache is missing or invalid"):
        public_sources.fetch_source(URL, destination, offline=True)


def _fake_pdf(monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    page = SimpleNamespace(extract_text=lambda: text)

    class FakePDF:
        pages = [page]

        def __enter__(self) -> "FakePDF":
            return self

        def __exit__(self, *_: object) -> None:
            return None

    monkeypatch.setattr(public_sources.pdfplumber, "open", lambda _: FakePDF())


def test_parse_segment_pdf_handles_multi_score_rows_top_ties_and_zero_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "segment.pdf"
    source.write_bytes(PDF_BYTES)
    source.with_name(source.name + ".source.json").write_text(
        json.dumps({"url": URL}), encoding="utf-8"
    )
    _fake_pdf(
        monkeypatch,
        """贵州省2026年高考普通类分数段统计表（首选物理类）
分数 691及以上 690
本段人数 2 0
累计人数 2 2
累计比例% 0.01 0.01
分数 689 688
本段人数 3 1
累计人数 5 6
累计比例% 0.02 0.03""",
    )

    parsed = public_sources.parse_segment_pdf(source, 2026)

    assert parsed["schema_version"] == 2
    assert parsed["year"] == 2026
    assert parsed["source_url"] == URL
    assert parsed["rows"] == [
        {"score": 688, "rank_low": 6, "rank_high": 6, "rank_mid": 6.0},
        {"score": 689, "rank_low": 3, "rank_high": 5, "rank_mid": 4.0},
        {"score": 691, "rank_low": 1, "rank_high": 2, "rank_mid": 1.5},
    ]
    assert parsed["validation"]["zero_count_rows_omitted"] == 1
    assert parsed["validation"]["total_candidates"] == 6
    assert parsed["validation"]["cumulative_consistent"] is True


@pytest.mark.parametrize(
    ("title", "year", "message"),
    [
        ("贵州省2025年高考普通类分数段统计表（首选物理）", 2026, "requested year"),
        ("贵州省2026年高考普通类分数段统计表（首选历史类）", 2026, "physics subject"),
    ],
)
def test_parse_segment_pdf_rejects_wrong_year_or_subject(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    title: str,
    year: int,
    message: str,
) -> None:
    source = tmp_path / "segment.pdf"
    source.write_bytes(PDF_BYTES)
    _fake_pdf(
        monkeypatch,
        f"{title}\n分数 600\n本段人数 1\n累计人数 1\n累计比例% 0.01",
    )

    with pytest.raises(ValueError, match=message):
        public_sources.parse_segment_pdf(source, year)


def test_parse_segment_pdf_rejects_inconsistent_cumulative_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "segment.pdf"
    source.write_bytes(PDF_BYTES)
    _fake_pdf(
        monkeypatch,
        "贵州省2026年高考物理类分数段统计表\n分数 600 599\n本段人数 2 1\n累计人数 2 4\n累计比例% 0.01 0.02",
    )

    with pytest.raises(ValueError, match="does not reconcile"):
        public_sources.parse_segment_pdf(source, 2026)
