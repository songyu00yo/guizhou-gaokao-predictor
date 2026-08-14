from __future__ import annotations

from pathlib import Path
import json
import shutil

import numpy as np

from backend.backtest import metrics, transition_frame
from backend.data_pipeline import AdmissionRow, _parse_table_row, match_years, normalize_major
from backend.runtime_store import RuntimeStore


def make_row(year: int, serial: int, school: str, major: str, rank: int) -> AdmissionRow:
    return AdmissionRow(
        year=year,
        serial=serial,
        school_code="0001",
        school_name=school,
        major_code="501",
        major_name=major,
        admission_type="一般统考生",
        plan_count=2,
        admitted_count=2,
        min_score=500,
        min_rank=rank,
        source_page=1,
        source_file=f"{year}.pdf",
        source_url="https://example.invalid",
    )


def test_parse_each_official_outcome_layout() -> None:
    source = Path("official.pdf")
    row_2024 = _parse_table_row(
        2024,
        ["1", "0001", "阿坝师范学院", "501", "数学与应用数学", "一般统考生", "1", "579", "14307"],
        1,
        source,
    )
    row_2025 = _parse_table_row(
        2025,
        ["1", "0001", "阿坝师范学院", "501", "数学与应用数学", "一般统考生", "1", "1", "513", "43548"],
        1,
        source,
    )
    row_2026 = _parse_table_row(
        2026,
        ["1", "0001", "阿坝师范学院", "501", "数学与应用数学(师范类)", "一般统考生", "1", "523", "45832"],
        1,
        source,
    )
    assert row_2024 and row_2024.plan_count is None and row_2024.min_rank == 14307
    assert row_2025 and row_2025.plan_count == 1 and row_2025.admitted_count == 1
    assert row_2026 and row_2026.min_score == 523 and row_2026.min_rank == 45832


def test_teacher_label_does_not_break_cross_year_match() -> None:
    previous = [make_row(2025, 1, "阿坝师范学院", "数学与应用数学", 43548)]
    current = [make_row(2026, 1, "阿坝师范学院", "数学与应用数学(师范类)", 45832)]
    assert normalize_major(previous[0].major_name) == normalize_major(current[0].major_name)
    matches = match_years(previous, current)
    assert len(matches) == 1
    assert matches[0]["match_type"] == "exact_name"


def test_transition_features_only_use_lag_and_static_target_identity() -> None:
    previous = [
        make_row(2025, 1, "甲大学", "计算机科学与技术", 20000),
        make_row(2025, 2, "甲大学", "数学与应用数学", 30000),
    ]
    current = [
        make_row(2026, 1, "甲大学", "计算机科学与技术", 18000),
        make_row(2026, 2, "甲大学", "数学与应用数学", 32000),
    ]
    frame = transition_frame(previous, current)
    assert list(frame["lag_rank"]) == [20000, 30000]
    assert list(frame["target_rank"]) == [18000, 32000]
    assert "target_rank" not in frame.columns.intersection(
        ["log_lag_rank", "lag_score", "school_median_log_rank", "major_median_log_rank"]
    )


def test_metrics_identify_perfect_and_optimistic_predictions() -> None:
    actual = np.array([1000, 5000, 10000])
    perfect = metrics(actual, actual)
    optimistic = metrics(actual, np.array([1200, 6000, 13000]))
    assert perfect["mae_rank"] == 0
    assert perfect["within_5pct"] == 1
    assert optimistic["optimistic_rate"] == 1
    assert optimistic["optimistic_mae_rank"] > 0


def artifact_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "data" / "artifacts"


def test_runtime_package_schema_and_probability_monotonicity() -> None:
    store = RuntimeStore(artifact_dir())
    assert store.manifest["schema_version"] == 2
    assert len(store.programs) == 16740
    strong = store._probabilities(8000)
    middle = store._probabilities(12000)
    weak = store._probabilities(18000)
    assert np.all(strong >= middle)
    assert np.all(middle >= weak)
    assert len(store.by_id) == len(store.programs)


def test_segment_mapping_is_monotonic() -> None:
    store = RuntimeStore(artifact_dir())
    ranks = [store.segment.score_to_rank(score) for score in range(750, 199, -1)]
    assert ranks == sorted(ranks)


def test_plan_and_admitted_fields_have_distinct_meaning() -> None:
    payload = json.loads((artifact_dir() / "predictions_2027.json").read_text(encoding="utf-8"))
    rows = payload["forecasts"]
    assert any(row.get("plan_2026") is not None for row in rows)
    assert all("admitted_2026" in row for row in rows)
    assert any(row.get("plan_2026") != row.get("admitted_2026") for row in rows if row.get("plan_2026") is not None)


def test_corrupt_runtime_package_fails_loudly(tmp_path: Path) -> None:
    target = tmp_path / "artifacts"
    shutil.copytree(artifact_dir(), target, ignore=shutil.ignore_patterns("*.cbm", "*.csv"))
    prediction = target / "predictions_2027.json"
    prediction.write_bytes(prediction.read_bytes()[:-1] + b" ")
    try:
        RuntimeStore(target)
    except RuntimeError as error:
        assert "哈希校验失败" in str(error)
    else:
        raise AssertionError("损坏的运行包不应通过校验")
