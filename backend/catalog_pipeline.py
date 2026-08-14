from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import pdfplumber


CATALOG_FILENAME = "{year}_physics_catalog.pdf"
SUBJECT_PATTERN = r"(?:不限|化学(?:\s*生物)?|生物(?:\s*化学)?|思想政治|政治|地理)"
LANGUAGE_PATTERN = r"(?:不限|英语|俄语|日语|法语|德语|西班牙语|其他)"
MAJOR_TAIL = re.compile(
    rf"(?P<subject>{SUBJECT_PATTERN})\s+(?P<plan>\d{{1,4}})\s+(?P<language>{LANGUAGE_PATTERN})(?:\s+[2-9])?(?:\s+(?:\d{{3,6}}|免费|待定))?\s*$"
)
SCHOOL_LINE = re.compile(r"^(?P<code>\d{4})\s+(?P<name>.+?)\s+(?P<total>\d{1,5})$")
MAJOR_START = re.compile(r"^(?P<code>[0-9A-Z]{3})\s+(?P<body>.+)$")


@dataclass(frozen=True)
class CatalogPlan:
    year: int
    school_code: str
    school_name: str
    major_code: str
    major_name: str
    subject_requirement: str
    plan_count: int
    language: str
    source_page: int
    source_column: str


def _clean(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.replace("（", "(").replace("）", ")")
    return re.sub(r"\s+", " ", text).strip()


def _is_noise(line: str) -> bool:
    compact = re.sub(r"\s+", "", line)
    return (
        not compact
        or compact.startswith("代码院校")
        or compact.startswith("贵州省")
        or compact.startswith("元/年")
        or compact.startswith("第") and "页" in compact
        or bool(re.fullmatch(r"\d+\s*/\s*\d+", line))
        or compact in {"本科", "普通类", "本科普通类", "高校专项计划", "国家专项计划", "地方专项计划"}
    )


def _parse_major_buffer(
    year: int,
    school_code: str | None,
    school_name: str,
    major_code: str | None,
    buffer: list[str],
    page_number: int,
    column: str,
) -> CatalogPlan | None:
    if not school_code or not major_code or not buffer:
        return None
    text = _clean(" ".join(buffer))
    text = text.split("[", 1)[0].strip()
    tail = MAJOR_TAIL.search(text)
    if not tail:
        return None
    major_name = text[: tail.start()].strip(" ;；")
    if not major_name:
        return None
    return CatalogPlan(
        year=year,
        school_code=school_code,
        school_name=school_name,
        major_code=major_code,
        major_name=major_name,
        subject_requirement=re.sub(r"\s+", "+", tail.group("subject")),
        plan_count=int(tail.group("plan")),
        language=tail.group("language"),
        source_page=page_number,
        source_column=column,
    )


def extract_catalog(path: Path, year: int) -> tuple[list[CatalogPlan], dict[str, Any]]:
    plans: list[CatalogPlan] = []
    current_school_code: str | None = None
    current_school_name = ""
    current_major_code: str | None = None
    buffer: list[str] = []
    buffer_page = 0
    buffer_column = ""

    def flush() -> None:
        nonlocal current_major_code, buffer
        plan = _parse_major_buffer(
            year,
            current_school_code,
            current_school_name,
            current_major_code,
            buffer,
            buffer_page,
            buffer_column,
        )
        if plan is not None:
            plans.append(plan)
        current_major_code = None
        buffer = []

    with pdfplumber.open(path) as document:
        page_count = len(document.pages)
        for page_number, raw_page in enumerate(document.pages, start=1):
            page = raw_page.dedupe_chars(tolerance=1)
            halves = [
                ("left", page.crop((0, 0, page.width / 2, page.height))),
                ("right", page.crop((page.width / 2, 0, page.width, page.height))),
            ]
            for column, half in halves:
                text = half.extract_text(x_tolerance=2, y_tolerance=3) or ""
                for raw_line in text.splitlines():
                    line = _clean(raw_line)
                    if _is_noise(line):
                        continue
                    school_match = SCHOOL_LINE.match(line)
                    if school_match:
                        flush()
                        current_school_code = school_match.group("code")
                        current_school_name = school_match.group("name")
                        continue
                    major_match = MAJOR_START.match(line)
                    if major_match and current_school_code:
                        flush()
                        current_major_code = major_match.group("code")
                        buffer = [major_match.group("body")]
                        buffer_page = page_number
                        buffer_column = column
                        continue
                    if current_major_code and not line.startswith("["):
                        buffer.append(line)
                        # Most records complete within three visual lines. A
                        # successful tail match can be flushed immediately.
                        if MAJOR_TAIL.search(_clean(" ".join(buffer))):
                            flush()
            # A major record never legitimately spans a physical page.
            flush()
        flush()

    unique: dict[tuple[str, str], CatalogPlan] = {}
    duplicates: dict[tuple[str, str], list[CatalogPlan]] = {}
    for plan in plans:
        key = (plan.school_code, plan.major_code)
        if key in unique and unique[key] != plan:
            duplicates.setdefault(key, [unique[key]]).append(plan)
        else:
            unique[key] = plan
    for key in duplicates:
        unique.pop(key, None)
    rows = sorted(unique.values(), key=lambda item: (item.school_code, item.major_code))
    report = {
        "year": year,
        "source_file": path.name,
        "pages": page_count,
        "parsed_unique_plans": len(rows),
        "ambiguous_duplicate_keys": len(duplicates),
        "school_count": len({row.school_code for row in rows}),
        "plan_total": sum(row.plan_count for row in rows),
    }
    return rows, report


def write_catalog(path: Path, rows: list[CatalogPlan]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = list(CatalogPlan.__dataclass_fields__)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def build_catalogs(raw_dir: Path, output_dir: Path, years: tuple[int, ...] = (2024, 2025, 2026)) -> dict[str, Any]:
    reports = []
    for year in years:
        source = raw_dir / CATALOG_FILENAME.format(year=year)
        rows, report = extract_catalog(source, year)
        write_catalog(output_dir / f"catalog_plans_{year}.csv", rows)
        reports.append(report)
    manifest = {"schema_version": 1, "catalogs": reports}
    (output_dir / "catalog_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Parse official Guizhou physics catalog plan counts")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw/official"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--years", type=int, nargs="+", default=[2024, 2025, 2026])
    args = parser.parse_args()
    manifest = build_catalogs(args.raw_dir, args.output_dir, tuple(args.years))
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
