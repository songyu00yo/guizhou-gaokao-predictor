from __future__ import annotations

import hashlib
import io
import json
import os
import re
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image


MAX_IMAGE_BYTES = 1_000_000
MAX_IMAGE_EDGE = 2048
ALLOWED_FORMATS = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}


def _normalise_name(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "").strip())


class LogoService:
    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = cache_dir
        self.index_path = cache_dir / "index.json"
        self._lock = threading.RLock()
        self._index = self._load_index()

    def _load_index(self) -> dict[str, dict[str, Any]]:
        try:
            return json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_index(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.index_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._index, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, self.index_path)

    @staticmethod
    def placeholder(school: str, status: str = "pending", message: str = "校徽待获取") -> dict[str, Any]:
        label = "".join(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", school))[:2] or "校徽"
        return {"school": school, "status": status, "logo_url": "", "label": label, "message": message}

    def get(self, school: str, fetch: bool = False) -> dict[str, Any]:
        key = _normalise_name(school)
        with self._lock:
            cached = self._index.get(key)
        if cached or not fetch:
            return cached or self.placeholder(school)
        return self._fetch(school)

    def _fetch(self, school: str) -> dict[str, Any]:
        key = _normalise_name(school)
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
            exact = [item for item in items if _normalise_name(item.get("name", "")) == key]
            school_id = str((exact or items)[0].get("school_id") or "") if (exact or items) else ""
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
            temporary = self.cache_dir / f"{filename}.tmp"
            temporary.write_bytes(data)
            os.replace(temporary, self.cache_dir / filename)
            result = {
                **self.placeholder(school, "ready", "来自掌上高考公开校徽资源，建议以学校官网为准"),
                "logo_url": f"/api/school-logo/{filename}",
                "source_type": "掌上高考公开资源",
            }
        except Exception:
            result = self.placeholder(school, "failed", "未获取到可验证的 PNG/JPEG/WebP 校徽")
        with self._lock:
            self._index[key] = result
            self._save_index()
        return result

    def file(self, filename: str) -> Path | None:
        if not re.fullmatch(r"[0-9a-f]{20}\.(?:png|jpg|webp)", filename):
            return None
        path = self.cache_dir / filename
        return path if path.is_file() else None
