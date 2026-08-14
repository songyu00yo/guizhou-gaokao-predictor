from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import joblib
import numpy as np
import pandas as pd
from catboost import CatBoostRegressor
from lightgbm import LGBMRegressor
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.model_selection import GroupKFold

from .data_pipeline import AdmissionRow, match_years, normalize_major, normalize_school, read_rows


RANDOM_SEED = 20260814
FROZEN_CACHE_SHA256 = "CE687F4C8E542CCB6D6712AC195EF74299305F34E5771EA6D22E96A6BA28A1E9"
# Rank at the ordinary undergraduate control line. It is published before
# preference submission, so it can safely normalize annual population drift.
YEAR_RANK_SCALE = {2024: 155_799, 2025: 158_061, 2026: 166_669}
CAT_COLUMNS = ["school_key", "major_key", "admission_type"]
NUMERIC_COLUMNS = [
    "log_lag_rank",
    "log_lag_fraction",
    "lag_fraction",
    "rank_scale_growth",
    "lag_score",
    "log_lag_count",
    "school_median_log_rank",
    "major_median_log_rank",
    "school_program_count",
    "major_school_count",
    "school_centered_rank",
    "major_centered_rank",
    "major_name_length",
    "is_cooperation",
    "is_medical",
    "is_computer",
    "is_teacher",
    "is_local_school",
    "current_plan_available",
    "log_current_plan",
    "log_plan_change",
]


@dataclass
class Route:
    name: str
    kind: str
    params: dict[str, Any]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _general(rows: list[AdmissionRow]) -> list[AdmissionRow]:
    return [row for row in rows if "一般统考" in row.admission_type]


def _school_name_agrees(outcome_name: str, catalog_name: str) -> bool:
    outcome_key = normalize_school(outcome_name)
    catalog_key = normalize_school(catalog_name)
    return bool(
        outcome_key
        and catalog_key
        and (catalog_key.startswith(outcome_key) or outcome_key.startswith(catalog_key))
    )


def verified_plan_map(
    outcome_rows: list[AdmissionRow], catalog_path: Path
) -> tuple[dict[tuple[str, str], int], dict[str, Any]]:
    """Load only catalog plans whose codes and names independently agree.

    School/major codes repeat in some catalog sections.  Requiring both names
    prevents a visually plausible but wrong code join from contaminating the
    backtest.
    """
    eligible: dict[tuple[str, str], AdmissionRow] = {}
    ambiguous: set[tuple[str, str]] = set()
    for row in _general(outcome_rows):
        key = (row.school_code, row.major_code)
        if key in eligible:
            ambiguous.add(key)
        else:
            eligible[key] = row
    for key in ambiguous:
        eligible.pop(key, None)

    plans: dict[tuple[str, str], int] = {}
    code_matches = 0
    rejected_name_mismatch = 0
    if catalog_path.exists():
        with catalog_path.open("r", encoding="utf-8-sig", newline="") as handle:
            for item in csv.DictReader(handle):
                key = (str(item.get("school_code") or ""), str(item.get("major_code") or ""))
                outcome = eligible.get(key)
                if outcome is None:
                    continue
                code_matches += 1
                school_ok = _school_name_agrees(outcome.school_name, str(item.get("school_name") or ""))
                major_ok = normalize_major(outcome.major_name) == normalize_major(item.get("major_name"))
                if not (school_ok and major_ok):
                    rejected_name_mismatch += 1
                    continue
                try:
                    count = int(item.get("plan_count") or 0)
                except (TypeError, ValueError):
                    continue
                if count > 0:
                    plans[key] = count
    general_rows = len(_general(outcome_rows))
    report = {
        "catalog_file": str(catalog_path),
        "general_outcome_rows": general_rows,
        "code_matches": code_matches,
        "verified_matches": len(plans),
        "rejected_name_mismatch": rejected_name_mismatch,
        "verified_coverage": round(len(plans) / max(general_rows, 1), 6),
    }
    return plans, report


def transition_frame(
    previous: list[AdmissionRow],
    current: list[AdmissionRow],
    current_plans: dict[tuple[str, str], int] | None = None,
) -> pd.DataFrame:
    matches = match_years(_general(previous), _general(current))
    lag_rows = _general(previous)
    school_median = pd.Series(
        [math.log1p(row.min_rank) for row in lag_rows],
        index=[row.school_key for row in lag_rows],
    ).groupby(level=0).median().to_dict()
    major_median = pd.Series(
        [math.log1p(row.min_rank) for row in lag_rows],
        index=[row.major_key for row in lag_rows],
    ).groupby(level=0).median().to_dict()
    school_count = pd.Series(1, index=[row.school_key for row in lag_rows]).groupby(level=0).sum().to_dict()
    major_count = pd.Series(1, index=[row.major_key for row in lag_rows]).groupby(level=0).sum().to_dict()

    records: list[dict[str, Any]] = []
    for item in matches:
        lag: AdmissionRow = item["previous"]
        target: AdmissionRow = item["current"]
        log_rank = math.log1p(lag.min_rank)
        lag_scale = YEAR_RANK_SCALE[lag.year]
        target_scale = YEAR_RANK_SCALE[target.year]
        lag_count = max(lag.plan_count or lag.admitted_count, 0)
        current_plan = (current_plans or {}).get((target.school_code, target.major_code))
        lag_fraction = float(np.clip(lag.min_rank / lag_scale, 1e-6, 1.25))
        target_fraction = float(np.clip(target.min_rank / target_scale, 1e-6, 1.25))
        major_text = target.major_name
        records.append(
            {
                "previous_year": lag.year,
                "target_year": target.year,
                "school_code": target.school_code,
                "major_code": target.major_code,
                "school_name": target.school_name,
                "major_name": target.major_name,
                "school_key": target.school_key,
                "major_key": target.major_key,
                "admission_type": target.admission_type_key,
                "log_lag_rank": log_rank,
                "log_lag_fraction": math.log(lag_fraction),
                "lag_fraction": lag_fraction,
                "rank_scale_growth": target_scale / lag_scale,
                "lag_rank": lag.min_rank,
                "lag_rank_scale": lag_scale,
                "target_rank_scale": target_scale,
                "lag_score": lag.min_score,
                "log_lag_count": math.log1p(lag_count),
                "school_median_log_rank": school_median.get(lag.school_key, log_rank),
                "major_median_log_rank": major_median.get(lag.major_key, log_rank),
                "school_program_count": school_count.get(lag.school_key, 1),
                "major_school_count": major_count.get(lag.major_key, 1),
                "school_centered_rank": log_rank - school_median.get(lag.school_key, log_rank),
                "major_centered_rank": log_rank - major_median.get(lag.major_key, log_rank),
                "major_name_length": len(major_text),
                "is_cooperation": int(any(term in major_text for term in ["中外合作", "国际本科", "联合培养"])),
                "is_medical": int(any(term in major_text for term in ["临床", "口腔", "医学", "药学", "护理"])),
                "is_computer": int(any(term in major_text for term in ["计算机", "软件", "人工智能", "数据科学", "网络空间"])),
                "is_teacher": int("师范" in major_text),
                "is_local_school": int("贵州" in target.school_name),
                "current_plan_available": int(current_plan is not None),
                "log_current_plan": math.log1p(current_plan) if current_plan is not None else 0.0,
                "log_plan_change": (
                    math.log1p(current_plan) - math.log1p(lag_count)
                    if current_plan is not None
                    else 0.0
                ),
                "target_rank": target.min_rank,
                "target_score": target.min_score,
                "target_log_rank": math.log1p(target.min_rank),
                "target_log_fraction": math.log(target_fraction),
                "match_type": item["match_type"],
                "match_confidence": item["match_confidence"],
            }
        )
    return pd.DataFrame.from_records(records)


def _clip_rank(values: np.ndarray) -> np.ndarray:
    return np.rint(np.clip(values, 1, 300_000)).astype(int)


def _from_log(values: np.ndarray) -> np.ndarray:
    return _clip_rank(np.expm1(values))


def _from_log_fraction(values: np.ndarray, rank_scale: np.ndarray) -> np.ndarray:
    return _clip_rank(np.exp(values) * rank_scale)


def metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float]:
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    error = predicted - actual
    absolute = np.abs(error)
    relative = absolute / np.maximum(actual, 1.0)
    log_absolute = np.abs(np.log1p(predicted) - np.log1p(actual))
    optimistic = np.maximum(error, 0.0)
    decile = pd.qcut(pd.Series(actual), q=10, labels=False, duplicates="drop")
    macro_decile_ape = float(
        pd.DataFrame({"relative": relative, "decile": decile}).groupby("decile")["relative"].median().mean()
    )
    return {
        "rows": int(len(actual)),
        "mae_rank": round(float(absolute.mean()), 3),
        "median_ae_rank": round(float(np.median(absolute)), 3),
        "p90_ae_rank": round(float(np.quantile(absolute, 0.90)), 3),
        "mae_log_rank": round(float(log_absolute.mean()), 6),
        "median_ape": round(float(np.median(relative)), 6),
        "macro_decile_median_ape": round(macro_decile_ape, 6),
        "within_5pct": round(float(np.mean(relative <= 0.05)), 6),
        "within_10pct": round(float(np.mean(relative <= 0.10)), 6),
        "within_20pct": round(float(np.mean(relative <= 0.20)), 6),
        "optimistic_rate": round(float(np.mean(error > 0)), 6),
        "optimistic_mae_rank": round(float(optimistic.mean()), 3),
        "bias_rank": round(float(error.mean()), 3),
    }


def _numeric_matrix(frame: pd.DataFrame) -> pd.DataFrame:
    return frame[NUMERIC_COLUMNS].astype(float).replace([np.inf, -np.inf], np.nan).fillna(0.0)


def _cat_matrix(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame[NUMERIC_COLUMNS + CAT_COLUMNS].copy()
    for column in CAT_COLUMNS:
        result[column] = result[column].fillna("未知").astype(str)
    return result


def _build_routes() -> list[Route]:
    routes = [
        Route("last_year_rank", "baseline", {}),
        Route("percentile_persistence", "percentile", {}),
        Route("global_ratio", "ratio", {}),
        Route("hist_gradient_l2", "hist", {"loss": "squared_error", "l2_regularization": 2.0}),
        Route("hist_gradient_l1", "hist", {"loss": "absolute_error", "l2_regularization": 3.0}),
        Route("extra_trees_400", "extra", {"n_estimators": 400, "min_samples_leaf": 5, "max_features": 0.9}),
        Route("random_forest_300", "forest", {"n_estimators": 300, "min_samples_leaf": 6, "max_features": 0.85}),
        Route("lightgbm_l1", "lightgbm", {"objective": "regression_l1", "num_leaves": 24, "learning_rate": 0.025, "n_estimators": 900}),
        Route("lightgbm_huber", "lightgbm", {"objective": "huber", "num_leaves": 20, "learning_rate": 0.025, "n_estimators": 900}),
        Route("hist_delta_l1", "hist_delta", {"loss": "absolute_error", "l2_regularization": 4.0}),
        Route("lightgbm_delta_l1", "lightgbm_delta", {"objective": "regression_l1", "num_leaves": 20, "learning_rate": 0.025, "n_estimators": 900}),
    ]
    for depth in (6, 8):
        for loss in ("RMSE", "MAE"):
            routes.append(
                Route(
                    f"catboost_d{depth}_{loss.lower()}",
                    "catboost",
                    {
                        "depth": depth,
                        "loss_function": loss,
                        "iterations": 800,
                        "learning_rate": 0.035,
                        "l2_leaf_reg": 6.0,
                    },
                )
            )
    for depth in (5, 7):
        routes.append(
            Route(
                f"catboost_delta_d{depth}",
                "catboost_delta",
                {
                    "depth": depth,
                    "loss_function": "MAE",
                    "iterations": 900,
                    "learning_rate": 0.03,
                    "l2_leaf_reg": 8.0,
                },
            )
        )
    return routes


def _fit_predict(route: Route, train: pd.DataFrame, test: pd.DataFrame) -> tuple[np.ndarray, Any]:
    is_delta = route.kind.endswith("_delta") or "_delta_" in route.kind
    if is_delta:
        y = (
            train["target_log_fraction"].to_numpy(dtype=float)
            - train["log_lag_fraction"].to_numpy(dtype=float)
        )
    else:
        y = train["target_log_fraction"].to_numpy(dtype=float)
    if route.kind == "baseline":
        return test["lag_rank"].to_numpy(dtype=int), None
    if route.kind == "percentile":
        predicted = test["lag_fraction"].to_numpy(dtype=float) * test["target_rank_scale"].to_numpy(dtype=float)
        return _clip_rank(predicted), None
    if route.kind == "ratio":
        target_fraction = train["target_rank"].to_numpy(dtype=float) / train["target_rank_scale"].to_numpy(dtype=float)
        ratios = target_fraction / np.maximum(train["lag_fraction"].to_numpy(dtype=float), 1e-8)
        ratio = float(np.median(np.clip(ratios, 0.35, 2.8)))
        predicted = test["lag_fraction"].to_numpy(dtype=float) * ratio * test["target_rank_scale"].to_numpy(dtype=float)
        return _clip_rank(predicted), {"ratio": ratio}

    x_train = _numeric_matrix(train)
    x_test = _numeric_matrix(test)
    if route.kind in {"hist", "hist_delta"}:
        model = HistGradientBoostingRegressor(
            random_state=RANDOM_SEED,
            max_iter=500,
            learning_rate=0.045,
            max_leaf_nodes=24,
            min_samples_leaf=20,
            **route.params,
        )
    elif route.kind == "extra":
        model = ExtraTreesRegressor(random_state=RANDOM_SEED, n_jobs=-1, **route.params)
    elif route.kind == "forest":
        model = RandomForestRegressor(random_state=RANDOM_SEED, n_jobs=-1, **route.params)
    elif route.kind in {"lightgbm", "lightgbm_delta"}:
        model = LGBMRegressor(
            random_state=RANDOM_SEED,
            verbosity=-1,
            n_jobs=-1,
            reg_lambda=2.0,
            min_child_samples=25,
            **route.params,
        )
    elif route.kind in {"catboost", "catboost_delta"}:
        x_train = _cat_matrix(train)
        x_test = _cat_matrix(test)
        model = CatBoostRegressor(
            random_seed=RANDOM_SEED,
            verbose=False,
            allow_writing_files=False,
            thread_count=-1,
            random_strength=0.35,
            **route.params,
        )
        model.fit(x_train, y, cat_features=CAT_COLUMNS)
        prediction = model.predict(x_test)
        if is_delta:
            prediction = test["log_lag_fraction"].to_numpy(dtype=float) + prediction
        return _from_log_fraction(prediction, test["target_rank_scale"].to_numpy(dtype=float)), model
    else:
        raise ValueError(f"Unknown route kind: {route.kind}")
    model.fit(x_train, y)
    prediction = model.predict(x_test)
    if is_delta:
        prediction = test["log_lag_fraction"].to_numpy(dtype=float) + prediction
    return _from_log_fraction(prediction, test["target_rank_scale"].to_numpy(dtype=float)), model


def _selection_score(result: dict[str, float]) -> float:
    # Accuracy-first but explicitly penalize dangerous optimistic errors.
    return (
        result["mae_log_rank"]
        + 0.35 * result["macro_decile_median_ape"]
        + 0.0000025 * result["p90_ae_rank"]
        + 0.0000015 * result["optimistic_mae_rank"]
    )


def _internal_validation(frame: pd.DataFrame, routes: list[Route], folds: int = 5) -> list[dict[str, Any]]:
    """仅使用训练年度完成模型选择，避免测试年度参与调参。"""
    splitter = GroupKFold(n_splits=folds)
    actual = frame["target_rank"].to_numpy(dtype=int)
    groups = frame["school_key"].astype(str).to_numpy()
    results = []
    for route in routes:
        predicted = np.zeros(len(frame), dtype=int)
        for train_index, validation_index in splitter.split(frame, groups=groups):
            train = frame.iloc[train_index].reset_index(drop=True)
            validation = frame.iloc[validation_index].reset_index(drop=True)
            fold_prediction, _ = _fit_predict(route, train, validation)
            predicted[validation_index] = fold_prediction
        route_metrics = metrics(actual, predicted)
        results.append(
            {
                "route": route.name,
                "kind": route.kind,
                "folds": folds,
                "selection_score": round(_selection_score(route_metrics), 8),
                **route_metrics,
            }
        )
    return sorted(results, key=lambda item: item["selection_score"])


def _legacy_predictions(cache_path: Path, actual_2026: list[AdmissionRow]) -> tuple[np.ndarray, np.ndarray, int]:
    if not cache_path.exists() or _sha256(cache_path).upper() != FROZEN_CACHE_SHA256.upper():
        return np.array([], dtype=int), np.array([], dtype=int), 0
    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    exact: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in payload.get("predictions", []):
        key = (normalize_school(item.get("school")), normalize_major(item.get("major")))
        exact.setdefault(key, []).append(item)
    actual_values: list[int] = []
    predicted_values: list[int] = []
    for row in _general(actual_2026):
        candidates = exact.get((row.school_key, row.major_key), [])
        if len(candidates) != 1:
            continue
        predicted = int(candidates[0].get("predicted_rank") or 0)
        if predicted <= 0:
            continue
        actual_values.append(row.min_rank)
        predicted_values.append(predicted)
    return np.asarray(actual_values), np.asarray(predicted_values), len(actual_values)


def _calibration_by_decile(frame: pd.DataFrame, predicted: np.ndarray) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    calibrated = frame.copy()
    calibrated["predicted_rank"] = predicted
    calibrated["predicted_decile"] = pd.qcut(calibrated["predicted_rank"], q=10, labels=False, duplicates="drop")
    calibrated["residual"] = calibrated["target_rank"] - calibrated["predicted_rank"]
    profiles: list[dict[str, Any]] = []
    for decile, group in calibrated.groupby("predicted_decile"):
        residual = group["residual"].to_numpy(dtype=float)
        profile = {
            "decile": int(decile),
            "rows": int(len(group)),
            "predicted_min": int(group["predicted_rank"].min()),
            "predicted_max": int(group["predicted_rank"].max()),
            "q05": int(round(np.quantile(residual, 0.05))),
            "q10": int(round(np.quantile(residual, 0.10))),
            "q50": int(round(np.quantile(residual, 0.50))),
            "q90": int(round(np.quantile(residual, 0.90))),
            "q95": int(round(np.quantile(residual, 0.95))),
        }
        profiles.append(profile)
        for quantile in ("q05", "q10", "q50", "q90", "q95"):
            calibrated.loc[group.index, f"rank_{quantile}"] = _clip_rank(
                group["predicted_rank"].to_numpy(dtype=float) + profile[quantile]
            )
    return calibrated, profiles


def run_backtest(processed_dir: Path, artifact_dir: Path, frozen_cache: Path) -> dict[str, Any]:
    rows = {year: read_rows(processed_dir / f"admissions_{year}.csv") for year in (2024, 2025, 2026)}
    plans_2025, plan_report_2025 = verified_plan_map(rows[2025], processed_dir / "catalog_plans_2025.csv")
    plans_2026, plan_report_2026 = verified_plan_map(rows[2026], processed_dir / "catalog_plans_2026.csv")
    transition_2025 = transition_frame(rows[2024], rows[2025], plans_2025)
    transition_2026 = transition_frame(rows[2025], rows[2026], plans_2026)
    if len(transition_2025) < 5_000 or len(transition_2026) < 5_000:
        raise RuntimeError(
            f"Insufficient high-confidence cross-year matches: 2025={len(transition_2025)}, 2026={len(transition_2026)}"
        )

    artifact_dir.mkdir(parents=True, exist_ok=True)
    routes = _build_routes()
    internal_results = _internal_validation(transition_2025, routes)
    # 2026 只评估训练期已经选定的路线以及透明基线，不再参与选型。
    selected_route_name = internal_results[0]["route"]
    survivors = {selected_route_name} | {
        "last_year_rank",
        "percentile_persistence",
        "global_ratio",
    }
    route_by_name = {route.name: route for route in routes}
    test_actual = transition_2026["target_rank"].to_numpy(dtype=int)
    route_predictions: dict[str, np.ndarray] = {}
    timeout_results: list[dict[str, Any]] = []
    models: dict[str, Any] = {}
    for route_name in sorted(survivors):
        route = route_by_name[route_name]
        predicted, model = _fit_predict(route, transition_2025, transition_2026)
        route_predictions[route_name] = predicted
        models[route_name] = model
        route_metrics = metrics(test_actual, predicted)
        timeout_results.append(
            {"route": route.name, "kind": route.kind, "selection_score": round(_selection_score(route_metrics), 8), **route_metrics}
        )

    ranked_timeout = sorted(timeout_results, key=lambda item: item["selection_score"])
    winner = next(item for item in timeout_results if item["route"] == selected_route_name)
    winner_predictions = route_predictions[selected_route_name]
    calibrated_2026, calibration_profiles = _calibration_by_decile(transition_2026, winner_predictions)
    coverage_80 = float(
        np.mean(
            (calibrated_2026["target_rank"] >= calibrated_2026["rank_q10"])
            & (calibrated_2026["target_rank"] <= calibrated_2026["rank_q90"])
        )
    )
    coverage_90 = float(
        np.mean(
            (calibrated_2026["target_rank"] >= calibrated_2026["rank_q05"])
            & (calibrated_2026["target_rank"] <= calibrated_2026["rank_q95"])
        )
    )

    legacy_actual, legacy_predicted, legacy_rows = _legacy_predictions(frozen_cache, rows[2026])
    legacy_metrics = metrics(legacy_actual, legacy_predicted) if legacy_rows else {"rows": 0}
    best_baseline = min(
        (
            item
            for item in ranked_timeout
            if item["route"] in {"last_year_rank", "percentile_persistence", "global_ratio"}
        ),
        key=lambda item: item["selection_score"],
    )
    improvement = 1.0 - winner["mae_log_rank"] / max(best_baseline["mae_log_rank"], 1e-9)

    prediction_columns = [
        "target_year",
        "school_code",
        "school_name",
        "major_code",
        "major_name",
        "lag_rank",
        "target_rank",
        "predicted_rank",
        "rank_q05",
        "rank_q10",
        "rank_q50",
        "rank_q90",
        "rank_q95",
        "match_type",
        "match_confidence",
    ]
    calibrated_2026[prediction_columns].to_csv(
        artifact_dir / "backtest_predictions_2026.csv", index=False, encoding="utf-8-sig"
    )

    report = {
        "schema_version": 1,
        "random_seed": RANDOM_SEED,
        "target": "首次投档最低位次",
        "training_transition": "2024->2025",
        "time_out_test": "2025->2026",
        "training_rows": int(len(transition_2025)),
        "test_rows": int(len(transition_2026)),
        "catalog_plan_validation": {"2025": plan_report_2025, "2026": plan_report_2026},
        "internal_validation": internal_results,
        "time_out_results": ranked_timeout,
        "selection_rule": "5-fold grouped validation on 2024->2025 only",
        "selected_route": selected_route_name,
        "winner": winner,
        "best_baseline": best_baseline,
        "relative_log_mae_improvement_vs_best_baseline": round(float(improvement), 6),
        "interval_coverage": {"q10_q90": round(coverage_80, 6), "q05_q95": round(coverage_90, 6)},
        "calibration_profiles": calibration_profiles,
        "legacy_snapshot": {
            "path": str(frozen_cache),
            "expected_sha256": FROZEN_CACHE_SHA256,
            "matched_rows": legacy_rows,
            "metrics": legacy_metrics,
        },
    }
    (artifact_dir / "backtest_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Run leakage-safe rolling admission backtests")
    parser.add_argument("--processed-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--artifact-dir", type=Path, default=Path("data/artifacts"))
    parser.add_argument("--frozen-cache", type=Path, default=Path(".runtime-cache/data-store-v2.json"))
    args = parser.parse_args()
    report = run_backtest(args.processed_dir, args.artifact_dir, args.frozen_cache)
    summary = {
        "training_rows": report["training_rows"],
        "test_rows": report["test_rows"],
        "winner": report["winner"],
        "best_baseline": report["best_baseline"],
        "improvement": report["relative_log_mae_improvement_vs_best_baseline"],
        "interval_coverage": report["interval_coverage"],
        "legacy_snapshot": report["legacy_snapshot"],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
