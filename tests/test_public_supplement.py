from __future__ import annotations

import csv
from pathlib import Path

from backend.data_pipeline import AdmissionRow
from backend.public_supplement import catalog_match, catalog_name_index


def _record(school: str = "贵州大学", major: str = "人工智能",
            school_code: str = "9999", major_code: str = "501") -> AdmissionRow:
    return AdmissionRow(2026, 1, school_code, school, major_code, major, "一般统考生",
                        None, 1, 500, 60000, 1, "outcome.pdf", "https://example.org/outcome.pdf")


def _catalog_file(path: Path, rows: list[dict[str, str]]) -> Path:
    fields = ["year", "school_code", "school_name", "major_code", "major_name",
              "subject_requirement", "plan_count", "language", "source_page", "source_column", "tuition"]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return path


def _catalog_row(school: str = "贵州大学(贵州贵阳)", major: str = "人工智能",
                 school_code: str = "9999", major_code: str = "520") -> dict[str, str]:
    return {"year": "2026", "school_code": school_code, "school_name": school,
            "major_code": major_code, "major_name": major, "subject_requirement": "化学",
            "plan_count": "4", "language": "不限", "source_page": "12",
            "source_column": "left", "tuition": "4200"}


def test_unique_exact_names_recover_catalog_row_when_codes_differ(tmp_path: Path) -> None:
    index = catalog_name_index(_catalog_file(tmp_path / "catalog.csv", [_catalog_row()]))

    match = catalog_match(_record(), {}, index)

    assert match is not None
    row, method = match
    assert row["major_code"] == "520"
    assert row["source_page"] == "12"
    assert method == "unique_normalized_school_and_major_name"


def test_exact_name_match_rejects_duplicate_program_names(tmp_path: Path) -> None:
    rows = [_catalog_row(major_code="520"), _catalog_row(major_code="521")]
    index = catalog_name_index(_catalog_file(tmp_path / "catalog.csv", rows))

    assert catalog_match(_record(), {}, index) is None


def test_exact_name_match_preserves_campus_identity(tmp_path: Path) -> None:
    row = _catalog_row(school="中国地质大学（北京校区）", school_code="1000")
    index = catalog_name_index(_catalog_file(tmp_path / "catalog.csv", [row]))

    assert catalog_match(_record("中国地质大学"), {}, index) is None


def test_matching_codes_require_school_and_major_agreement() -> None:
    record = _record()
    row = _catalog_row(school="另一所大学", school_code=record.school_code,
                       major_code=record.major_code)

    assert catalog_match(record, {(record.school_code, record.major_code): row}) is None

