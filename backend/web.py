from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from colleges_chat import get_colleges_chat_service

from .logo_service import LogoService
from .runtime_store import RuntimeStore


APP_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = APP_DIR / "static"
RUNTIME_CACHE_DIR = Path(os.environ.get("GZ_RUNTIME_CACHE_DIR", APP_DIR / "var" / "cache")).resolve()


class RecommendationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    score: int = Field(..., ge=0, le=750)
    current_rank: int | None = Field(default=None, ge=1)
    risk: str = Field(default="balanced", pattern="^(conservative|balanced|aggressive)$")


class LegacyRecommendationRequest(RecommendationRequest):
    difficulty_delta: float | None = Field(default=None, ge=0, le=0.35)


class LogoBatchRequest(BaseModel):
    schools: list[str] = Field(default_factory=list, max_length=20)


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: int) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            events = self._events[key]
            while events and now - events[0] > self.window_seconds:
                events.popleft()
            if len(events) >= self.limit:
                return False
            events.append(now)
            return True


def _load_private_profiles() -> dict[str, Any]:
    path_text = os.environ.get("GZ_PRIVATE_PROFILE_FILE", "").strip()
    if not path_text:
        return {}
    try:
        payload = json.loads(Path(path_text).expanduser().read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.store = RuntimeStore.from_environment(APP_DIR)
    app.state.logos = LogoService(RUNTIME_CACHE_DIR / "logos")
    app.state.private_profiles = _load_private_profiles()
    app.state.colleges_chat = get_colleges_chat_service(RUNTIME_CACHE_DIR / "colleges-chat")
    # 一次推荐需要 5 批（每批 20 个）校徽请求，5 次/分钟会让用户刷新一次就 429；
    # 这里放宽到 30 次/分钟，仍能挡住刷接口的行为。
    app.state.logo_limiter = SlidingWindowLimiter(limit=30, window_seconds=60)
    yield


def create_app() -> FastAPI:
    application = FastAPI(
        title="贵州高考志愿预测系统（物理类）",
        version="0.2.0",
        lifespan=lifespan,
    )
    application.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6)
    application.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    def store(request: Request) -> RuntimeStore:
        return request.app.state.store

    @application.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @application.get("/favicon.ico")
    def favicon() -> Response:
        return Response(status_code=204)

    @application.get("/api/health")
    def health(request: Request) -> dict[str, Any]:
        runtime = store(request)
        return {
            "status": "ok",
            "service_version": application.version,
            "data_schema": runtime.manifest["schema_version"],
            "target_year": runtime.manifest["target_year"],
            "candidate_count": len(runtime.programs),
            "model_route": runtime.payload["model_route"],
        }

    @application.get("/api/v1/model-report")
    @application.get("/api/model-report", include_in_schema=False)
    def model_report(request: Request) -> dict[str, Any]:
        return store(request).report

    @application.post("/api/v1/recommendations")
    def recommendations(payload: RecommendationRequest, request: Request) -> dict[str, Any]:
        return store(request).recommend(payload.score, payload.current_rank, payload.risk)

    @application.post("/generate", include_in_schema=False)
    def legacy_recommendations(payload: LegacyRecommendationRequest, request: Request) -> dict[str, Any]:
        result = store(request).recommend(payload.score, payload.current_rank, payload.risk)
        if payload.difficulty_delta is not None:
            result = {
                **result,
                "deprecated_parameters": ["difficulty_delta"],
                "summary": {**result["summary"], "deprecated_parameters": ["difficulty_delta"]},
            }
        return result

    @application.get("/api/v1/recommendations/{unit_id}")
    @application.get("/api/detail/{unit_id}", include_in_schema=False)
    def recommendation_detail(
        unit_id: str,
        request: Request,
        score: int = Query(..., ge=0, le=750),
        current_rank: int | None = Query(default=None, ge=1),
        risk: str = Query(default="balanced", pattern="^(conservative|balanced|aggressive)$"),
        difficulty_delta: float | None = Query(default=None, include_in_schema=False),
    ) -> dict[str, Any]:
        try:
            return store(request).detail(unit_id, score, current_rank, risk)
        except KeyError:
            raise HTTPException(status_code=404, detail="没有找到该预测单元")

    @application.get("/api/catalog/schools")
    def catalog_schools(request: Request) -> dict[str, Any]:
        rows = store(request).catalog_schools()
        return {"list": rows, "total": len(rows)}

    @application.get("/api/catalog/majors")
    def catalog_majors(request: Request) -> dict[str, Any]:
        rows = store(request).catalog_majors()
        return {"list": rows, "total": len(rows)}

    @application.get("/api/admissions")
    def admissions(request: Request, limit: int = Query(default=500, ge=1, le=5000)) -> dict[str, Any]:
        runtime = store(request)
        rows = [
            {
                "school": item["school"],
                "major": item["major"],
                "score_2026": item["score_2026"],
                "rank_2026": item["rank_2026"],
                "plan_2026": item.get("plan_2026"),
                "admitted_2026": item.get("admitted_2026"),
                "predicted_rank_2027": item["predicted_rank"],
            }
            for item in runtime.programs[:limit]
        ]
        return {"list": rows, "total": len(runtime.programs)}

    @application.get("/api/school-profile/{school_name}")
    def school_profile(
        school_name: str,
        request: Request,
        fetch_logo: bool = Query(default=False),
    ) -> dict[str, Any]:
        try:
            profile = store(request).school_profile(school_name)
        except KeyError:
            raise HTTPException(status_code=404, detail="没有找到该院校")
        private = request.app.state.private_profiles.get(school_name)
        if isinstance(private, dict):
            profile.update(private)
        profile["asset"] = request.app.state.logos.get(school_name, fetch=fetch_logo)
        return profile

    @application.get("/api/school-guide/{school_name}")
    @application.get("/api/school-ladder/{school_name}")
    def private_profile(school_name: str, request: Request) -> dict[str, Any]:
        payload = request.app.state.private_profiles.get(school_name)
        return payload if isinstance(payload, dict) else {"available": False, "school": school_name}

    @application.get("/api/resources/summary")
    def resources_summary(request: Request) -> dict[str, Any]:
        runtime = store(request)
        return {
            "available": True,
            "public_runtime": True,
            "candidate_count": len(runtime.programs),
            "school_count": len(runtime.school_index),
            "major_count": len(runtime.major_index),
            "private_profiles": len(request.app.state.private_profiles),
            "data_schema": runtime.manifest["schema_version"],
            "coverage": runtime.supplement.get("coverage", {}),
            "sources": runtime.supplement.get("sources", []),
            "gaps": runtime.supplement.get("gaps", []),
        }

    def _client_key(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    @application.post("/api/school-assets/batch")
    def school_assets_batch(payload: LogoBatchRequest, request: Request) -> dict[str, Any]:
        if not request.app.state.logo_limiter.allow(_client_key(request)):
            raise HTTPException(status_code=429, detail="校徽获取请求过于频繁", headers={"Retry-After": "60"})
        schools = list(dict.fromkeys(payload.schools))
        if not schools:
            return {"assets": {}}
        assets: dict[str, Any] = {}
        with ThreadPoolExecutor(max_workers=min(4, len(schools))) as executor:
            futures = {school: executor.submit(request.app.state.logos.get, school, fetch=True) for school in schools}
            for school, future in futures.items():
                assets[school] = future.result()
        return {"assets": assets}

    @application.get("/api/school-assets/{school_name}")
    def school_asset(school_name: str, request: Request, fetch: bool = Query(default=False)) -> dict[str, Any]:
        if fetch and not request.app.state.logo_limiter.allow(_client_key(request)):
            raise HTTPException(status_code=429, detail="校徽获取请求过于频繁", headers={"Retry-After": "60"})
        return request.app.state.logos.get(school_name, fetch=fetch)

    @application.get("/api/school-logo/{filename}")
    def school_logo(filename: str, request: Request) -> FileResponse:
        path = request.app.state.logos.file(filename)
        if path is None:
            raise HTTPException(status_code=404, detail="校徽缓存不存在")
        return FileResponse(path, headers={"Cache-Control": "public, max-age=2592000, immutable"})

    @application.get("/api/colleges-chat/search")
    def colleges_chat_search(request: Request, q: str = Query(default=""), limit: int = Query(default=20, ge=1, le=50)) -> dict[str, Any]:
        return request.app.state.colleges_chat.search(q, limit)

    @application.get("/api/colleges-chat/{school_name}")
    def colleges_chat_school(school_name: str, request: Request) -> dict[str, Any]:
        public = store(request).supplement.get("schools", {}).get(school_name)
        if public is not None:
            reviews = public.get("reviews", [])
            grouped: dict[str, list] = {}
            for review in reviews:
                grouped.setdefault(review["title"], []).append({"id": review.get("source", "匿名"),
                    "text": review["summary"], "date": review.get("date", "")})
            first = reviews[0] if reviews else {}
            return {"available": bool(reviews), "status": "ready" if reviews else "not_found", "school": school_name,
                    "questions": [{"question": title, "answers": answers} for title, answers in grouped.items()],
                    "question_count": len(grouped), "answer_count": len(reviews), "source_count": len({r.get("source") for r in reviews}),
                    "source_url": first.get("source_url", ""), "license": first.get("license", "CC BY-NC-SA 4.0"),
                    "license_url": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
                    "source_version": first.get("source_version", ""),
                    "last_updated": max((r.get("date", "") for r in reviews), default=""),
                    "cache_status": "runtime_package", "message": "公开资料中没有精确匹配的院校问卷" if not reviews else "",
                    "disclaimer": "学生问卷反馈，联系方式已省略；请核对日期和校区，不代表学校官方承诺。"}
        return request.app.state.colleges_chat.get_school(school_name)

    @application.get("/api/web-verify")
    def web_verify(
        request: Request,
        live: bool = Query(default=False),
        x_admin_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        if not live:
            return {"status": "cached", "sources": ["贵州省招生考试院", "阳光高考"]}
        expected = os.environ.get("GZ_ADMIN_TOKEN", "")
        if not expected or x_admin_token != expected:
            raise HTTPException(status_code=403, detail="实时核查需要管理员令牌")
        results = []
        for url in ("https://zsksy.guizhou.gov.cn/", "https://gaokao.chsi.com.cn/"):
            try:
                with urllib.request.urlopen(url, timeout=5) as response:
                    results.append({"url": url, "reachable": response.status < 500})
            except Exception:
                results.append({"url": url, "reachable": False})
        return {"status": "live", "results": results}

    @application.get("/api/agents", include_in_schema=False)
    def legacy_diagnostics(request: Request) -> dict[str, Any]:
        runtime = store(request)
        return {
            "deprecated": True,
            "components": {
                "runtime_data": "ready",
                "prediction_model": runtime.payload["model_route"],
                "calibration": "ready",
            },
        }

    @application.get("/api/ocr", include_in_schema=False)
    def legacy_ocr() -> dict[str, Any]:
        return {"available": False, "message": "OCR 属于离线训练流程，公开运行服务不暴露本机文件。"}

    return application


app = create_app()
