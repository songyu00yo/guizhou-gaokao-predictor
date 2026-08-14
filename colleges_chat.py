# -*- coding: utf-8 -*-
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any


COLLEGES_CHAT_REPO = "CollegesChat/university-information"
COLLEGES_CHAT_BRANCH = "generated"
COLLEGES_CHAT_SOURCE_VERSION = "079a5070420e14f8db42275d66f33eefab569042"
COLLEGES_CHAT_GENERATED_AT = "2026-06-23 16:23:46"
COLLEGES_CHAT_LICENSE = "CC BY-NC-SA 4.0"
COLLEGES_CHAT_LICENSE_URL = (
    "https://github.com/CollegesChat/university-information/blob/generated/LICENSE"
)
COLLEGES_CHAT_REPO_URL = "https://github.com/CollegesChat/university-information"
COLLEGES_CHAT_NAV_URL = (
    "https://raw.githubusercontent.com/"
    f"{COLLEGES_CHAT_REPO}/{COLLEGES_CHAT_SOURCE_VERSION}/nav.txt"
)
COLLEGES_CHAT_RAW_BASE_URL = (
    "https://raw.githubusercontent.com/"
    f"{COLLEGES_CHAT_REPO}/{COLLEGES_CHAT_SOURCE_VERSION}/docs/"
)
COLLEGES_CHAT_BLOB_BASE_URL = (
    "https://github.com/"
    f"{COLLEGES_CHAT_REPO}/blob/{COLLEGES_CHAT_BRANCH}/docs/"
)
COLLEGES_CHAT_PAGE_BASE_URL = "https://cn.colleges.chat/"


def normalize_colleges_chat_name(name: str) -> str:
    return re.sub(r"\s+", "", str(name or "").strip())


def _safe_cache_name(text: str) -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    return f"{digest}.json"


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _fetch_text(url: str, timeout: float = 8.0, max_bytes: int = 4_000_000) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "GaokaoVolunteerLocal/1.0",
            "Accept": "text/plain, text/markdown, */*",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(max_bytes).decode("utf-8", errors="replace")


def parse_colleges_chat_nav(markdown: str, include_archived: bool = False) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    pattern = re.compile(r"^\s*-\s+(?P<name>.+):\s+(?P<path>(?:archived/)?universities/.+?\.md)\s*$")
    for line in markdown.splitlines():
        match = pattern.match(line)
        if not match:
            continue
        path = match.group("path").strip()
        archived = path.startswith("archived/")
        if archived and not include_archived:
            continue
        name = match.group("name").strip()
        normalized = normalize_colleges_chat_name(name)
        key = (normalized, path)
        if not normalized or key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "school": name,
                "normalized": normalized,
                "path": path,
                "archived": archived,
            }
        )
    return items


def _parse_source_list(markdown: str) -> list[dict[str, str]]:
    sources: list[dict[str, str]] = []
    pattern = re.compile(r"<li>\s*([^:<]+):\s*(.*?)\s*(?:\(([^()]*)\))?\s*</li>")
    for source_id, contributor, date_text in pattern.findall(markdown):
        sources.append(
            {
                "id": source_id.strip(),
                "contributor": contributor.strip() or "匿名",
                "date": date_text.strip(),
            }
        )
    return sources


def _append_answer(answers: list[dict[str, str]], answer: dict[str, str] | None) -> None:
    if answer and answer.get("text", "").strip():
        answer["text"] = answer["text"].strip()
        answers.append(answer)


def parse_colleges_chat_markdown(markdown: str, path: str = "") -> dict[str, Any]:
    title_match = re.search(r"^#\s+(.+?)\s*$", markdown, flags=re.MULTILINE)
    title = title_match.group(1).strip() if title_match else ""
    sources = _parse_source_list(markdown)
    questions: list[dict[str, Any]] = []
    current_question: dict[str, Any] | None = None
    current_answer: dict[str, str] | None = None
    in_free_notes = False

    def close_answer() -> None:
        nonlocal current_answer
        if current_question is not None:
            _append_answer(current_question["answers"], current_answer)
        current_answer = None

    def close_question() -> None:
        nonlocal current_question
        close_answer()
        if current_question and current_question["answers"]:
            questions.append(current_question)
        current_question = None

    for raw_line in markdown.splitlines():
        line = raw_line.rstrip()
        question_match = re.match(r"^##\s+Q:\s*(.+?)\s*$", line)
        if question_match:
            close_question()
            in_free_notes = False
            current_question = {
                "question": question_match.group(1).strip(),
                "answers": [],
                "kind": "question",
            }
            continue

        if re.match(r"^##\s*自由补充部分\s*$", line):
            close_question()
            in_free_notes = True
            current_question = {"question": "自由补充部分", "answers": [], "kind": "free_notes"}
            continue

        if current_question is None:
            continue

        if not line.strip() or line.strip() == "***":
            continue

        bullet_match = re.match(r"^\s*-\s*([^:：]+)[:：]\s*(.*)$", line)
        free_match = re.match(r"^\s*([A-Za-z]\d+)[:：]\s*(.*)$", line) if in_free_notes else None
        answer_match = bullet_match or free_match
        if answer_match:
            close_answer()
            current_answer = {
                "id": answer_match.group(1).strip(),
                "text": answer_match.group(2).strip(),
            }
            continue

        if current_answer is not None:
            current_answer["text"] = f"{current_answer.get('text', '')}\n{line.strip()}".strip()

    close_question()

    answer_count = sum(len(question["answers"]) for question in questions)
    dates = [source["date"] for source in sources if source.get("date")]
    latest_response_date = max(dates) if dates else ""
    source_url = f"{COLLEGES_CHAT_BLOB_BASE_URL}{path}" if path else COLLEGES_CHAT_REPO_URL
    page_url = (
        f"{COLLEGES_CHAT_PAGE_BASE_URL}{path[:-3]}/"
        if path.endswith(".md")
        else COLLEGES_CHAT_PAGE_BASE_URL
    )
    return {
        "available": bool(title and questions),
        "status": "ready" if title and questions else "empty",
        "school": title,
        "matched_path": path,
        "question_count": len(questions),
        "answer_count": answer_count,
        "source_count": len(sources),
        "latest_response_date": latest_response_date,
        "last_updated": COLLEGES_CHAT_GENERATED_AT,
        "source_version": COLLEGES_CHAT_SOURCE_VERSION,
        "license": COLLEGES_CHAT_LICENSE,
        "license_url": COLLEGES_CHAT_LICENSE_URL,
        "source_url": source_url,
        "page_url": page_url,
        "sources": sources,
        "questions": questions,
        "disclaimer": "内容来源于网络和问卷收集，仅供参考；重要择校决策请结合学校官方信息复核。",
    }


class CollegesChatService:
    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = cache_dir / "colleges-chat"
        self.index_file = self.cache_dir / "nav-index.json"
        self.page_cache_dir = self.cache_dir / "pages"
        self._index: list[dict[str, Any]] | None = None
        self._index_error = ""

    def resource_card(self) -> dict[str, str]:
        return {
            "title": "CollegesChat 生活质量问卷",
            "status": "按需接入",
            "confidence": "中",
            "description": (
                "来自 CollegesChat/university-information generated 分支，按院校详情页实时读取并本地缓存；"
                f"许可证 {COLLEGES_CHAT_LICENSE}，源版本 {COLLEGES_CHAT_SOURCE_VERSION[:12]}。"
            ),
        }

    def index_summary(self) -> dict[str, Any]:
        index = self._load_index(fetch_remote=False)
        return {
            "source": "CollegesChat/university-information",
            "source_version": COLLEGES_CHAT_SOURCE_VERSION,
            "generated_at": COLLEGES_CHAT_GENERATED_AT,
            "license": COLLEGES_CHAT_LICENSE,
            "license_url": COLLEGES_CHAT_LICENSE_URL,
            "cached_school_count": len(index),
            "index_error": self._index_error,
        }

    def search(self, query: str, limit: int = 20) -> dict[str, Any]:
        normalized_query = normalize_colleges_chat_name(query)
        if not normalized_query:
            return {"query": query, "count": 0, "list": [], **self.index_summary()}
        index = self._load_index(fetch_remote=True)
        exact = [item for item in index if item["normalized"] == normalized_query]
        fuzzy = [
            item
            for item in index
            if item not in exact
            and (
                normalized_query in item["normalized"]
                or item["normalized"] in normalized_query
            )
        ]
        rows = [*exact, *fuzzy][:limit]
        return {"query": query, "count": len(rows), "list": rows, **self.index_summary()}

    def get_school(self, school_name: str) -> dict[str, Any]:
        match = self._match_school(school_name)
        if not match:
            return self._empty_result(
                school_name,
                "not_found",
                "CollegesChat 当前院校索引中没有匹配到该院校。",
            )

        cached = self._read_page_cache(match["path"])
        # 有本地缓存时立即返回，避免每次点院校都同步阻塞等待远程抓取（远程刷新交由后台）
        if cached:
            cached["requested_school"] = school_name
            cached["matched_school"] = match["school"]
            cached["match_type"] = match.get("match_type", "unknown")
            cached["cache_status"] = "cached"
            return cached

        try:
            markdown = _fetch_text(f"{COLLEGES_CHAT_RAW_BASE_URL}{match['path']}")
            parsed = parse_colleges_chat_markdown(markdown, match["path"])
            parsed["requested_school"] = school_name
            parsed["matched_school"] = match["school"]
            parsed["match_type"] = match.get("match_type", "unknown")
            parsed["cache_status"] = "refreshed"
            _write_json(self._page_cache_file(match["path"]), parsed)
            return parsed
        except Exception as exc:
            return self._empty_result(
                school_name,
                "unavailable",
                f"CollegesChat 远程数据暂不可用：{exc}",
            )

    def _empty_result(self, school_name: str, status: str, message: str) -> dict[str, Any]:
        return {
            "available": False,
            "status": status,
            "school": school_name,
            "requested_school": school_name,
            "matched_school": "",
            "matched_path": "",
            "match_type": "none",
            "question_count": 0,
            "answer_count": 0,
            "source_count": 0,
            "latest_response_date": "",
            "last_updated": COLLEGES_CHAT_GENERATED_AT,
            "source_version": COLLEGES_CHAT_SOURCE_VERSION,
            "license": COLLEGES_CHAT_LICENSE,
            "license_url": COLLEGES_CHAT_LICENSE_URL,
            "source_url": COLLEGES_CHAT_REPO_URL,
            "page_url": COLLEGES_CHAT_PAGE_BASE_URL,
            "sources": [],
            "questions": [],
            "message": message,
            "disclaimer": "内容来源于网络和问卷收集，仅供参考；重要择校决策请结合学校官方信息复核。",
        }

    def _load_index(self, fetch_remote: bool) -> list[dict[str, Any]]:
        if self._index is not None:
            return self._index
        cached = _read_json(self.index_file)
        if cached and isinstance(cached.get("items"), list):
            self._index = cached["items"]
            return self._index
        if not fetch_remote:
            self._index = []
            return self._index
        return self._refresh_index()

    def _refresh_index(self) -> list[dict[str, Any]]:
        try:
            nav = _fetch_text(COLLEGES_CHAT_NAV_URL)
            items = parse_colleges_chat_nav(nav, include_archived=False)
            payload = {
                "source": COLLEGES_CHAT_NAV_URL,
                "source_version": COLLEGES_CHAT_SOURCE_VERSION,
                "generated_at": COLLEGES_CHAT_GENERATED_AT,
                "fetched_at": int(time.time()),
                "items": items,
            }
            _write_json(self.index_file, payload)
            self._index = items
            self._index_error = ""
            return items
        except Exception as exc:
            self._index_error = str(exc)
            cached = _read_json(self.index_file)
            if cached and isinstance(cached.get("items"), list):
                self._index = cached["items"]
                return self._index
            self._index = []
            return self._index

    def _match_school(self, school_name: str) -> dict[str, Any] | None:
        normalized = normalize_colleges_chat_name(school_name)
        if not normalized:
            return None
        index = self._load_index(fetch_remote=True)
        for item in index:
            if item["normalized"] == normalized:
                return {**item, "match_type": "exact"}
        candidates = [
            item
            for item in index
            if normalized in item["normalized"] or item["normalized"] in normalized
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda item: (abs(len(item["normalized"]) - len(normalized)), item["school"]))
        return {**candidates[0], "match_type": "contains"}

    def _page_cache_file(self, path: str) -> Path:
        return self.page_cache_dir / _safe_cache_name(path)

    def _read_page_cache(self, path: str) -> dict[str, Any] | None:
        cached = _read_json(self._page_cache_file(path))
        return cached if cached and isinstance(cached, dict) else None


@lru_cache(maxsize=1)
def get_colleges_chat_service(cache_dir: str | Path | None = None) -> CollegesChatService:
    root = Path(cache_dir) if cache_dir is not None else Path(__file__).resolve().parent / ".runtime-cache"
    return CollegesChatService(root)
