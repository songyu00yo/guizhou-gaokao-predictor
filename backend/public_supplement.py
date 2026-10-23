"""Build runtime-only history and catalog records from verified public files."""
from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .data_pipeline import AdmissionRow, normalize_major, normalize_school, read_rows

CORRECTION_URL = "https://zsksy.guizhou.gov.cn/tzgg/202606/t20260626_90560100.html"
_LOCATION_SUFFIX = re.compile(
    r"\((?P<location>(?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|内蒙古)[^()]+)\)?$"
)
_SCHOOL_IDENTITY_QUALIFIER = re.compile(r"(?:校区|分校|院区|中外合作|合作办学|联合培养)")


def apply_catalog_notice(record: AdmissionRow, catalog: dict[str, str]) -> dict[str, str]:
    """Apply only the explicitly named records of the 2026-06-26 official notice."""
    result = dict(catalog)
    if record.year != 2026:
        return result
    free = {"501": "数学与应用数学", "502": "物理学", "503": "化学", "504": "生物科学"}
    if (record.school_code == "0751" and record.school_key == "贵州师范学院"
            and record.major_code in free and normalize_major(free[record.major_code]) == record.major_key):
        result.update(tuition="免费", correction_url=CORRECTION_URL)
    return result


def unique_history(rows: list[AdmissionRow], school: str, major: str, major_code: str,
                   admission_type: str = "一般统考生") -> AdmissionRow | None:
    candidates = [r for r in rows if r.school_key == normalize_school(school)
                  and r.major_key == normalize_major(major) and r.admission_type == admission_type]
    if len(candidates) == 1:
        return candidates[0]
    # Multiple sections can reuse a name; only a unique agreeing major code resolves it.
    same_code = [r for r in candidates if r.major_code == major_code]
    return same_code[0] if len(same_code) == 1 else None


def catalog_index(path: Path) -> dict[tuple[str, str], dict[str, str]]:
    if not path.exists():
        return {}
    grouped: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            grouped[(row["school_code"], row["major_code"])].append(row)
    return {key: values[0] for key, values in grouped.items() if len(values) == 1}


def catalog_name_index(path: Path) -> dict[tuple[str, str], dict[str, str]]:
    """Index only unique exact school/major names, preserving campus qualifiers."""
    if not path.exists():
        return {}
    grouped: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            # The catalog appends a province/city locator to school headings.
            # Strip only that known suffix; parentheses identifying campuses,
            # cooperation programs, or institutional branches remain significant.
            school = _catalog_school_key(row["school_name"])
            grouped[(school, normalize_major(row["major_name"]))].append(row)
    return {key: values[0] for key, values in grouped.items() if len(values) == 1}


def _catalog_name_agrees(record: AdmissionRow, row: dict[str, str]) -> bool:
    # Catalog headings append a province/city location. Remove only that suffix;
    # retain institutional qualifiers such as (北京), (珠海校区), and (中外合作).
    catalog_school = _catalog_school_key(row["school_name"])
    school_agrees = record.school_key == catalog_school
    if not school_agrees and record.school_code == row.get("school_code"):
        # Province-only locators (北京/上海/天津/重庆) cannot be stripped
        # globally: (北京) may identify a real campus. Matching source codes
        # plus the complete institution name makes this narrow case explicit.
        school_agrees = normalize_school(row["school_name"]) in {
            record.school_key + f"({location})" for location in ("北京", "天津", "上海", "重庆")
        }
    return school_agrees and record.major_key == normalize_major(row["major_name"])


def _catalog_school_key(value: str) -> str:
    school = normalize_school(value)
    match = _LOCATION_SUFFIX.search(school)
    if match and not _SCHOOL_IDENTITY_QUALIFIER.search(match.group("location")):
        return school[:match.start()]
    return school


def catalog_match(record: AdmissionRow, code_index: dict, name_index: dict | None = None
                  ) -> tuple[dict[str, str], str] | None:
    """Match by source codes first, then by a unique exact normalized name pair."""
    row = code_index.get((record.school_code, record.major_code))
    if row and _catalog_name_agrees(record, row):
        return row, "school_code_and_major_code"
    if name_index is not None:
        row = name_index.get((record.school_key, record.major_key))
        if row and _catalog_name_agrees(record, row):
            return row, "unique_normalized_school_and_major_name"
    return None


def agreeing_catalog(record: AdmissionRow, index: dict, name_index: dict | None = None
                     ) -> dict[str, str] | None:
    """Compatibility helper returning a matched catalog row without provenance."""
    match = catalog_match(record, index, name_index)
    return match[0] if match else None


def build_supplement(processed_dir: Path, forecasts: list[dict], profiles: dict,
                     sources: list[dict], gaps: list[dict]) -> dict[str, Any]:
    yearly = {year: read_rows(processed_dir / f"admissions_{year}.csv") for year in (2024, 2025, 2026)}
    indexes = {}
    for year, rows in yearly.items():
        grouped = defaultdict(list)
        for row in rows:
            grouped[(row.school_key, row.major_key, row.admission_type)].append(row)
        indexes[year] = grouped
    catalogs = {
        y: (catalog_index(processed_dir / f"catalog_plans_{y}.csv"),
            catalog_name_index(processed_dir / f"catalog_plans_{y}.csv"))
        for y in (2024, 2025, 2026)
    }
    catalog_source_urls = {int(source["year"]): source["url"] for source in sources
                           if source.get("kind") == "catalog" and source.get("year") and source.get("url")}
    programs = {}
    for item in forecasts:
        entry: dict[str, Any] = {}
        for year in (2024, 2025, 2026):
            candidates = indexes[year].get((normalize_school(item["school"]), normalize_major(item["major"]),
                                            item.get("admission_type", "一般统考生")), [])
            record = unique_history(candidates, item["school"], item["major"], item["major_code"],
                                    item.get("admission_type", "一般统考生"))
            if record is None:
                entry[f"history_{year}"] = None
                continue
            history = asdict(record)
            catalog_match_result = catalog_match(record, *catalogs[year]) if year in catalogs else None
            catalog, catalog_match_method = catalog_match_result if catalog_match_result else (None, None)
            if catalog:
                catalog = apply_catalog_notice(record, catalog)
            history["plan_count"] = int(catalog["plan_count"]) if catalog else record.plan_count
            history["match_method"] = ("unique_normalized_school_major_and_admission_type" if len(candidates) == 1
                                       else "normalized_name_with_unique_major_code_tiebreak")
            if catalog:
                history["catalog_source_page"] = int(catalog["source_page"])
                history["catalog_match_method"] = catalog_match_method
                history["catalog_school_code"] = catalog["school_code"]
                history["catalog_major_code"] = catalog["major_code"]
                if year in catalog_source_urls:
                    history["catalog_source_url"] = catalog_source_urls[year]
            entry[f"history_{year}"] = history
            if year == 2026 and catalog:
                entry.update(tuition=catalog.get("tuition") or None,
                             subject_requirement=catalog["subject_requirement"],
                             language=catalog["language"], catalog_year=2026,
                             catalog_source_page=int(catalog["source_page"]),
                             catalog_match_method=catalog_match_method,
                             catalog_school_code=catalog["school_code"],
                             catalog_major_code=catalog["major_code"])
                if 2026 in catalog_source_urls:
                    entry["catalog_source_url"] = catalog_source_urls[2026]
                if catalog.get("correction_url"):
                    entry["correction_url"] = catalog["correction_url"]
        entry["missing_fields"] = [key for key in ("history_2024", "history_2025", "history_2026", "tuition",
                                                   "subject_requirement") if not entry.get(key)]
        programs[item["unit_id"]] = entry
    coverage = {
        "schools_total": len({x["school"] for x in forecasts}),
        "schools_with_basic": sum(bool(p.get("headline", {}).get("city")) for p in profiles.values()),
        "schools_with_life": sum(bool(p.get("sections", {}).get("life")) for p in profiles.values()),
        "schools_with_official_site": sum(bool(p.get("official", {}).get("official_site")) for p in profiles.values()),
        "programs_total": len(programs),
        **{f"programs_with_history_{y}": sum(bool(p.get(f"history_{y}")) for p in programs.values())
           for y in (2024, 2025, 2026)},
        "programs_with_tuition": sum(bool(p.get("tuition")) for p in programs.values()),
        "programs_with_subject_requirement": sum(bool(p.get("subject_requirement")) for p in programs.values()),
        "programs_with_catalog_plan_count_2026": sum(
            bool(p.get("history_2026") and p["history_2026"].get("catalog_match_method")
                 and p["history_2026"].get("plan_count") is not None)
            for p in programs.values()),
        "programs_with_catalog_code_match": sum(p.get("catalog_match_method") == "school_code_and_major_code"
                                                for p in programs.values()),
        "programs_with_catalog_name_match": sum(
            p.get("catalog_match_method") == "unique_normalized_school_and_major_name"
            for p in programs.values()),
        "source_files": len(sources),
    }
    return {"schema_version": 1, "programs": programs, "schools": profiles,
            "catalog_notices": [{"url": CORRECTION_URL, "published_at": "2026-06-26",
                "changes": ["贵州师范学院指定专业学费免费", "吉林工程技术师范学院505专业师范类改普通类",
                            "陕西师范大学指定专业补国家公费师范生（国家专项计划）备注"],
                "scope": "仅精确匹配的专业应用；提前批或非当前候选专业不并入普通本科预测"}],
            "coverage": coverage, "sources": sources, "gaps": gaps}


def write_supplement(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
