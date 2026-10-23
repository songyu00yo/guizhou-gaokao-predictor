from __future__ import annotations

import io
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image
from fastapi.testclient import TestClient

from backend.logo_service import LogoService
from backend.web import create_app


class _Headers:
    def __init__(self, content_type: str = "application/json") -> None:
        self.content_type = content_type

    def get_content_type(self) -> str:
        return self.content_type


class _Response:
    def __init__(self, data: bytes, content_type: str = "application/json") -> None:
        self.data = data
        self.headers = _Headers(content_type)

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self, limit: int = -1) -> bytes:
        return self.data if limit < 0 else self.data[:limit]


def _png_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (4, 4), color="red").save(output, format="PNG")
    return output.getvalue()


def _school_payload(*items: dict[str, str]) -> bytes:
    return json.dumps({"data": {"item": list(items)}}).encode("utf-8")


def test_fetch_uses_only_nfkc_exact_school_match_and_records_provenance(
    tmp_path: Path, monkeypatch
) -> None:
    requested: list[str] = []

    def fake_urlopen(request, timeout: int):
        url = request.full_url
        requested.append(url)
        if "api.eol.cn" in url:
            return _Response(
                _school_payload(
                    {"name": "ABC师范大学", "school_id": "111"},
                    {"name": "ＡＢＣ大学", "school_id": "222"},
                )
            )
        return _Response(_png_bytes(), "image/png")

    monkeypatch.setattr("backend.logo_service.urllib.request.urlopen", fake_urlopen)
    service = LogoService(tmp_path)

    result = service.get("ABC大学", fetch=True)

    assert result["status"] == "ready"
    assert result["matched_name"] == "ＡＢＣ大学"
    assert result["source_type"] == "掌上高考公开资源"
    assert result["fetched_at"].endswith("Z")
    assert requested[1].endswith("/222.jpg")
    assert service.file(result["logo_url"].rsplit("/", 1)[-1]) is not None


def test_unrelated_search_result_is_not_used_and_failed_fetch_retries_after_interval(
    tmp_path: Path, monkeypatch
) -> None:
    api_calls = 0

    def fake_urlopen(request, timeout: int):
        nonlocal api_calls
        api_calls += 1
        return _Response(_school_payload({"name": "其他大学", "school_id": "123"}))

    monkeypatch.setattr("backend.logo_service.urllib.request.urlopen", fake_urlopen)
    service = LogoService(tmp_path, retry_interval_seconds=3600)

    first = service.get("目标大学", fetch=True)
    second = service.get("目标大学", fetch=True)

    assert first["status"] == second["status"] == "failed"
    assert first["matched_name"] == ""
    assert first["fetched_at"]
    assert api_calls == 1

    service._index["目标大学"]["fetched_at"] = (
        datetime.now(timezone.utc) - timedelta(hours=2)
    ).isoformat()
    service.get("目标大学", fetch=True)
    assert api_calls == 2


def test_missing_cached_file_is_reacquired(tmp_path: Path, monkeypatch) -> None:
    calls: list[str] = []

    def fake_urlopen(request, timeout: int):
        calls.append(request.full_url)
        if "api.eol.cn" in request.full_url:
            return _Response(_school_payload({"name": "测试大学", "school_id": "987"}))
        return _Response(_png_bytes(), "image/png")

    monkeypatch.setattr("backend.logo_service.urllib.request.urlopen", fake_urlopen)
    service = LogoService(tmp_path)
    first = service.get("测试大学", fetch=True)
    logo_path = service.file(first["logo_url"].rsplit("/", 1)[-1])
    assert logo_path is not None
    logo_path.unlink()

    second = service.get("测试大学", fetch=True)

    assert second["status"] == "ready"
    assert len(calls) == 4
    assert service.file(second["logo_url"].rsplit("/", 1)[-1]) is not None
    assert json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))["测试大学"] == second
    assert not list(tmp_path.glob("*.tmp"))


def test_simultaneous_fetches_for_school_share_one_upstream_fetch(tmp_path: Path, monkeypatch) -> None:
    calls: list[str] = []

    def fake_urlopen(request, timeout: int):
        calls.append(request.full_url)
        time.sleep(0.02)
        if "api.eol.cn" in request.full_url:
            return _Response(_school_payload({"name": "并发大学", "school_id": "456"}))
        return _Response(_png_bytes(), "image/png")

    monkeypatch.setattr("backend.logo_service.urllib.request.urlopen", fake_urlopen)
    service = LogoService(tmp_path)
    barrier = threading.Barrier(8)

    def fetch() -> dict[str, object]:
        barrier.wait()
        return service.get("并发大学", fetch=True)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: fetch(), range(8)))

    assert all(result["status"] == "ready" for result in results)
    assert len(calls) == 2


def test_batch_endpoint_caps_concurrent_fetches_at_four() -> None:
    app = create_app()
    state_lock = threading.Lock()
    active = 0
    peak = 0

    class FakeLogos:
        def get(self, school: str, fetch: bool = False) -> dict[str, str]:
            nonlocal active, peak
            with state_lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.02)
            with state_lock:
                active -= 1
            return {"school": school, "status": "pending"}

    with TestClient(app) as client:
        client.app.state.logos = FakeLogos()
        response = client.post("/api/school-assets/batch", json={"schools": [f"学校{i}" for i in range(12)]})

    assert response.status_code == 200
    assert len(response.json()["assets"]) == 12
    assert 1 < peak <= 4

