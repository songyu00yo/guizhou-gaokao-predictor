from __future__ import annotations

import hashlib
import copy
import json
import os
import re
from bisect import bisect_left
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np


RISK_LABELS = np.asarray(["强冲", "冲", "稳", "保", "兜底"], dtype=object)
RISK_QUOTAS = {
    "conservative": np.asarray([4, 10, 28, 36, 18]),
    "balanced": np.asarray([8, 22, 36, 22, 8]),
    "aggressive": np.asarray([18, 30, 28, 15, 5]),
}
RISK_TARGET = {"conservative": 0.80, "balanced": 0.62, "aggressive": 0.42}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class SegmentMapper:
    def __init__(self, payload: dict[str, Any]) -> None:
        rows = payload.get("rows") or []
        if not rows:
            raise RuntimeError("一分一段运行时数据为空")
        self.rows = sorted(rows, key=lambda row: int(row["score"]))
        self.scores = [int(row["score"]) for row in self.rows]
        if len(set(self.scores)) != len(rows):
            raise RuntimeError("一分一段数据包含重复分数")
        previous_rank_low = None
        for row in self.rows:
            low, high = int(row["rank_low"]), int(row["rank_high"])
            if not (0 <= int(row["score"]) <= 750 and 1 <= low <= high):
                raise RuntimeError("一分一段数据范围错误")
            if previous_rank_low is not None and high >= previous_rank_low:
                raise RuntimeError("一分一段数据累计位次逆序或区间重叠")
            previous_rank_low = low
        self.rank_rows = sorted(rows, key=lambda row: int(row["rank_mid"]))
        self.rank_mids = [int(row["rank_mid"]) for row in self.rank_rows]

    def score_to_rank(self, score: int | float) -> int:
        value = int(round(float(score)))
        position = bisect_left(self.scores, value)
        candidates = self.rows[max(0, position - 1) : min(len(self.rows), position + 1)]
        row = min(candidates, key=lambda item: abs(int(item["score"]) - value))
        # 同分考生使用区间下沿（较差位次），避免把边界结果报得过于乐观。
        return int(row["rank_high"])

    def rank_to_score(self, rank: int | float) -> int:
        value = int(round(float(rank)))
        position = bisect_left(self.rank_mids, value)
        candidates = self.rank_rows[max(0, position - 1) : min(len(self.rank_rows), position + 1)]
        row = min(candidates, key=lambda item: abs(int(item["rank_mid"]) - value))
        return int(row["score"])


class RuntimeStore:
    """只读加载公开运行包，线上进程不接触训练依赖和私人资料。"""

    def __init__(self, artifact_dir: Path) -> None:
        self.artifact_dir = artifact_dir
        manifest_path = artifact_dir / "runtime_manifest.json"
        try:
            self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise RuntimeError(f"无法读取运行包清单：{manifest_path}") from error
        if self.manifest.get("schema_version") != 2:
            raise RuntimeError("运行包 schema 版本不受支持")
        for item in self.manifest.get("files", []):
            path = artifact_dir / str(item["name"])
            if not path.is_file() or path.stat().st_size != int(item["bytes"]):
                raise RuntimeError(f"运行包文件缺失或大小不符：{path.name}")
            if _sha256(path).lower() != str(item["sha256"]).lower():
                raise RuntimeError(f"运行包哈希校验失败：{path.name}")

        prediction_payload = json.loads((artifact_dir / "predictions_2027.json").read_text(encoding="utf-8"))
        self.report = json.loads((artifact_dir / "model_report.json").read_text(encoding="utf-8"))
        segment_payload = json.loads((artifact_dir / "segment_2026.json").read_text(encoding="utf-8"))
        if prediction_payload.get("schema_version") != 2:
            raise RuntimeError("预测文件 schema 版本不受支持")
        self.payload = prediction_payload
        supplement_listed = any(item["name"] == "supplement.json" for item in self.manifest.get("files", []))
        self.supplement = json.loads((artifact_dir / "supplement.json").read_text(encoding="utf-8")) if supplement_listed else {}
        self.programs: list[dict[str, Any]] = prediction_payload["forecasts"]
        if len(self.programs) != int(prediction_payload.get("forecast_count") or 0):
            raise RuntimeError("预测文件记录数与清单不一致")
        self.segment = SegmentMapper(segment_payload)
        self.by_id = {str(item["unit_id"]): item for item in self.programs}
        self.id_to_index = {str(item["unit_id"]): index for index, item in enumerate(self.programs)}
        if len(self.by_id) != len(self.programs):
            raise RuntimeError("预测文件包含重复 unit_id")

        self.quantiles = np.asarray(
            [
                [item["rank_q05"], item["rank_q10"], item["rank_q50"], item["rank_q90"], item["rank_q95"]]
                for item in self.programs
            ],
            dtype=float,
        )
        if np.any(np.diff(self.quantiles, axis=1) < 0):
            raise RuntimeError("预测文件存在逆序分位数")
        self.confidence = np.asarray([item["confidence_score"] for item in self.programs], dtype=float)
        self.predicted_rank = np.asarray([item["predicted_rank"] for item in self.programs], dtype=float)
        self.school_index: dict[str, list[int]] = {}
        self.major_index: dict[str, list[int]] = {}
        for index, item in enumerate(self.programs):
            self.school_index.setdefault(str(item["school"]), []).append(index)
            self.major_index.setdefault(str(item["major"]), []).append(index)

    @classmethod
    def from_environment(cls, app_dir: Path) -> "RuntimeStore":
        configured = os.environ.get("GZ_RUNTIME_DATA_DIR")
        active = app_dir / "var" / "runtime" / "active.json"
        if configured:
            artifact_dir = Path(configured).expanduser().resolve()
        elif active.exists():
            artifact_dir = Path(json.loads(active.read_text(encoding="utf-8"))["artifact_dir"]).resolve()
        else:
            artifact_dir = app_dir / "data" / "artifacts"
        return cls(artifact_dir)

    def _probabilities(self, user_rank: int) -> np.ndarray:
        q05, q10, q50, q90, q95 = self.quantiles.T
        rank = float(user_rank)

        def between(left: np.ndarray, right: np.ndarray, low: float, high: float) -> np.ndarray:
            ratio = (rank - left) / np.maximum(right - left, 1.0)
            return low + np.clip(ratio, 0.0, 1.0) * (high - low)

        cdf = np.select(
            [rank < q05, rank <= q10, rank <= q50, rank <= q90, rank <= q95],
            [
                np.clip(0.05 * rank / np.maximum(q05, 1.0), 0.01, 0.05),
                between(q05, q10, 0.05, 0.10),
                between(q10, q50, 0.10, 0.50),
                between(q50, q90, 0.50, 0.90),
                between(q90, q95, 0.90, 0.95),
            ],
            default=np.clip(0.95 + 0.04 * (rank - q95) / np.maximum(q95 - q05, 1.0), 0.95, 0.99),
        )
        return np.clip(1.0 - cdf, 0.01, 0.99)

    def _ranked_indices(self, probabilities: np.ndarray, preference: str) -> tuple[np.ndarray, np.ndarray]:
        risk_codes = np.digitize(probabilities, [0.25, 0.50, 0.74, 0.89])
        target = RISK_TARGET[preference]
        score = 0.78 * (1.0 - np.abs(probabilities - target)) + 0.22 * self.confidence
        order = np.argsort(-score, kind="stable")
        selected: list[int] = []
        chosen: set[int] = set()
        for code, quota in enumerate(RISK_QUOTAS[preference]):
            bucket = order[risk_codes[order] == code][: int(quota)]
            selected.extend(int(value) for value in bucket)
            chosen.update(int(value) for value in bucket)
        if len(selected) < 96:
            for value in order:
                index = int(value)
                if index not in chosen:
                    selected.append(index)
                    chosen.add(index)
                    if len(selected) == 96:
                        break
        selected_array = np.asarray(sorted(selected[:96], key=lambda value: -score[value]), dtype=int)
        alternates = np.asarray([int(value) for value in order if int(value) not in chosen][:192], dtype=int)
        return selected_array, alternates

    def _display_plan(self, source: dict[str, Any], year: int = 2026) -> int | None:
        history = self.supplement.get("programs", {}).get(source["unit_id"], {}).get(f"history_{year}") or {}
        value = history.get("plan_count") if history.get("catalog_source_page") else source.get(f"plan_{year}")
        return int(value) if value is not None else None

    def _item(self, index: int, user_rank: int, probability: float, order: int | None) -> dict[str, Any]:
        source = self.programs[index]
        q05, q10, q50, q90, q95 = (int(value) for value in self.quantiles[index])
        score_low = self.segment.rank_to_score(q90)
        score_high = self.segment.rank_to_score(q10)
        risk = str(RISK_LABELS[np.digitize(probability, [0.25, 0.50, 0.74, 0.89])])
        result = {
            "order": order,
            "unit_id": source["unit_id"],
            "school": source["school"],
            "school_code": source["school_code"],
            "major": source["major"],
            "major_code": source["major_code"],
            "target_year": 2027,
            "score_low": min(score_low, score_high),
            "score_high": max(score_low, score_high),
            "score_range": f"{min(score_low, score_high)}-{max(score_low, score_high)}",
            "predicted_rank": q50,
            "rank_low": q10,
            "rank_high": q90,
            "rank_range": f"{q10}-{q90}",
            "rank_q05": q05,
            "rank_q10": q10,
            "rank_q50": q50,
            "rank_q90": q90,
            "rank_q95": q95,
            "rank_2026": source["rank_2026"],
            "score_2026": source["score_2026"],
            "plan_2026": self._display_plan(source),
            "admitted_2026": source.get("admitted_2026"),
            "risk_level": risk,
            "admission_probability": round(float(probability), 4),
            "confidence_score": source["confidence_score"],
            "risk_gap_percent": round((user_rank - q50) / max(q50, 1), 4),
            "verified_data_flag": True,
            "plausibility_status": "calibrated",
            "explanation": f"2027 中位投档位次约 {q50}，80% 校准区间为 {q10}-{q90}。",
            "driving_factors": ["年度位次归一化", "院校与专业历史", "时间外残差校准"],
        }
        # Alternates stay compact; selecting one loads its full detail.
        if order is None:
            return result
        enrichment = self.supplement.get("programs", {}).get(source["unit_id"], {})
        headline = self.supplement.get("schools", {}).get(source["school"], {}).get("headline", {})
        public = self.supplement.get("schools", {}).get(source["school"], {})
        if public:
            result["has_life_data"] = bool(public.get("reviews"))
        # Keep recommendations compact; complete history and provenance are returned by detail.
        for key in ("tuition", "subject_requirement"):
            if enrichment.get(key) is not None:
                result[key] = enrichment[key]
        for key in ("city", "ownership"):
            if headline.get(key):
                result[key] = headline[key]
        if headline.get("tier"):
            result["school_tier_label"] = headline["tier"]
        return result

    def _history(self, unit_id: str) -> dict[str, Any]:
        """Compact 2024-2027 history shared by list rows and the detail view."""
        source = self.by_id[unit_id]
        extra = self.supplement.get("programs", {}).get(unit_id, {})
        histories = [extra.get(f"history_{year}") or {} for year in (2024, 2025)]
        histories.append(extra.get("history_2026") or {"min_rank": source["rank_2026"], "min_score": source["score_2026"],
                                                      "plan_count": source.get("plan_2026"),
                                                      "admitted_count": source.get("admitted_2026")})
        return {"years": ["2024", "2025", "2026", "2027预测"],
                "rank": [h.get("min_rank") for h in histories] + [source["predicted_rank"]],
                "score": [h.get("min_score") for h in histories] + [None],
                "plan": [h.get("plan_count") for h in histories] + [None],
                "admitted": [h.get("admitted_count") for h in histories] + [None]}

    @lru_cache(maxsize=256)
    def recommend(self, score: int, current_rank: int | None, preference: str) -> dict[str, Any]:
        preference = preference if preference in RISK_QUOTAS else "balanced"
        user_rank = int(current_rank or self.segment.score_to_rank(score))
        probabilities = self._probabilities(user_rank)
        selected, alternates = self._ranked_indices(probabilities, preference)
        selected_items = [
            self._item(int(index), user_rank, float(probabilities[index]), order)
            for order, index in enumerate(selected, start=1)
        ]
        alternate_items = [
            self._item(int(index), user_rank, float(probabilities[index]), None)
            for index in alternates
        ]
        # 列表每行要画 2024—2027 位次走势：只给正式志愿附上 4 个位次数字，
        # 完整历史（分数、计划、录取人数、来源）仍只由 detail 返回，控制列表体积。
        for item in selected_items:
            item["rank_trend"] = self._history(item["unit_id"])["rank"]
        distribution: dict[str, int] = {}
        for item in selected_items:
            distribution[item["risk_level"]] = distribution.get(item["risk_level"], 0) + 1
        model_metrics = self.report.get("time_out_2026_metrics_without_future_plan", {})
        calibration = self.report.get("crossfit_calibration", {})
        segment_rows = [row for row in self.segment.rows if abs(int(row["score"]) - score) <= 25
                        and (int(row["score"]) == score or int(row["score"]) % 5 == score % 5)]
        if not segment_rows:
            segment_rows = [min(self.segment.rows, key=lambda row: abs(int(row["score"]) - score))]
        return {
            "list": selected_items,
            "alternates": alternate_items,
            "summary": {
                "input_score": score,
                "input_rank": current_rank,
                "user_rank": user_rank,
                "score_mapped_rank": self.segment.score_to_rank(score),
                "segment_projection": [{"score": row["score"], "predicted_rank": row["rank_high"],
                                         "same_band": int(row["rank_high"]) - int(row["rank_low"]) + 1,
                                         "label": "当前分" if row["score"] == score else "官方分段",
                                         "source_year": 2026} for row in segment_rows],
                "predicted_user_rank": user_rank,
                "risk_preference": preference,
                "total_candidates": len(self.programs),
                "returned": len(selected_items),
                "risk_distribution": distribution,
                "rank_basis": "优先使用考生位次；未填写时按贵州 2026 物理类一分一段表保守换算。",
                "model": {
                    "target_year": 2027,
                    "route": self.payload["model_route"],
                    "status": self.payload["status"],
                    "time_out_rows": model_metrics.get("rows"),
                    "time_out_mae_rank": model_metrics.get("mae_rank"),
                    "time_out_median_ae_rank": model_metrics.get("median_ae_rank"),
                    "time_out_within_10pct": model_metrics.get("within_10pct"),
                    "crossfit_q10_q90_coverage": calibration.get("q10_q90_coverage"),
                    "crossfit_q05_q95_coverage": calibration.get("q05_q95_coverage"),
                },
                "limitations": self.report.get("limitations", []),
            },
        }

    def detail(self, unit_id: str, score: int, current_rank: int | None, preference: str) -> dict[str, Any]:
        source = self.by_id.get(unit_id)
        if source is None:
            raise KeyError(unit_id)
        index = self.id_to_index[unit_id]
        user_rank = int(current_rank or self.segment.score_to_rank(score))
        probability = float(self._probabilities(user_rank)[index])
        item = self._item(index, user_rank, probability, None)
        extra = copy.deepcopy(self.supplement.get("programs", {}).get(unit_id, {}))
        item.update(extra)
        public = self.supplement.get("schools", {}).get(source["school"], {})
        item["official_site"] = public.get("official", {}).get("official_site") or None
        item.update({key: public["headline"][key] for key in ("city", "ownership")
                     if public.get("headline", {}).get(key)})
        item["has_life_data"] = bool(public.get("reviews"))
        item["school_tier_label"] = public.get("headline", {}).get("tier") or "层次待核验"
        guide = {}
        for field, keyword in (("dormitory", "宿舍"), ("canteen", "食堂")):
            answers = [review for review in public.get("reviews", []) if keyword in review.get("title", "")]
            answers.sort(key=lambda review: tuple(int(x) for x in re.findall(r"\d+", review.get("date", ""))[:3]), reverse=True)
            if answers:
                selected = answers[0]
                guide[field] = (f"学生反馈（{selected.get('date') or '日期未提供'}）："
                                f"{selected['title']} {selected['summary'][:220]}。完整回答见生活问卷。")
        if guide:
            item["school_guide"] = guide
        item.setdefault("history_2026", {"year": 2026, "min_rank": source["rank_2026"],
                                        "min_score": source["score_2026"], "plan_count": source.get("plan_2026"),
                                        "admitted_count": source.get("admitted_2026")})
        item["history"] = self._history(unit_id)
        item["uncertainty_range"] = {
            "rank_80pct": [source["rank_q10"], source["rank_q90"]],
            "rank_90pct": [source["rank_q05"], source["rank_q95"]],
            "score": [item["score_low"], item["score_high"]],
        }
        item["model_weight_distribution"] = {}
        item["model_weight_status"] = "unavailable_no_per_prediction_attribution"
        return item

    def school_profile(self, school: str) -> dict[str, Any]:
        indices = self.school_index.get(school)
        if not indices:
            raise KeyError(school)
        rows = [self.programs[index] for index in indices]
        best_rank = min(int(row["predicted_rank"]) for row in rows)
        plans = [value for row in rows if (value := self._display_plan(row)) is not None]
        majors = [
            {
                "unit_id": row["unit_id"],
                "major": row["major"],
                "major_code": row["major_code"],
                "predicted_rank": row["predicted_rank"],
                "rank_2026": row["rank_2026"],
                "score_2026": row["score_2026"],
                "plan_2026": self._display_plan(row),
                "admitted_2026": row.get("admitted_2026"),
            }
            for row in sorted(rows, key=lambda value: int(value["predicted_rank"]))
        ]
        profile = {
            "school": school,
            "headline": {
                "city": "待补充",
                "ownership": "待核验",
                "tier": "待核验",
                "category": "物理类",
                "rank": best_rank,
                "coverage": len(rows),
                "major_count": len(rows),
                "min_rank_2026": min(int(row["rank_2026"]) for row in rows),
                "plan_total_2026": sum(plans) if plans else None,
                "programs_with_verified_plan_2026": len(plans),
                "plan_total_status": "complete" if len(plans) == len(rows) else "partial",
                "tuition_range": "待核验",
                "source_count": 1,
            },
            "sections": {
                "basic": [{"title": "院校信息", "value": "公开运行包未附带私人院校画像，可通过环境变量接入。", "source": "公开运行包", "confidence": "待补充"}],
                "admission": [{"title": "2027预测", "value": f"当前覆盖 {len(rows)} 个物理类专业。", "source": "预测模型", "confidence": "中高"}],
                "major_strength": [],
                "life": [],
                "development": [],
            },
            "reviews": [],
            "source_summary": [{"title": "贵州普通本科首次投档", "status": "已接入", "confidence": "高"}],
            "official": {"official_site": "", "admission_site": "", "admission_phone": "待核验"},
            "majors": majors,
        }
        public = copy.deepcopy(self.supplement.get("schools", {}).get(school, {}))
        for key, value in public.items():
            if isinstance(value, dict) and isinstance(profile.get(key), dict):
                profile[key].update(value)
            else:
                profile[key] = value
        tuition_values = []
        for row in rows:
            tuition = self.supplement.get("programs", {}).get(row["unit_id"], {}).get("tuition")
            if tuition and tuition not in tuition_values:
                tuition_values.append(tuition)
        if tuition_values:
            profile["headline"]["tuition_range"] = "、".join(tuition_values) + "（2026目录，元/年）"
        known = [profile["headline"].get(k) not in (None, "", "待补充", "待核验")
                 for k in ("city", "ownership", "tuition_range")]
        known.extend([bool(profile.get("official", {}).get("official_site")),
                      bool(profile.get("sections", {}).get("life")),
                      bool(profile.get("sections", {}).get("major_strength")),
                      bool(profile.get("sections", {}).get("development"))])
        profile["headline"]["coverage"] = round(sum(known) / len(known) * 100)
        return profile

    def catalog_schools(self) -> list[dict[str, Any]]:
        rows = []
        for school, indices in self.school_index.items():
            programs = [self.programs[index] for index in indices]
            rows.append(
                {
                    "school": school,
                    "major_count": len(programs),
                    "predicted_rank_best": min(int(item["predicted_rank"]) for item in programs),
                    "predicted_rank_worst": max(int(item["predicted_rank"]) for item in programs),
                }
            )
        return sorted(rows, key=lambda item: item["predicted_rank_best"])

    def catalog_majors(self) -> list[dict[str, Any]]:
        rows = []
        for major, indices in self.major_index.items():
            programs = [self.programs[index] for index in indices]
            rows.append(
                {
                    "major": major,
                    "school_count": len({item["school"] for item in programs}),
                    "predicted_rank_median": int(np.median([item["predicted_rank"] for item in programs])),
                }
            )
        return sorted(rows, key=lambda item: item["predicted_rank_median"])
