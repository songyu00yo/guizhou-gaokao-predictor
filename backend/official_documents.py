"""Verify and attach scoped excerpts from registered university documents."""
from __future__ import annotations

import hashlib
import io
import unicodedata
import json
import re
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from .public_profiles import _read_cached, _retrieved_at
from .data_pipeline import normalize_major, normalize_school

LICENSE = "高校或教育主管平台公开资料，未声明开放许可"
ROOT = Path(__file__).resolve().parents[1]


class DocumentText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []
        self.buffer: list[str] = []
        self.skip = 0
        self.row_depth = 0

    def flush(self) -> None:
        text = re.sub(r"\s+", " ", "".join(self.buffer)).strip()
        if text:
            self.lines.append(text)
        self.buffer = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in {"script", "style", "noscript", "nav", "footer"}:
            self.skip += 1
        if not self.skip and tag == "tr":
            self.flush()
            self.row_depth += 1
        elif not self.skip and tag in {"p", "div", "br", "h1", "h2", "h3", "li"}:
            if not self.row_depth:
                self.flush()
            else:
                self.buffer.append(" ")
        if not self.skip and tag in {"td", "th"} and self.buffer:
            self.buffer.append(" | ")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "nav", "footer"}:
            self.skip = max(0, self.skip - 1)
        if not self.skip and tag == "tr":
            self.flush()
            self.row_depth = max(0, self.row_depth - 1)
        elif not self.skip and not self.row_depth and tag in {"p", "div", "h1", "h2", "h3", "li"}:
            self.flush()

    def handle_data(self, text: str) -> None:
        if not self.skip:
            self.buffer.append(text)


def parse_document(content: bytes, record: dict) -> list[str]:
    if content.startswith(b"%PDF"):
        import pdfplumber
        with pdfplumber.open(io.BytesIO(content)) as document:
            lines = [line.strip() for page in document.pages for line in (page.extract_text() or "").splitlines() if line.strip()]
        if len("".join(lines)) < 300 and record.get("verified_transcript_path"):
            transcript_path = (ROOT / record["verified_transcript_path"]).resolve()
            if not transcript_path.is_relative_to((ROOT / "data/collections/verified").resolve()):
                raise ValueError("人工复核转录路径无效")
            transcript_bytes = transcript_path.read_bytes()
            transcript = json.loads(transcript_bytes)
            if (transcript.get("source_sha256") != hashlib.sha256(content).hexdigest()
                    or record.get("verified_transcript_sha256") != hashlib.sha256(transcript_bytes).hexdigest()):
                raise ValueError("人工复核转录与原PDF校验值不符")
            lines = [line for page in transcript["pages"] for line in page["lines"]]
    else:
        encoding = "utf-8"
        match = re.search(br'charset\s*=\s*["\']?([\w-]+)', content[:5000], re.I)
        if match:
            encoding = match[1].decode("ascii")
        parser = DocumentText()
        parser.feed(content.decode(encoding, errors="replace"))
        parser.flush()
        lines = list(dict.fromkeys(parser.lines))
    text = re.sub(r"\s+", "", unicodedata.normalize("NFKC", " ".join(lines)))
    expected = [record["school"], str(record["year"]), *(record.get("expected_phrases") or [])]
    if len(text) < 300 or any(re.sub(r"\s+", "", unicodedata.normalize("NFKC", value)) not in text for value in expected):
        raise ValueError("正文长度、院校名称或适用年份未通过核验")
    if record["kind"] == "charter" and "招生章程" not in text:
        raise ValueError("正文不是招生章程")
    return lines


def _excerpt(lines: list[str], pattern: str, limit: int = 1100) -> str:
    selected = [line for line in lines if len(line) >= 24 and re.search(pattern, line)]
    kept: list[str] = []
    for line in selected:
        remaining = limit - sum(len(part) for part in kept)
        if remaining < 40:
            break
        kept.append(line if len(line) <= remaining else line[:remaining] + "（本段节选，完整条件见原文）")
    return "\n".join(kept)


def attach_official_documents(profiles: dict, raw_dir: Path, *, offline: bool = False,
                              registry_paths: list[Path] | None = None) -> dict:
    paths = registry_paths or [ROOT / "data/public_policy_registry.json", ROOT / "data/public_policy_extra.json", *sorted((ROOT / "data/collections").glob("*.json"))]
    registry = []
    for path in paths:
        if path.exists():
            value = json.loads(path.read_text(encoding="utf-8"))
            registry.extend(value if isinstance(value, list) else value.get("documents", value.get("sources", [])))
    registry = list({(r["school"], r["year"], r["url"]): r for r in registry}.values())
    report: dict = {"registered": len(registry), "verified_documents": 0, "schools": [], "errors": []}
    targets = [record for record in registry if record["school"] in profiles]

    def load(record: dict) -> tuple[dict, list[str] | None, dict]:
        host = urlsplit(record["url"]).hostname or ""
        if not (host.endswith(".edu.cn") or host.endswith(".gov.cn") or host == "gaokao.chsi.com.cn"):
            return record, None, {"error": "来源域名不在官方资料允许范围"}
        filename = hashlib.sha256(record["url"].encode()).hexdigest()[:20] + ".html"
        cache_path = raw_dir / "public_profiles/official-policy" / filename
        if record.get("cache_path"):
            candidate = (ROOT / record["cache_path"]).resolve()
            if not candidate.is_relative_to((ROOT / "data/raw").resolve()):
                return record, None, {"error": "原始缓存路径不在data/raw目录"}
            cache_path = candidate
        content, metadata = _read_cached(cache_path,
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
        reference = {"source": "高校官网" if urlsplit(record["url"]).hostname.endswith(".edu.cn") else ("阳光高考" if urlsplit(record["url"]).hostname == "gaokao.chsi.com.cn" else "政府转载"),
            "source_url": record["url"], "year": record["year"], "published_at": record.get("published_at"),
            "retrieved_at": metadata.get("retrieved_at") or _retrieved_at(metadata), "sha256": metadata.get("sha256"),
            "license": LICENSE, "confidence": "高", "scope": record.get("scope", "仅适用于原文所列年份、培养项目及招生范围；不代表2027年政策")}
        if record["year"] == 2026 and record["kind"] == "charter":
            declared_natures = set()
            for line in lines:
                for declaration in re.findall(r"(?:办学性质|办学类型|学校性质|办学属性)\s*[：:]\s*([^。；;\n]{0,50})", line):
                    declared_natures.update(re.findall(r"公办|民办", declaration))
            if len(declared_natures) == 1:
                nature = declared_natures.pop()
                profile.setdefault("headline", {})["ownership"] = nature
                profile["ownership_reference"] = {**reference, "value": nature,
                    "match_method": "explicit_label_in_verified_2026_charter"}
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
        verified_fees = []
        for fee in record.get("fees_rows", []):
            major = str(fee.get("major") or "")
            amount = str(fee.get("tuition") or "").strip()
            unit = str(fee.get("unit") or "")
            currency = str(fee.get("currency") or "")
            scope = str(fee.get("scope") or "")
            if (not major or not re.fullmatch(r"\d{3,6}|免费", amount)
                    or currency not in {"CNY", "人民币", "元"}
                    or re.search(r"留学生|国际学生|研究生|专升本|成人|非学历|学分", scope + unit)
                    or ("合作" in scope and "合作" not in major)
                    or not re.search(r"学年|/年|每年|·年", unit)):
                continue
            matching_clause = None
            for line in lines:
                for clause in re.split(r"[；;。]", line):
                    normalized = re.sub(r"\s+", "", unicodedata.normalize("NFKC", clause))
                    major_pattern = (r"(?<![\u4e00-\u9fffA-Za-z0-9])" + re.escape(normalize_school(major))
                                     + r"(?![\u4e00-\u9fffA-Za-z0-9(])")
                    if (re.search(major_pattern, normalized)
                            and re.search(r"(?<!\d)" + re.escape(amount) + r"(?!\d)", normalized)):
                        matching_clause = clause
                        break
                if matching_clause:
                    break
            if matching_clause:
                verified_fees.append({**fee, "tuition": amount, "evidence_text": matching_clause,
                                      "verification": "explicit_major_and_amount_in_same_source_clause"})
        if not added and verified_fees:
            profile["sections"].setdefault("basic", []).append({**reference,
                "title": f"逐专业学费表（{record['year']}官方资料）",
                "value": "；".join(f"{row['major']}：{row['tuition']}{row['unit']}" for row in verified_fees[:20])
                    + f"。已核验{len(verified_fees)}条具名专业收费，完整表格见来源。",
                "verify_hint": reference["scope"]})
            added += 1
        if not added:
            report["errors"].append({"school": record["school"], "url": record["url"], "reason": "未提取到可展示的政策正文"})
            continue
        profile["source_summary"].append({**reference, "title": record["title"], "type": reference["source"], "status": "正文、院校及年份核验通过"})
        profile.setdefault("official_documents", []).append({**reference, "title": record["title"],
            "kind": record["kind"], "tuition_rows": verified_fees})
        report["verified_documents"] += 1
        matched.add(record["school"])
    report["schools"] = sorted(matched)
    return report


def attach_verified_tuitions(supplement: dict, forecasts: list[dict]) -> dict:
    """Use only explicit, annual, exact-major fees verified against full documents."""
    by_name: dict[tuple[str, str], list[dict]] = {}
    for item in forecasts:
        by_name.setdefault((normalize_school(item["school"]), normalize_major(item["major"])), []).append(item)
    report = {"matched": 0, "filled": 0, "conflicts": [], "unmatched": []}
    for school, profile in supplement["schools"].items():
        for doc in profile.get("official_documents", []):
            if doc["year"] != 2026:
                continue
            for fee in doc.get("tuition_rows", []):
                candidates = by_name.get((normalize_school(school), normalize_major(fee["major"])), [])
                if len(candidates) != 1:
                    report["unmatched"].append({"school": school, "major": fee["major"], "reason": "招生专业名称未精确唯一匹配"})
                    continue
                entry = supplement["programs"][candidates[0]["unit_id"]]
                if entry.get("tuition") and str(entry["tuition"]) != fee["tuition"]:
                    report["conflicts"].append({"school": school, "major": fee["major"], "catalog": entry["tuition"],
                                               "official_document": fee["tuition"], "url": doc["source_url"]})
                    continue
                report["matched"] += 1
                if not entry.get("tuition"):
                    entry["tuition"] = fee["tuition"]
                    entry["missing_fields"] = [field for field in entry.get("missing_fields", []) if field != "tuition"]
                    report["filled"] += 1
                entry["tuition_reference"] = {**fee, "source_url": doc["source_url"], "year": doc["year"],
                                             "sha256": doc["sha256"], "scope": fee.get("scope") or doc["scope"],
                                             "document_scope": doc["scope"]}
    supplement["coverage"]["programs_with_tuition"] = sum(bool(row.get("tuition")) for row in supplement["programs"].values())
    return report
