"""Attach the official 2026 undergraduate major taxonomy, without eligibility inference."""
from __future__ import annotations

import io
import json
import re
from pathlib import Path

from .data_pipeline import normalize_major
from .public_profiles import _read_cached, _retrieved_at

SOURCE_URL = "https://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/W020260427440749576927.pdf"
PAGE_URL = "https://www.moe.gov.cn/srcsite/A08/moe_1034/s3882/202604/t20260427_1434931.html"
LICENSE = "教育部公开资料，未声明开放许可"


def parse_major_pages(pages: list[str]) -> dict:
    title = re.sub(r"\s+", "", "".join(pages[:2]))
    if "普通高等学校本科专业目录" not in title or "2026" not in title:
        raise ValueError("专业目录年份或标题不符")
    discipline = category = None
    rows = []
    for page_number, text in enumerate(pages, 1):
        for raw in text.splitlines():
            line = raw.strip()
            domain = re.match(r"^(\d{2})\s+学科门类[：:]\s*(.+)$", line)
            group = re.match(r"^(\d{4})\s+(.+)$", line)
            major = re.match(r"^(\d{6,7}(?:TK|T|K)?)\s+(.+)$", line)
            if domain:
                discipline = {"code": domain[1], "name": domain[2]}
                category = None
            elif group:
                category = {"code": group[1], "name": group[2]}
            elif major:
                if not discipline or not major[1].startswith(discipline['code']) or (category and not major[1].startswith(category['code'])):
                    raise ValueError("专业代码与学科类别不一致")
                name, _, note = major[2].partition("（注：")
                rows.append({"code": major[1], "name": name.strip(), "discipline": discipline,
                    "category": category, "degree_note": note.rstrip("）"), "source_page": page_number})
            elif rows and line and not re.match(r"^[—\-\s\d]+$", line) and not line.startswith("附件"):
                # Only a broken parenthetical note may continue on the next line.
                if "（注：" in rows[-1]["name"]:
                    rows[-1]["name"] += line
                elif rows[-1]["degree_note"] and not raw.strip().startswith("说明"):
                    rows[-1]["degree_note"] += line.rstrip("）")
    codes = [row['code'] for row in rows]
    if len(codes) != len(set(codes)):
        raise ValueError("专业目录代码重复")
    return {"year": 2026, "majors": rows}


def attach_major_taxonomy(supplement: dict, forecasts: list[dict], raw_dir: Path, *, offline: bool = False) -> dict:
    path = raw_dir / 'public_profiles/major-catalog/undergraduate-2026.pdf'
    content, metadata = _read_cached(path, SOURCE_URL, offline=offline, year=2026, license_name=LICENSE)
    if not content:
        return {"status": "unavailable", "error": metadata.get('error')}
    import pdfplumber
    with pdfplumber.open(io.BytesIO(content)) as document:
        taxonomy = parse_major_pages([page.extract_text() or '' for page in document.pages])
    if len(taxonomy['majors']) < 800:
        raise ValueError('专业目录解析数量异常，拒绝接入')
    reference = {"year": 2026, "source": "教育部本科专业目录", "source_url": SOURCE_URL,
                 "publication_url": PAGE_URL, "published_at": None, "license": LICENSE,
                 "retrieved_at": _retrieved_at(metadata), "sha256": metadata['sha256'],
                 "scope": "全国本科专业分类；不代表某校开设该专业、学位授予门类或个人报考资格"}
    by_name = {normalize_major(row['name']): row for row in taxonomy['majors']}
    categories = {normalize_major(row['category']['name']): row['category'] for row in taxonomy['majors'] if row['category']}
    matched = group_matched = 0
    for forecast in forecasts:
        key = normalize_major(forecast['major'])
        row = by_name.get(key)
        entry = supplement['programs'][forecast['unit_id']]
        if row:
            entry['major_reference'] = {**row, **reference, "match_method": "exact_normalized_major_name"}
            matched += 1
        elif key in categories:
            entry['major_reference'] = {**categories[key], **reference, "record_type": "major_category",
                                      "match_method": "exact_major_category_name"}
            group_matched += 1
    taxonomy.update(reference)
    (path.parent / 'undergraduate-2026.json').write_text(json.dumps(taxonomy,ensure_ascii=False,indent=2),encoding='utf-8')
    supplement['major_taxonomy'] = taxonomy
    return {"status": "ready", "official_major_count": len(taxonomy['majors']),
            "programs_exact_major_matched": matched, "programs_category_matched": group_matched}
