from __future__ import annotations

import hashlib
import io
import json
import os
import re
import threading
import tempfile
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from PIL import Image


MAX_IMAGE_BYTES = 1_000_000
MAX_IMAGE_EDGE = 2048
ALLOWED_FORMATS = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}
DEFAULT_RETRY_INTERVAL_SECONDS = 300


def _normalise_name(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or "").strip()))


class LogoService:
    def __init__(self, cache_dir: Path, retry_interval_seconds: int = DEFAULT_RETRY_INTERVAL_SECONDS) -> None:
        self.cache_dir = cache_dir
        self.index_path = cache_dir / "index.json"
        self.retry_interval_seconds = max(0, retry_interval_seconds)
        self._lock = threading.RLock()
        self._school_locks: dict[str, threading.Lock] = {}
        self._index = self._load_index()

    def _load_index(self) -> dict[str, dict[str, Any]]:
        try:
            return json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_index(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.cache_dir, prefix=".index-", suffix=".tmp", delete=False
            ) as temporary:
                temporary_path = Path(temporary.name)
                temporary.write(json.dumps(self._index, ensure_ascii=False, indent=2))
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_path, self.index_path)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    @staticmethod
    def placeholder(school: str, status: str = "pending", message: str = "校徽待获取") -> dict[str, Any]:
        label = "".join(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", school))[:2] or "校徽"
        return {"school": school, "status": status, "logo_url": "", "label": label, "message": message}

    def get(self, school: str, fetch: bool = False) -> dict[str, Any]:
        key = _normalise_name(school)
        with self._lock:
            cached = self._index.get(key)
        if not fetch:
            if cached and (cached.get("status") != "ready" or self._cached_image_exists(cached)):
                return cached
            if cached:
                return self.placeholder(school, "pending", "校徽缓存已失效，等待重新获取")
            return self.placeholder(school)

        with self._lock:
            school_lock = self._school_locks.setdefault(key, threading.Lock())
        with school_lock:
            with self._lock:
                cached = self._index.get(key)
            if cached and cached.get("status") == "ready" and self._cached_image_exists(cached):
                return cached
            if cached and cached.get("status") == "failed" and not self._retry_is_due(cached):
                return cached
            return self._fetch(school)

    def _cached_image_exists(self, cached: dict[str, Any]) -> bool:
        logo_url = str(cached.get("logo_url") or "")
        prefix = "/api/school-logo/"
        if not logo_url.startswith(prefix):
            return False
        filename = logo_url[len(prefix):]
        return bool(re.fullmatch(r"[0-9a-f]{20}\.(?:png|jpg|webp)", filename)) and (self.cache_dir / filename).is_file()

    def _retry_is_due(self, cached: dict[str, Any]) -> bool:
        fetched_at = str(cached.get("fetched_at") or "")
        try:
            timestamp = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
        except ValueError:
            # Legacy failures have no timestamp, so the next explicit fetch may retry.
            return True
        return datetime.now(timezone.utc) - timestamp >= timedelta(seconds=self.retry_interval_seconds)

    @staticmethod
    def _fetched_at() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    def _fetch(self, school: str) -> dict[str, Any]:
        key = _normalise_name(school)
        matched_name = ""
        query = urllib.parse.urlencode(
            {"keyword": school, "page": 1, "size": 5, "uri": "apidata/api/gk/school/lists"}
        )
        request = urllib.request.Request(
            f"https://api.eol.cn/web/api/?{query}",
            headers={"User-Agent": "GuizhouGaokaoPredictor/0.1", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=4) as response:
                payload = json.loads(response.read(500_000).decode("utf-8", errors="replace"))
            items = ((payload.get("data") or {}).get("item") or [])
            exact = next(
                (item for item in items if isinstance(item, dict) and _normalise_name(item.get("name", "")) == key),
                None,
            )
            if exact is None:
                raise ValueError("未匹配到精确院校名称")
            matched_name = str(exact.get("name") or "")
            school_id = str(exact.get("school_id") or "")
            if not school_id.isdigit():
                raise ValueError("未匹配到可信院校编号")
            image_url = f"https://static-data.gaokao.cn/upload/logo/{school_id}.jpg"
            image_request = urllib.request.Request(
                image_url,
                headers={"User-Agent": "GuizhouGaokaoPredictor/0.1", "Referer": "https://gkcx.eol.cn/"},
            )
            with urllib.request.urlopen(image_request, timeout=5) as response:
                if response.headers.get_content_type() not in {"image/png", "image/jpeg", "image/webp"}:
                    raise ValueError("远程资源不是允许的图片类型")
                data = response.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError("远程图片超过大小限制")
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                image_format = str(image.format or "").upper()
                if image_format not in ALLOWED_FORMATS:
                    raise ValueError("图片解码格式不受支持")
                if max(image.size) > MAX_IMAGE_EDGE:
                    raise ValueError("图片尺寸超过限制")
                suffix = ALLOWED_FORMATS[image_format]
            digest = hashlib.sha256(data).hexdigest()[:20]
            filename = f"{digest}{suffix}"
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            temporary_path: Path | None = None
            try:
                with self._lock:
                    with tempfile.NamedTemporaryFile(
                        mode="wb", dir=self.cache_dir, prefix=f".{filename}-", suffix=".tmp", delete=False
                    ) as temporary:
                        temporary_path = Path(temporary.name)
                        temporary.write(data)
                        temporary.flush()
                        os.fsync(temporary.fileno())
                    os.replace(temporary_path, self.cache_dir / filename)
            finally:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)
            result = {
                **self.placeholder(school, "ready", "来自掌上高考公开校徽资源，建议以学校官网为准"),
                "logo_url": f"/api/school-logo/{filename}",
                "source_type": "掌上高考公开资源",
                "matched_name": matched_name,
                "fetched_at": self._fetched_at(),
            }
        except Exception:
            result = {
                **self.placeholder(school, "failed", "未获取到可验证的 PNG/JPEG/WebP 校徽"),
                "source_type": "掌上高考公开资源",
                "matched_name": matched_name,
                "fetched_at": self._fetched_at(),
            }
        with self._lock:
            self._index[key] = result
            self._save_index()
        return result

    def file(self, filename: str) -> Path | None:
        if not re.fullmatch(r"[0-9a-f]{20}\.(?:png|jpg|webp)", filename):
            return None
        path = self.cache_dir / filename
        return path if path.is_file() else None
