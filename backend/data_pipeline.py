from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import unicodedata
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable

import pdfplumber


OFFICIAL_OUTCOME_SOURCES = {
    2024: "https://iip.oss-cn-guiyang-gzdata-d01-a.res.gzdata.com.cn/2024/07/23/W02024072315392024%E5%B9%B47%E6%9C%8823%E6%97%A5%E8%B4%B5%E5%B7%9E%E7%9C%81%E6%99%AE%E9%80%9A%E9%AB%98%E6%A0%A1%E6%8B%9B%E7%94%9F%E4%BF%A1%E6%81%AF%E8%A1%A8%EF%BC%88%E6%99%AE%E9%80%9A%E7%B1%BB%E6%9C%AC%E7%A7%91%E6%89%B9%E2%80%94%E7%89%A9%E7%90%86%E7%BB%84%E5%90%88%EF%BC%89.pdf",
    2025: "https://zsksy.guizhou.gov.cn/ygpt/tdqk/202507/P020250722698227709890.pdf",
    2026: "https://zsksy.guizhou.gov.cn/ygpt/tdqk/202607/P020260722030944314487.pdf",
}

OUTCOME_FILENAME = "{year}_physics_undergraduate_first投档.pdf"
CSV_FIELDS = [
    "year",
    "serial",
    "school_code",
    "school_name",
    "major_code",
    "major_name",
    "admission_type",
    "plan_count",
    "admitted_count",
    "min_score",
    "min_rank",
    "source_page",
    "source_file",
    "source_url",
]


@dataclass(frozen=True)
class AdmissionRow:
    year: int
    serial: int
    school_code: str
    school_name: str
    major_code: str
    major_name: str
    admission_type: str
    plan_count: int | None
    admitted_count: int
    min_score: int
    min_rank: int
    source_page: int
    source_file: str
    source_url: str

    @property
    def school_key(self) -> str:
        return normalize_school(self.school_name)

    @property
    def major_key(self) -> str:
        return normalize_major(self.major_name)

    @property
    def admission_type_key(self) -> str:
        return normalize_text(self.admission_type)


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"\s+", "", text).strip()


def normalize_school(value: Any) -> str:
    text = normalize_text(value)
    text = text.replace("（", "(").replace("）", ")")
    return text


def normalize_major(value: Any) -> str:
    text = normalize_text(value)
    text = text.replace("（", "(").replace("）", ")")
    # Annual tables inconsistently append these teaching-form labels. They do
    # not represent a different admission unit, unlike cooperation/campus tags.
    text = re.sub(r"\((?:师范类|师范|非师范|普通类)\)", "", text)
    text = text.replace("专业(类)", "专业类")
    return text


def _clean_cell(value: Any) -> str:
    return normalize_text(value).replace("—", "-").replace("–", "-")


def _code(value: Any, width: int) -> str:
    raw = re.sub(r"[^0-9A-Za-z]", "", normalize_text(value))
    if raw.isdigit() and len(raw) < width:
        return raw.zfill(width)
    return raw.upper()


def _integer(value: Any) -> int | None:
    raw = normalize_text(value).replace(",", "")
    if not re.fullmatch(r"\d+(?:\.0+)?", raw):
        return None
    number = int(float(raw))
    return number if number >= 0 else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _parse_table_row(year: int, cells: list[Any], page_number: int, source_file: Path) -> AdmissionRow | None:
    cleaned = [_clean_cell(cell) for cell in cells]
    if len(cleaned) < 9:
        return None
    serial = _integer(cleaned[0])
    school_code = _code(cleaned[1], 4)
    major_code = _code(cleaned[3], 3)
    if serial is None or not re.fullmatch(r"\d{4}", school_code) or not re.fullmatch(r"[0-9A-Z]{3}", major_code):
        return None

    school_name = cleaned[2]
    major_name = cleaned[4]
    admission_type = cleaned[5]
    if not school_name or not major_name or not admission_type:
        return None

    if year == 2025 and len(cleaned) >= 10:
        plan_count = _integer(cleaned[-4])
        admitted_count = _integer(cleaned[-3])
        min_score = _integer(cleaned[-2])
        min_rank = _integer(cleaned[-1])
    else:
        plan_count = None
        admitted_count = _integer(cleaned[-3])
        min_score = _integer(cleaned[-2])
        min_rank = _integer(cleaned[-1])

    if admitted_count is None or min_score is None or min_rank is None:
        return None
    if not (0 <= min_score <= 750 and min_rank >= 1):
        return None

    return AdmissionRow(
        year=year,
        serial=serial,
        school_code=school_code,
        school_name=school_name,
        major_code=major_code,
        major_name=major_name,
        admission_type=admission_type,
        plan_count=plan_count,
        admitted_count=admitted_count,
        min_score=min_score,
        min_rank=min_rank,
        source_page=page_number,
        source_file=source_file.name,
        source_url=OFFICIAL_OUTCOME_SOURCES[year],
    )


def extract_outcome_pdf(path: Path, year: int) -> tuple[list[AdmissionRow], dict[str, Any]]:
    rows_by_serial: dict[int, AdmissionRow] = {}
    raw_candidate_rows = 0
    table_count = 0
    with pdfplumber.open(path) as document:
        page_count = len(document.pages)
        for page_number, page in enumerate(document.pages, start=1):
            tables = page.extract_tables() or []
            table_count += len(tables)
            for table in tables:
                for cells in table:
                    if cells and _integer(cells[0]) is not None:
                        raw_candidate_rows += 1
                    parsed = _parse_table_row(year, cells, page_number, path)
                    if parsed is not None:
                        rows_by_serial[parsed.serial] = parsed

    rows = [rows_by_serial[key] for key in sorted(rows_by_serial)]
    serials = [row.serial for row in rows]
    report = {
        "year": year,
        "source_file": path.name,
        "source_url": OFFICIAL_OUTCOME_SOURCES[year],
        "sha256": _sha256(path),
        "bytes": path.stat().st_size,
        "pages": page_count,
        "tables": table_count,
        "raw_candidate_rows": raw_candidate_rows,
        "parsed_rows": len(rows),
        "parse_rate": round(len(rows) / max(raw_candidate_rows, 1), 6),
        "serial_min": min(serials) if serials else None,
        "serial_max": max(serials) if serials else None,
        "serial_gaps": (max(serials) - min(serials) + 1 - len(serials)) if serials else None,
        "school_count": len({row.school_key for row in rows}),
        "general_exam_rows": sum("一般统考" in row.admission_type for row in rows),
        "rank_min": min((row.min_rank for row in rows), default=None),
        "rank_max": max((row.min_rank for row in rows), default=None),
    }
    return rows, report


def write_rows(path: Path, rows: Iterable[AdmissionRow]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def read_rows(path: Path) -> list[AdmissionRow]:
    rows: list[AdmissionRow] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for raw in csv.DictReader(handle):
            rows.append(
                AdmissionRow(
                    year=int(raw["year"]),
                    serial=int(raw["serial"]),
                    school_code=raw["school_code"],
                    school_name=raw["school_name"],
                    major_code=raw["major_code"],
                    major_name=raw["major_name"],
                    admission_type=raw["admission_type"],
                    plan_count=int(raw["plan_count"]) if raw.get("plan_count") else None,
                    admitted_count=int(raw["admitted_count"]),
                    min_score=int(raw["min_score"]),
                    min_rank=int(raw["min_rank"]),
                    source_page=int(raw["source_page"]),
                    source_file=raw["source_file"],
                    source_url=raw["source_url"],
                )
            )
    return rows


def match_years(previous: Iterable[AdmissionRow], current: Iterable[AdmissionRow]) -> list[dict[str, Any]]:
    previous_rows = list(previous)
    current_rows = list(current)
    exact_index: dict[tuple[str, str, str], list[AdmissionRow]] = {}
    school_index: dict[tuple[str, str], list[AdmissionRow]] = {}
    for row in previous_rows:
        exact_index.setdefault((row.school_key, row.major_key, row.admission_type_key), []).append(row)
        school_index.setdefault((row.school_key, row.admission_type_key), []).append(row)

    matches: list[dict[str, Any]] = []
    used_previous: set[int] = set()
    for current_row in current_rows:
        exact = exact_index.get((current_row.school_key, current_row.major_key, current_row.admission_type_key), [])
        available_exact = [row for row in exact if row.serial not in used_previous]
        previous_row: AdmissionRow | None = None
        match_type = ""
        confidence = 0.0
        if len(available_exact) == 1:
            previous_row = available_exact[0]
            match_type = "exact_name"
            confidence = 1.0
        elif available_exact:
            same_code = [row for row in available_exact if row.major_code == current_row.major_code]
            if len(same_code) == 1:
                previous_row = same_code[0]
                match_type = "exact_name_code_tiebreak"
                confidence = 0.99

        if previous_row is None:
            candidates = [
                row
                for row in school_index.get((current_row.school_key, current_row.admission_type_key), [])
                if row.serial not in used_previous
            ]
            scored = []
            for candidate in candidates:
                score = SequenceMatcher(None, candidate.major_key, current_row.major_key).ratio()
                if candidate.major_code == current_row.major_code:
                    score = min(1.0, score + 0.025)
                scored.append((score, candidate))
            scored.sort(key=lambda item: item[0], reverse=True)
            if scored:
                best_score, best_row = scored[0]
                runner_up = scored[1][0] if len(scored) > 1 else 0.0
                if best_score >= 0.90 and best_score - runner_up >= 0.06:
                    previous_row = best_row
                    match_type = "high_confidence_fuzzy"
                    confidence = round(best_score, 4)

        if previous_row is None:
            continue
        used_previous.add(previous_row.serial)
        matches.append(
            {
                "previous": previous_row,
                "current": current_row,
                "match_type": match_type,
                "match_confidence": confidence,
            }
        )
    return matches


def build_official_dataset(raw_dir: Path, output_dir: Path, years: Iterable[int] = (2024, 2025, 2026)) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    all_rows: list[AdmissionRow] = []
    reports: list[dict[str, Any]] = []
    by_year: dict[int, list[AdmissionRow]] = {}
    for year in years:
        source = raw_dir / OUTCOME_FILENAME.format(year=year)
        if not source.exists():
            raise FileNotFoundError(f"Missing official outcome PDF: {source}")
        rows, report = extract_outcome_pdf(source, year)
        if len(rows) < 5_000 or report["parse_rate"] < 0.97:
            raise RuntimeError(f"Official PDF validation failed for {year}: {report}")
        by_year[year] = rows
        all_rows.extend(rows)
        reports.append(report)
        write_rows(output_dir / f"admissions_{year}.csv", rows)

    write_rows(output_dir / "admissions_all.csv", all_rows)
    transition_reports: list[dict[str, Any]] = []
    ordered_years = sorted(by_year)
    for previous_year, current_year in zip(ordered_years, ordered_years[1:]):
        previous_general = [row for row in by_year[previous_year] if "一般统考" in row.admission_type]
        current_general = [row for row in by_year[current_year] if "一般统考" in row.admission_type]
        matches = match_years(previous_general, current_general)
        transition_reports.append(
            {
                "previous_year": previous_year,
                "current_year": current_year,
                "previous_rows": len(previous_general),
                "current_rows": len(current_general),
                "matched_rows": len(matches),
                "current_match_rate": round(len(matches) / max(len(current_general), 1), 6),
                "exact_matches": sum(item["match_type"].startswith("exact") for item in matches),
                "fuzzy_matches": sum(item["match_type"] == "high_confidence_fuzzy" for item in matches),
            }
        )

    manifest = {
        "schema_version": 1,
        "scope": "贵州省普通类本科批首选物理首次投档",
        "years": reports,
        "transitions": transition_reports,
        "total_rows": len(all_rows),
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Parse and validate official Guizhou admission PDFs")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw/official"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/processed"))
    args = parser.parse_args()
    manifest = build_official_dataset(args.raw_dir, args.output_dir)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
