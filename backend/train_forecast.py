from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .backtest import (
    YEAR_RANK_SCALE,
    _build_routes,
    _calibration_by_decile,
    _clip_rank,
    _fit_predict,
    _internal_validation,
    metrics,
    transition_frame,
    verified_plan_map,
)
from .data_pipeline import AdmissionRow, read_rows
from .data_pipeline import normalize_major, normalize_school


TARGET_YEAR = 2027
TARGET_RANK_SCALE = YEAR_RANK_SCALE[2026]
QUANTILES = ("q05", "q10", "q50", "q90", "q95")


def _forecast_frame(rows_2026: list[AdmissionRow]) -> pd.DataFrame:
    # Keep the latest official program universe. New 2027 programs are added
    # only after the official 2027 catalog is published.
    synthetic_2027 = [replace(row, year=TARGET_YEAR) for row in rows_2026]
    YEAR_RANK_SCALE[TARGET_YEAR] = TARGET_RANK_SCALE
    return transition_frame(rows_2026, synthetic_2027, current_plans=None)


def _profile_for_rank(predicted_rank: int, profiles: list[dict[str, Any]]) -> dict[str, Any]:
    containing = [
        profile
        for profile in profiles
        if int(profile["predicted_min"]) <= predicted_rank <= int(profile["predicted_max"])
    ]
    if containing:
        return containing[0]
    return min(
        profiles,
        key=lambda profile: abs(
            predicted_rank
            - (int(profile["predicted_min"]) + int(profile["predicted_max"])) / 2
        ),
    )


def apply_profiles(predicted: np.ndarray, profiles: list[dict[str, Any]]) -> dict[str, np.ndarray]:
    values: dict[str, list[int]] = {quantile: [] for quantile in QUANTILES}
    for raw_rank in predicted:
        rank = int(raw_rank)
        profile = _profile_for_rank(rank, profiles)
        ordered = sorted(
            int(_clip_rank(np.asarray([rank + int(profile[quantile])], dtype=float))[0])
            for quantile in QUANTILES
        )
        for quantile, value in zip(QUANTILES, ordered, strict=True):
            values[quantile].append(value)
    return {key: np.asarray(items, dtype=int) for key, items in values.items()}


def _crossfit_calibration(
    frame: pd.DataFrame, predicted: np.ndarray, folds: int = 5
) -> dict[str, Any]:
    fold_ids = np.asarray(
        [
            int(hashlib.sha1(str(key).encode("utf-8")).hexdigest()[:8], 16) % folds
            for key in frame["school_key"]
        ],
        dtype=int,
    )
    calibrated = {quantile: np.zeros(len(frame), dtype=int) for quantile in QUANTILES}
    for fold in range(folds):
        train_mask = fold_ids != fold
        test_mask = fold_ids == fold
        if not np.any(test_mask):
            continue
        _, profiles = _calibration_by_decile(
            frame.loc[train_mask].reset_index(drop=True), predicted[train_mask]
        )
        applied = apply_profiles(predicted[test_mask], profiles)
        for quantile in QUANTILES:
            calibrated[quantile][test_mask] = applied[quantile]

    actual = frame["target_rank"].to_numpy(dtype=int)
    coverage_80 = np.mean((actual >= calibrated["q10"]) & (actual <= calibrated["q90"]))
    coverage_90 = np.mean((actual >= calibrated["q05"]) & (actual <= calibrated["q95"]))
    return {
        "folds": folds,
        "median_calibrated_metrics": metrics(actual, calibrated["q50"]),
        "q10_q90_coverage": round(float(coverage_80), 6),
        "q05_q95_coverage": round(float(coverage_90), 6),
    }


def _unit_id(row: pd.Series) -> str:
    payload = "|".join(
        [
            str(TARGET_YEAR),
            str(row["school_code"]),
            str(row["major_code"]),
            str(row["school_name"]),
            str(row["major_name"]),
        ]
    )
    return f"ml27-{hashlib.sha1(payload.encode('utf-8')).hexdigest()[:16]}"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _build_segment_artifact(cache_path: Path, artifact_dir: Path) -> Path:
    """把累计位次还原为同分考生的真实位次区间。"""
    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    source_rows = payload.get("segment_rows_2026") or payload.get("segment_rows") or []
    cumulative_by_score = {
        int(row["score_mid"]): int(row["rank_high"])
        for row in source_rows
        if int(row.get("rank_high") or 0) > 0
    }
    rows: list[dict[str, int]] = []
    higher_score_cumulative = 0
    for score in sorted(cumulative_by_score, reverse=True):
        cumulative = cumulative_by_score[score]
        rank_low = higher_score_cumulative + 1
        rank_high = max(rank_low, cumulative)
        rows.append(
            {
                "score": score,
                "rank_low": rank_low,
                "rank_high": rank_high,
                "rank_mid": int(round((rank_low + rank_high) / 2)),
            }
        )
        higher_score_cumulative = max(higher_score_cumulative, cumulative)
    rows.sort(key=lambda item: item["score"])
    path = artifact_dir / "segment_2026.json"
    path.write_text(
        json.dumps(
            {"schema_version": 2, "year": 2026, "rows": rows},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    return path


def _fair_legacy_comparison(
    frame: pd.DataFrame, new_prediction: np.ndarray, frozen_cache: Path
) -> dict[str, Any]:
    if not frozen_cache.exists():
        return {"matched_rows": 0}
    try:
        payload = json.loads(frozen_cache.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {"matched_rows": 0}
    legacy: dict[tuple[str, str], list[int]] = {}
    for item in payload.get("predictions", []):
        predicted_rank = int(item.get("predicted_rank") or 0)
        if predicted_rank <= 0:
            continue
        key = (
            normalize_school(item.get("school")),
            normalize_major(item.get("major")),
        )
        legacy.setdefault(key, []).append(predicted_rank)

    actual_values: list[int] = []
    legacy_values: list[int] = []
    new_values: list[int] = []
    for position, row in frame.reset_index(drop=True).iterrows():
        candidates = legacy.get((str(row["school_key"]), str(row["major_key"])), [])
        if len(candidates) != 1:
            continue
        actual_values.append(int(row["target_rank"]))
        legacy_values.append(candidates[0])
        new_values.append(int(new_prediction[position]))
    if not actual_values:
        return {"matched_rows": 0}
    actual = np.asarray(actual_values, dtype=int)
    legacy_prediction = np.asarray(legacy_values, dtype=int)
    new = np.asarray(new_values, dtype=int)
    legacy_metrics = metrics(actual, legacy_prediction)
    new_metrics = metrics(actual, new)
    return {
        "matched_rows": len(actual_values),
        "legacy_metrics": legacy_metrics,
        "new_metrics": new_metrics,
        "mae_rank_improvement": round(
            1.0 - new_metrics["mae_rank"] / max(legacy_metrics["mae_rank"], 1e-9), 6
        ),
        "median_ae_rank_improvement": round(
            1.0 - new_metrics["median_ae_rank"] / max(legacy_metrics["median_ae_rank"], 1e-9), 6
        ),
        "within_10pct_gain": round(
            new_metrics["within_10pct"] - legacy_metrics["within_10pct"], 6
        ),
    }


def train_and_forecast(
    processed_dir: Path, artifact_dir: Path, frozen_cache: Path
) -> dict[str, Any]:
    rows = {
        year: read_rows(processed_dir / f"admissions_{year}.csv")
        for year in (2024, 2025, 2026)
    }
    # The provisional model deliberately masks current-year plan data because
    # the official 2027 catalog does not exist yet.
    transition_2025 = transition_frame(rows[2024], rows[2025], current_plans=None)
    transition_2026 = transition_frame(rows[2025], rows[2026], current_plans=None)
    forecast_frame = _forecast_frame(rows[2026])

    routes = _build_routes()
    internal_selection = _internal_validation(transition_2025, routes)
    selected_route_name = internal_selection[0]["route"]
    route = next(route for route in routes if route.name == selected_route_name)
    holdout_prediction, _ = _fit_predict(route, transition_2025, transition_2026)
    holdout_metrics = metrics(
        transition_2026["target_rank"].to_numpy(dtype=int), holdout_prediction
    )
    _, profiles = _calibration_by_decile(transition_2026, holdout_prediction)
    crossfit = _crossfit_calibration(transition_2026, holdout_prediction)
    fair_legacy_comparison = _fair_legacy_comparison(
        transition_2026, holdout_prediction, frozen_cache
    )

    final_training = pd.concat([transition_2025, transition_2026], ignore_index=True)
    forecast_prediction, model = _fit_predict(route, final_training, forecast_frame)
    forecast_quantiles = apply_profiles(forecast_prediction, profiles)

    artifact_dir.mkdir(parents=True, exist_ok=True)
    model_path = artifact_dir / f"model_2027_provisional_{route.name}.cbm"
    model.save_model(model_path)

    plans_2026, plan_validation_2026 = verified_plan_map(
        rows[2026], processed_dir / "catalog_plans_2026.csv"
    )
    source_lookup: dict[tuple[str, str, str, str], AdmissionRow] = {}
    for source in rows[2026]:
        key = (source.school_code, source.major_code, source.school_key, source.major_key)
        source_lookup.setdefault(key, source)

    forecasts: list[dict[str, Any]] = []
    for index, row in forecast_frame.iterrows():
        q05 = int(forecast_quantiles["q05"][index])
        q10 = int(forecast_quantiles["q10"][index])
        q50 = int(forecast_quantiles["q50"][index])
        q90 = int(forecast_quantiles["q90"][index])
        q95 = int(forecast_quantiles["q95"][index])
        relative_width = (q90 - q10) / max(q50, 1)
        confidence = float(np.clip(0.92 - 0.35 * relative_width, 0.35, 0.94))
        source_key = (
            str(row["school_code"]),
            str(row["major_code"]),
            str(row["school_key"]),
            str(row["major_key"]),
        )
        source = source_lookup.get(source_key)
        plan_2026 = plans_2026.get((str(row["school_code"]), str(row["major_code"])))
        forecasts.append(
            {
                "unit_id": _unit_id(row),
                "target_year": TARGET_YEAR,
                "school_code": str(row["school_code"]),
                "school": str(row["school_name"]),
                "major_code": str(row["major_code"]),
                "major": str(row["major_name"]),
                "admission_type": str(row["admission_type"]),
                "rank_2026": int(row["lag_rank"]),
                "score_2026": int(row["lag_score"]),
                "plan_2026": plan_2026,
                "admitted_2026": int(source.admitted_count) if source is not None else None,
                "predicted_rank_raw": int(forecast_prediction[index]),
                "predicted_rank": q50,
                "rank_q05": q05,
                "rank_q10": q10,
                "rank_q50": q50,
                "rank_q90": q90,
                "rank_q95": q95,
                "confidence_score": round(confidence, 4),
            }
        )

    generated_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "schema_version": 2,
        "target_year": TARGET_YEAR,
        "generated_at": generated_at,
        "status": "provisional_before_2027_catalog",
        "program_universe": "2026 ordinary undergraduate physics programs",
        "rank_scale_assumption": TARGET_RANK_SCALE,
        "model_route": route.name,
        "forecast_count": len(forecasts),
        "calibration_profiles": profiles,
        "forecasts": forecasts,
    }
    prediction_path = artifact_dir / "predictions_2027.json"
    prediction_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    latest_backtest_path = artifact_dir / "backtest_report.json"
    latest_backtest = (
        json.loads(latest_backtest_path.read_text(encoding="utf-8"))
        if latest_backtest_path.exists()
        else {}
    )
    report = {
        "schema_version": 2,
        "generated_at": generated_at,
        "deployment_status": "provisional_before_2027_catalog",
        "deployment_route": route.name,
        "selection_rule": "5-fold grouped validation on 2024->2025 only",
        "internal_model_selection": internal_selection[:5],
        "training_transitions": ["2024->2025", "2025->2026"],
        "training_rows": int(len(final_training)),
        "forecast_rows": len(forecasts),
        "time_out_2026_metrics_without_future_plan": holdout_metrics,
        "crossfit_calibration": crossfit,
        "fair_legacy_comparison": fair_legacy_comparison,
        "calibration_profiles": profiles,
        "catalog_plan_validation_2026": plan_validation_2026,
        "latest_plan_enhanced_backtest_winner": latest_backtest.get("winner"),
        "legacy_snapshot": latest_backtest.get("legacy_snapshot"),
        "limitations": [
            "The official 2027 catalog and 2027 one-score-one-rank table are not published yet.",
            "New or renamed 2027 programs are added only after the official catalog is available.",
            "Probability intervals describe first-round投档 uncertainty, not a guarantee of final admission.",
        ],
        "artifacts": {
            "model": str(model_path),
            "predictions": str(prediction_path),
        },
    }
    report_path = artifact_dir / "model_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    segment_path = _build_segment_artifact(frozen_cache, artifact_dir)
    public_files = [prediction_path, report_path, segment_path]
    manifest = {
        "schema_version": 2,
        "target_year": TARGET_YEAR,
        "generated_at": generated_at,
        "files": [
            {"name": path.name, "bytes": path.stat().st_size, "sha256": _sha256(path)}
            for path in public_files
        ],
    }
    (artifact_dir / "runtime_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the selected route and forecast 2027")
    parser.add_argument("--processed-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--artifact-dir", type=Path, default=Path("data/artifacts"))
    parser.add_argument(
        "--frozen-cache", type=Path, default=Path(".runtime-cache/data-store-v2.json")
    )
    args = parser.parse_args()
    report = train_and_forecast(args.processed_dir, args.artifact_dir, args.frozen_cache)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
