from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from backend.catalog_pipeline import _parse_major_buffer
from backend.data_pipeline import AdmissionRow
from backend.public_supplement import agreeing_catalog, apply_catalog_notice, unique_history
from backend.rebuild import activate_package, file_record
from backend.runtime_store import RuntimeStore
from backend.runtime_store import SegmentMapper
from backend.train_forecast import _build_segment_artifact
from colleges_chat import normalize_colleges_chat_name


def row(major: str = "数学与应用数学", code: str = "501", year: int = 2026) -> AdmissionRow:
    return AdmissionRow(year, 1, "0751", "贵州师范学院", code, major, "一般统考生",
                        10, 9, 500, 60000, 31, "official.pdf", "https://example.org/source.pdf")


def test_history_and_catalog_reject_ambiguous_or_disagreeing_matches() -> None:
    a = row()
    assert unique_history([a, a], a.school_name, a.major_name, a.major_code) is None
    assert unique_history([a], "另一所大学", a.major_name, a.major_code) is None
    index = {("0751", "501"): {"school_name": "另一所大学", "major_name": a.major_name}}
    assert agreeing_catalog(a, index) is None
    index[("0751", "501")] = {"school_name": "贵州师范学院(贵州贵阳)", "major_name": a.major_name}
    assert agreeing_catalog(a, index) is not None
    index[("0751", "501")]["school_name"] = "贵州师范学院(独立校区)"
    assert agreeing_catalog(a, index) is None


def test_school_punctuation_normalization_preserves_campus_identity() -> None:
    assert normalize_colleges_chat_name("中国地质大学（北京）") == normalize_colleges_chat_name("中国地质大学(北京)")
    assert normalize_colleges_chat_name("中国地质大学（北京）") != normalize_colleges_chat_name("中国地质大学（武汉）")


def test_catalog_tuition_and_correction_are_separate_from_admitted_count() -> None:
    parsed = _parse_major_buffer(2026, "0751", "贵州师范学院", "501",
                                 ["数学与应用数学 化学 10 不限 4 4200"], 31, "left")
    assert parsed is not None and parsed.plan_count == 10 and parsed.tuition == "4200"
    corrected = apply_catalog_notice(row(), {"tuition": "4200", "plan_count": "10"})
    assert corrected["tuition"] == "免费" and corrected["plan_count"] == "10"
    assert apply_catalog_notice(row(year=2025), {"tuition": "4200"})["tuition"] == "4200"


def test_training_segment_works_without_legacy_cache(tmp_path: Path) -> None:
    source = Path(__file__).resolve().parents[1] / "data/artifacts/segment_2026.json"
    output = _build_segment_artifact(source, tmp_path)
    assert json.loads(output.read_text())["rows"] == json.loads(source.read_text())["rows"]


def test_score_mapping_handles_descending_parser_input_and_rejects_overlap() -> None:
    payload = {"rows": [{"score": 600, "rank_low": 1, "rank_high": 20, "rank_mid": 10},
                         {"score": 500, "rank_low": 21, "rank_high": 100, "rank_mid": 60}]}
    mapper = SegmentMapper(payload)
    assert mapper.score_to_rank(500) == 100
    assert mapper.score_to_rank(600) == 20
    payload["rows"][1]["rank_low"] = 20
    with pytest.raises(RuntimeError, match="重叠"):
        SegmentMapper(payload)


def enriched_package(tmp_path: Path) -> tuple[Path, str]:
    source = Path(__file__).resolve().parents[1] / "data/artifacts"
    target = tmp_path / "package"
    shutil.copytree(source, target, ignore=shutil.ignore_patterns("*.cbm", "*.csv"))
    runtime = RuntimeStore(target)
    unit = runtime.programs[0]["unit_id"]
    supplement = {"programs": {unit: {"history_2024": {"min_rank": 12345, "min_score": 600},
                                      "history_2025": None}}, "schools": {}, "coverage": {}}
    path = target / "supplement.json"
    path.write_text(json.dumps(supplement), encoding="utf-8")
    manifest_path = target / "runtime_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["files"].append(file_record(path))
    manifest_path.write_text(json.dumps(manifest))
    return target, unit


def test_runtime_uses_real_history_and_preserves_unknown_values(tmp_path: Path) -> None:
    package, unit = enriched_package(tmp_path)
    runtime = RuntimeStore(package)
    detail = runtime.detail(unit, 500, None, "balanced")
    assert detail["history"]["years"] == ["2024", "2025", "2026", "2027预测"]
    assert detail["history"]["rank"][:2] == [12345, None]
    assert detail["history"]["score"][-1] is None
    assert detail["model_weight_distribution"] == {}
    assert "history" not in runtime.recommend(500, None, "balanced")["list"][0]
    manual = runtime.recommend(500, 50000, "balanced")["summary"]
    assert manual["user_rank"] == 50000 and manual["score_mapped_rank"] == 61624
    current_band = next(row for row in manual["segment_projection"] if row["score"] == 500)
    assert current_band["predicted_rank"] == 61624 and current_band["same_band"] > 0


def test_activation_refuses_corruption_and_preserves_previous_selection(tmp_path: Path) -> None:
    package, _ = enriched_package(tmp_path)
    activate_package(package, tmp_path)
    pointer = tmp_path / "var/runtime/active.json"
    before = pointer.read_bytes()
    (package / "supplement.json").write_text("{}")
    with pytest.raises(RuntimeError):
        activate_package(package, tmp_path)
    assert pointer.read_bytes() == before


def test_environment_override_precedes_active_package(tmp_path: Path, monkeypatch) -> None:
    package, _ = enriched_package(tmp_path)
    pointer = tmp_path / "var/runtime/active.json"
    pointer.parent.mkdir(parents=True)
    pointer.write_text(json.dumps({"artifact_dir": "/missing"}))
    monkeypatch.setenv("GZ_RUNTIME_DATA_DIR", str(package))
    assert RuntimeStore.from_environment(tmp_path).artifact_dir == package
