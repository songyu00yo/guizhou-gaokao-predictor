from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app import app


def test_public_api_smoke_and_payload_budget() -> None:
    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["data_schema"] == 2
        assert "path" not in str(health.json()).lower()

        started = time.perf_counter()
        response = client.post("/api/v1/recommendations", json={"score": 500, "risk": "balanced"})
        elapsed = time.perf_counter() - started
        assert response.status_code == 200
        assert len(response.json()["list"]) == 96
        assert len(response.content) < 250_000
        assert elapsed < 0.4


def test_v1_rejects_deprecated_parameter_and_legacy_marks_it() -> None:
    with TestClient(app) as client:
        v1 = client.post(
            "/api/v1/recommendations",
            json={"score": 500, "risk": "balanced", "difficulty_delta": 0.1},
        )
        schema = client.get("/openapi.json").json()
        request_schema = schema["components"]["schemas"]["RecommendationRequest"]["properties"]
        assert "difficulty_delta" not in request_schema
        assert v1.status_code == 422

        legacy = client.post("/generate", json={"score": 500, "risk": "balanced", "difficulty_delta": 0.1})
        assert legacy.status_code == 200
        assert "difficulty_delta" in legacy.json()["deprecated_parameters"]


def test_live_verification_requires_admin_token() -> None:
    with TestClient(app) as client:
        response = client.get("/api/web-verify?live=true")
        assert response.status_code == 403
