from pathlib import Path

from backend import public_policies


def profile() -> dict:
    return {"headline": {}, "official": {}, "sections": {"basic": [], "development": []},
            "source_summary": [], "missing_fields": ["city", "official_site", "ownership"]}


def test_policy_references_keep_campus_identity_and_qualification_scope(monkeypatch, tmp_path: Path) -> None:
    school_names = ["贵州大学", "复旦大学医学院", "复旦大学"]
    profiles = {name: profile() for name in school_names}
    rows = "".join(f"<tr><td>示例学校{i}</td><td>某省</td></tr>" for i in range(200))
    qualifier = ("2025推免高校名单<table>" + rows + "<tr><td>贵州大学</td><td>贵州省</td></tr></table>").encode()

    def source(_path, url, **kwargs):
        if url == public_policies.QUALIFICATION_URL:
            return qualifier, {"fetched_at": 1}
        if "fudan" in url:
            return "复旦大学上海医学院".encode(), {"fetched_at": 1}
        return None, {"error": "offline"}

    monkeypatch.setattr(public_policies, "_read_cached", source)
    result = public_policies.attach_policy_notes(profiles, tmp_path, offline=True)
    assert result["qualification_matched"] == 1
    assert profiles["贵州大学"]["sections"]["development"][0]["year"] == 2025
    assert profiles["复旦大学医学院"]["official"]["official_site"] == "https://shmc.fudan.edu.cn/"
    assert profiles["复旦大学"]["official"] == {}
    assert "ownership" in profiles["复旦大学医学院"]["missing_fields"]
