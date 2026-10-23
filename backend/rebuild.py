"""Prepare public inputs, rebuild in isolation, and explicitly activate a validated package."""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import urllib.request
import time
from datetime import datetime, timezone
from pathlib import Path

from .catalog_pipeline import build_catalogs
from .data_pipeline import OFFICIAL_OUTCOME_SOURCES, OUTCOME_FILENAME, build_official_dataset
from .public_sources import SEGMENT_SOURCES, fetch_source, parse_segment_pdf
from .runtime_store import RuntimeStore

ROOT = Path(__file__).resolve().parents[1]
CATALOG_SOURCES = {
    2024: 'https://iip.oss-cn-guiyang-gzdata-d01-a.res.gzdata.com.cn/2024/06/24/W0202406241052%E8%B4%B5%E5%B7%9E%E7%9C%812024%E5%B9%B4%E6%99%AE%E9%80%9A%E9%AB%98%E6%A0%A1%E6%8B%9B%E7%94%9F%E4%B8%93%E4%B8%9A%E7%9B%AE%E5%BD%95%EF%BC%88%E7%89%A9%E7%90%86%E7%B1%BB%EF%BC%89.pdf.pdf',
    2025: "https://iip.oss-cn-guiyang-gzdata-d01-a.res.gzdata.com.cn/2025/06/23/"
          "W0202506231327%E8%B4%B5%E5%B7%9E%E7%9C%812025%E5%B9%B4%E6%99%AE%E9%80%9A%E9%AB%98%E6%A0%A1%E6%8B%9B%E7%94%9F%E4%B8%93%E4%B8%9A%E7%9B%AE%E5%BD%95%EF%BC%88%E7%89%A9%E7%90%86%E7%B1%BB%EF%BC%89.pdf",
    2026: "https://iip.oss-cn-guiyang-gzdata-d01-a.res.gzdata.com.cn/2026/06/22/W0194220_2026.pdf",
}
PUBLICATION_DATES = {2024: "2024-07-23", 2025: "2025-07-22", 2026: "2026-07-22"}
CUTOFF_SCORES = {2024: 380, 2025: 387, 2026: 393}
CUTOFF_SOURCE = "https://gyzkzx.cn/html/2026-06/25/content_939383.htm"


def cache_notice(raw_dir: Path, offline: bool) -> dict:
    from .public_supplement import CORRECTION_URL
    path = raw_dir / "catalog_corrections_2026.html"
    meta_path = path.with_suffix(".source.json")
    if path.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        if meta.get("sha256") == file_record(path)["sha256"] and meta.get("url") == CORRECTION_URL:
            return meta
    if offline:
        raise RuntimeError("缺少招生目录更正公告的有效缓存")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(CORRECTION_URL, timeout=25) as response:
                data = response.read(2_000_000)
            text = data.decode("utf-8")
            if "2026年" not in text or "学费统一调整为免费" not in text or "吉林工程技术师范学院" not in text:
                raise ValueError("更正公告正文未通过内容核对")
            path.write_bytes(data)
            meta = {**file_record(path), "url": CORRECTION_URL, "kind": "catalog_corrections", "year": 2026,
                    "published_at": "2026-06-26", "retrieved_at": datetime.now(timezone.utc).isoformat()}
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            return meta
        except Exception:
            if attempt == 2:
                raise
            time.sleep(0.2)
    raise AssertionError("unreachable")


def file_record(path: Path) -> dict:
    return {"name": path.name, "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def activate_package(artifact_dir: Path, root: Path = ROOT) -> None:
    runtime = RuntimeStore(artifact_dir.resolve())
    for risk in ("balanced", "conservative", "aggressive"):
        if len(runtime.recommend(500, None, risk)["list"]) != 96:
            raise RuntimeError("新运行包未返回 96 项推荐，拒绝启用")
    active = root / "var" / "runtime" / "active.json"
    active.parent.mkdir(parents=True, exist_ok=True)
    temporary = active.with_suffix(".tmp")
    temporary.write_text(json.dumps({"artifact_dir": str(artifact_dir.resolve()),
                                     "activated_at": datetime.now(timezone.utc).isoformat()}, indent=2), encoding="utf-8")
    os.replace(temporary, active)


def prepare_inputs(raw_dir: Path, processed_dir: Path, offline: bool = False) -> list[dict]:
    from .backtest import YEAR_RANK_SCALE
    processed_dir.mkdir(parents=True, exist_ok=True)
    sources = [cache_notice(raw_dir, offline)]
    for year, url in OFFICIAL_OUTCOME_SOURCES.items():
        metadata = fetch_source(url, raw_dir / OUTCOME_FILENAME.format(year=year), offline=offline)
        sources.append({k: v for k, v in metadata.items() if k not in ("path", "reused")}
                       | {"kind": "first_round_admissions", "year": year,
                          "published_at": PUBLICATION_DATES[year]})
    for year, url in CATALOG_SOURCES.items():
        metadata = fetch_source(url, raw_dir / f"{year}_physics_catalog.pdf", offline=offline)
        sources.append({k: v for k, v in metadata.items() if k not in ("path", "reused")}
                       | {"kind": "catalog", "year": year, "published_at": f"{year}-06-{ {2024: 24, 2025: 23, 2026: 22}[year]}"})
    for year, url in SEGMENT_SOURCES.items():
        path = raw_dir / f"segment_{year}.pdf"
        metadata = fetch_source(url, path, offline=offline)
        segment = parse_segment_pdf(path, year)
        cutoff = next(r for r in segment["rows"] if r["score"] == CUTOFF_SCORES[year])
        if cutoff["rank_high"] != YEAR_RANK_SCALE[year]:
            raise RuntimeError(f"{year} 本科线位次与训练尺度不一致")
        segment["undergraduate_cutoff"] = {"score": CUTOFF_SCORES[year], "rank_high": cutoff["rank_high"],
                                            "source_url": CUTOFF_SOURCE if year == 2026 else url}
        (processed_dir / f"segment_{year}.json").write_text(json.dumps(segment, ensure_ascii=False), encoding="utf-8")
        sources.append({k: v for k, v in metadata.items() if k not in ("path", "reused")}
                       | {"kind": "score_bands", "year": year, "published_at": f"{year}-06-{26 if year == 2024 else 25}",
                          "mirror": year == 2025})
    # Only skip parsing when the exact inputs AND parser source have already passed validation.
    fingerprint = hashlib.sha256(json.dumps(sources, sort_keys=True).encode()).hexdigest()
    for filename, module, outputs, builder in (
        ("outcome-inputs.json", "data_pipeline.py", [f"admissions_{y}.csv" for y in (2024, 2025, 2026)],
         lambda: build_official_dataset(raw_dir, processed_dir)),
        ("catalog-inputs.json", "catalog_pipeline.py", [f"catalog_plans_{y}.csv" for y in (2024, 2025, 2026)],
         lambda: build_catalogs(raw_dir, processed_dir, (2024, 2025, 2026))),
    ):
        marker = processed_dir / filename
        expected = {"inputs": fingerprint, "parser": file_record(Path(__file__).with_name(module))["sha256"]}
        previous = json.loads(marker.read_text()) if marker.exists() else {}
        valid = previous.get("fingerprint") == expected and all((processed_dir / n).is_file() for n in outputs)
        if valid:
            valid = previous.get("outputs") == [file_record(processed_dir / n) for n in outputs]
        if not valid:
            logging.info("Parsing %s", module)
            builder()
            marker.write_text(json.dumps({"fingerprint": expected,
                                          "outputs": [file_record(processed_dir / n) for n in outputs]}), encoding="utf-8")
    (processed_dir / "public_sources.json").write_text(json.dumps(sources, ensure_ascii=False, indent=2), encoding="utf-8")
    return sources


def enrich_package(artifact_dir: Path, processed_dir: Path, raw_dir: Path, offline: bool = False) -> dict:
    from .public_profiles import build_profiles
    from .public_policies import attach_policy_notes
    from .official_documents import attach_official_documents, attach_verified_tuitions
    from .major_taxonomy import attach_major_taxonomy
    from .public_supplement import build_supplement, write_supplement
    payload = json.loads((artifact_dir / "predictions_2027.json").read_text(encoding="utf-8"))
    schools = sorted({row["school"] for row in payload["forecasts"]})
    profiles, report = build_profiles(schools, raw_dir / "profiles", offline=offline)
    report["policies"] = attach_policy_notes(profiles, raw_dir / "profiles", offline)
    report["official_documents"] = attach_official_documents(profiles, raw_dir / "profiles", offline=offline)
    sources_path = processed_dir / "public_sources.json"
    sources = json.loads(sources_path.read_text(encoding="utf-8")) if sources_path.exists() else []
    metadata_paths = [*sorted((raw_dir / "profiles").rglob("*.meta.json")), *sorted((raw_dir / "collections").rglob("*.meta.json"))]
    for metadata_path in metadata_paths:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("sha256") and metadata.get("source_url"):
            sources.append({k: v for k, v in metadata.items() if k in (
                "source_url", "year", "license", "sha256", "bytes", "fetched_at", "retrieved_at", "final_url")})
    distinct_sources = {}
    for source in sources:
        identity = (source.get("source_url", source.get("url")), source.get("sha256"))
        combined = distinct_sources.setdefault(identity, {})
        for key, value in source.items():
            if combined.get(key) in (None, "") and value not in (None, ""):
                combined[key] = value
    sources = list(distinct_sources.values())
    gaps = [{"kind": "legacy_comparison", "reason": "原算法冻结快照未公开，无法复现旧版对比"},
            {"kind": "2027_official_data", "reason": "2027 年正式招生目录和一分一段表尚未发布"}]
    if report.get("gaps"):
        gaps.extend(report["gaps"])
    supplement = build_supplement(processed_dir, payload["forecasts"], profiles, sources, gaps)
    report["individual_tuition_verification"] = attach_verified_tuitions(supplement, payload["forecasts"])
    report["major_taxonomy"] = attach_major_taxonomy(supplement, payload["forecasts"], raw_dir / "profiles", offline=offline)
    coverage = supplement["coverage"]
    coverage.update({
        "schools_with_official_documents": sum(bool(p.get("official_documents")) for p in profiles.values()),
        "official_documents": report["official_documents"]["verified_documents"],
        "programs_with_major_reference": report["major_taxonomy"].get("programs_exact_major_matched", 0),
        "programs_with_major_category_reference": report["major_taxonomy"].get("programs_category_matched", 0),
    })
    if report["official_documents"].get("errors"):
        gaps.append({"kind": "official_document_sources", "records": report["official_documents"]["errors"],
                     "reason": "来源不可达、正文不可提取或身份年份未通过核验"})
    for field, total_field in (("schools_with_basic", "schools_total"), ("schools_with_life", "schools_total"),
                               ("schools_with_official_site", "schools_total"),
                               ("programs_with_history_2024", "programs_total"),
                               ("programs_with_history_2025", "programs_total"),
                               ("programs_with_tuition", "programs_total"),
                               ("programs_with_subject_requirement", "programs_total")):
        if coverage[field] < coverage[total_field]:
            gaps.append({"kind": field, "missing_count": coverage[total_field] - coverage[field],
                         "reason": "公开来源未提供或无法唯一匹配，保留缺失状态"})
    for field in ("development",):
        missing = sum(not p.get("sections", {}).get(field) for p in profiles.values())
        if missing:
            gaps.append({"kind": "employment_transfer_and_postgraduate_policies", "missing_count": missing,
                         "reason": "尚未形成可逐校核实的对应年度就业、转专业和保研政策数据集"})
    supplement["gaps"] = gaps
    supplement["profile_report"] = report
    write_supplement(artifact_dir / "supplement.json", supplement)
    manifest_path = artifact_dir / "runtime_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"] = [r for r in manifest["files"] if r["name"] != "supplement.json"]
    manifest["files"].append(file_record(artifact_dir / "supplement.json"))
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (artifact_dir / "coverage_report.json").write_text(json.dumps({"coverage": supplement["coverage"],
        "gaps": gaps, "profiles": report}, ensure_ascii=False, indent=2), encoding="utf-8")
    forecast_by_id = {row["unit_id"]: row for row in payload["forecasts"]}
    missing_programs = []
    pending_fee_count = 0
    for unit_id, entry in supplement["programs"].items():
        forecast = forecast_by_id[unit_id]
        if entry.get("tuition") in {"待定", "待公布", "待审批"}:
            pending_fee_count += 1
        missing = [field for field in ("tuition", "subject_requirement") if not entry.get(field)]
        if missing:
            missing_programs.append({"unit_id": unit_id, "school": forecast["school"], "major": forecast["major"],
                "school_code": forecast["school_code"], "major_code": forecast["major_code"], "year": 2026,
                "missing_fields": missing, "status": "needs_individual_verification",
                "reason": "综合目录未能精确唯一匹配，或单校公开资料尚未取得完整可核验正文",
                "official_site": profiles.get(forecast["school"], {}).get("official", {}).get("official_site")})
    audit = {"coverage": coverage, "official_catalogs": json.loads((processed_dir / "catalog_manifest.json").read_text())
            if (processed_dir / "catalog_manifest.json").exists() else {},
        "individual_source_report": report["official_documents"],
        "individual_tuition_report": report["individual_tuition_verification"],
        "pending_official_fee_count": pending_fee_count, "missing_programs": missing_programs,
        "school_information": [{"school": name, "category": profile.get("headline", {}).get("category"),
            "ownership": profile.get("headline", {}).get("ownership"),
            "official_documents": len(profile.get("official_documents", [])),
            "missing_fields": profile.get("missing_fields", [])} for name, profile in sorted(profiles.items())],
        "prediction_data_changed": False, "model_retrained": False}
    (artifact_dir / "information_audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    RuntimeStore(artifact_dir)
    return supplement["coverage"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--train", action="store_true", help="重新选择模型、回测并训练")
    parser.add_argument("--enrich", action="store_true", help="给指定的运行包补建公开资料")
    parser.add_argument("--activate", action="store_true", help="校验后启用指定运行包；重启服务生效")
    parser.add_argument("--artifact-dir", type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    artifact_dir = args.artifact_dir or ROOT / "var" / "runtime" / datetime.now().strftime("build-%Y%m%d-%H%M%S")
    if args.enrich and not args.train:
        active = ROOT / "var" / "runtime" / "active.json"
        if active.exists() and Path(json.loads(active.read_text())["artifact_dir"]).resolve() == artifact_dir.resolve():
            candidate_dir = ROOT / "var" / "runtime" / datetime.now().strftime("enriched-%Y%m%d-%H%M%S")
            shutil.copytree(artifact_dir, candidate_dir)
            artifact_dir = candidate_dir
            logging.info("Enriching an isolated copy of the active package: %s", artifact_dir)
    raw_dir, processed_dir = ROOT / "data" / "raw" / "official", ROOT / "data" / "processed"
    if args.train or args.enrich or not args.activate:
        prepare_inputs(raw_dir, processed_dir, args.offline)
    if args.train:
        from .train_forecast import train_and_forecast
        train_and_forecast(processed_dir, artifact_dir, ROOT / ".runtime-cache" / "data-store-v2.json")
    if args.train or args.enrich:
        logging.info("Coverage: %s", enrich_package(artifact_dir, processed_dir, ROOT / "data" / "raw", args.offline))
    if args.activate:
        if not (args.train or args.enrich) and args.artifact_dir is None:
            parser.error("仅启用已有运行包时必须指定 --artifact-dir")
        activate_package(artifact_dir)
        logging.info("Activated %s; restart the web service", artifact_dir)


if __name__ == "__main__":
    main()
