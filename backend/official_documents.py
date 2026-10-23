"""Verify and attach scoped excerpts from registered university documents."""
from __future__ import annotations

import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from .public_profiles import _read_cached, _retrieved_at

LICENSE = "高校或教育主管平台公开资料，未声明开放许可"
ROOT = Path(__file__).resolve().parents[1]


class DocumentText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []
        self.buffer: list[str] = []
        self.skip = 0

    def flush(self) -> None:
        text = re.sub(r"\s+", " ", "".join(self.buffer)).strip()
        if text:
            self.lines.append(text)
        self.buffer = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in {"script", "style", "noscript", "nav", "footer"}:
            self.skip += 1
        if not self.skip and tag in {"p", "div", "br", "tr", "h1", "h2", "h3", "li"}:
            self.flush()
        if not self.skip and tag in {"td", "th"} and self.buffer:
            self.buffer.append(" | ")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "nav", "footer"}:
            self.skip = max(0, self.skip - 1)
        if not self.skip and tag in {"p", "div", "tr", "h1", "h2", "h3", "li"}:
            self.flush()

    def handle_data(self, text: str) -> None:
        if not self.skip:
            self.buffer.append(text)


def parse_document(content: bytes, record: dict) -> list[str]:
    encoding = "utf-8"
    match = re.search(br'charset\s*=\s*["\']?([\w-]+)', content[:5000], re.I)
    if match:
        encoding = match[1].decode("ascii")
    parser = DocumentText()
    parser.feed(content.decode(encoding, errors="replace"))
    parser.flush()
    lines = list(dict.fromkeys(parser.lines))
    text = re.sub(r"\s+", "", " ".join(lines))
    expected = record.get("expected_phrases") or [record["school"], str(record["year"])]
    if len(text) < 300 or any(re.sub(r"\s+", "", value) not in text for value in expected):
        raise ValueError("正文长度、院校名称或适用年份未通过核验")
    if record["kind"] == "charter" and "招生章程" not in text:
        raise ValueError("正文不是招生章程")
    return lines


def _excerpt(lines: list[str], pattern: str, limit: int = 1100) -> str:
    selected = [line for line in lines if len(line) >= 14 and re.search(pattern, line)]
    kept: list[str] = []
    for line in selected:
        remaining = limit - sum(len(part) for part in kept)
        if remaining < 40:
            break
        kept.append(line if len(line) <= remaining else line[:remaining] + "（本段节选，完整条件见原文）")
    return "\n".join(kept)


def attach_official_documents(profiles: dict, raw_dir: Path, *, offline: bool = False,
                              registry_paths: list[Path] | None = None) -> dict:
    paths = registry_paths or [ROOT / "data/public_policy_registry.json", ROOT / "data/public_policy_extra.json"]
    registry = []
    for path in paths:
        if path.exists():
            value = json.loads(path.read_text(encoding="utf-8"))
            registry.extend(value if isinstance(value, list) else value.get("documents", value.get("sources", [])))
    report: dict = {"registered": len(registry), "verified_documents": 0, "schools": [], "errors": []}
    targets = [record for record in registry if record["school"] in profiles]

    def load(record: dict) -> tuple[dict, list[str] | None, dict]:
        host = urlsplit(record["url"]).hostname or ""
        if not (host.endswith(".edu.cn") or host == "gaokao.chsi.com.cn"):
            return record, None, {"error": "来源域名不在官方资料允许范围"}
        filename = hashlib.sha256(record["url"].encode()).hexdigest()[:20] + ".html"
        content, metadata = _read_cached(raw_dir / "public_profiles/official-policy" / filename,
            record["url"], offline=offline, year=record["year"], license_name=LICENSE)
        if content is None:
            return record, None, metadata
        try:
            return record, parse_document(content, record), metadata
        except (ValueError, LookupError) as exc:
            return record, None, {**metadata, "error": str(exc)}

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(load, targets))
    matched = set()
    for record, lines, metadata in results:
        if not lines:
            report["errors"].append({"school": record["school"], "url": record["url"], "reason": metadata.get("error")})
            continue
        profile = profiles[record["school"]]
        reference = {"source": "高校官网" if urlsplit(record["url"]).hostname.endswith(".edu.cn") else "阳光高考",
            "source_url": record["url"], "year": record["year"], "published_at": record.get("published_at"),
            "retrieved_at": _retrieved_at(metadata), "sha256": metadata.get("sha256"),
            "license": LICENSE, "confidence": "高", "scope": record.get("scope", "仅适用于原文所列年份、培养项目及招生范围；不代表2027年政策")}
        added = 0
        categories = [
            ("basic", "收费标准", r"学费|收费标准|收费项目"),
            ("life", "官方住宿与收费", r"住宿费|宿舍|学生公寓"),
            ("development", "转专业条件", r"转专业|转换专业"),
            ("admission", "报考与培养要求", r"选考科目|外语语种|体检|色盲|色弱|办学地点"),
        ]
        if record["kind"] == "transfer":
            categories = [("development", "转专业条件", r"申请|转入|转出|条件|不得|限制|考核|年级")]
        for section, title, pattern in categories:
            excerpt = _excerpt(lines, pattern)
            if not excerpt:
                continue
            profile["sections"].setdefault(section, []).append({**reference,
                "title": f"{title}（{record['year']}官方原文节选）", "value": excerpt,
                "verify_hint": reference["scope"]})
            added += 1
        if not added:
            report["errors"].append({"school": record["school"], "url": record["url"], "reason": "未提取到可展示的政策正文"})
            continue
        profile["source_summary"].append({**reference, "title": record["title"], "type": reference["source"], "status": "正文、院校及年份核验通过"})
        profile.setdefault("official_documents", []).append({**reference, "title": record["title"], "kind": record["kind"]})
        report["verified_documents"] += 1
        matched.add(record["school"])
    report["schools"] = sorted(matched)
    return report
