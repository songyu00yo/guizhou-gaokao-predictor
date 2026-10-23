from __future__ import annotations

import csv
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.public_profiles import (
    COLLEGES_CHAT_LICENSE,
    COLLEGES_CHAT_NAV_URL,
    DAO_LICENSE,
    DAO_WIDE_URL,
    MOE_EXPECTED_DATE,
    MOE_EXPECTED_TITLE,
    MOE_LICENSE,
    MOE_XLS_URL,
    _parse_moe_rows,
    _read_cached,
    _make_review_rows,
    build_profiles,
)


def _csv(headers: list[str], rows: list[list[str]]) -> bytes:
    text = io.StringIO()
    writer = csv.writer(text)
    writer.writerow(headers)
    writer.writerows(rows)
    return text.getvalue().encode("utf-8")


def _write_cache(path: Path, url: str, data: bytes, year: int, license_name: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.with_suffix(path.suffix + ".meta.json").write_text(
        json.dumps(
            {
                "source_url": url,
                "year": year,
                "license": license_name,
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
                "fetched_at": 1234567890,
            }
        ),
        encoding="utf-8",
    )


_MOE_RECORDS = {
    "天津城建大学": {
        "school": "天津城建大学",
        "school_code": "4112010001",
        "department": "天津市",
        "location": "天津市",
        "tier": "本科",
    },
    "贵州大学": {
        "school": "贵州大学",
        "school_code": "4152010001",
        "department": "贵州省",
        "location": "贵阳市",
        "tier": "本科",
    },
    "贵州医科大学": {
        "school": "贵州医科大学",
        "school_code": "4152010002",
        "department": "贵州省",
        "location": "贵阳市",
        "tier": "本科",
    },
}


def _fake_moe_xls(_data: bytes) -> tuple[dict[str, dict[str, str]], dict[str, object]]:
    return _MOE_RECORDS, {"title": MOE_EXPECTED_TITLE, "date": MOE_EXPECTED_DATE, "roster_count": len(_MOE_RECORDS)}


class PublicProfilesTests(unittest.TestCase):
    def _seed_sources(self, raw_dir: Path) -> None:
        source = raw_dir / "public_profiles"
        moe_dir = source / "moe"
        dao_dir = source / "dao"
        chat_dir = source / "colleges-chat"
        moe_dir.mkdir(parents=True)
        dao_dir.mkdir(parents=True)
        chat_dir.mkdir(parents=True)

        _write_cache(moe_dir / "colleges-2026.xls", MOE_XLS_URL, b"mock verified xls", 2026, MOE_LICENSE)
        dao_data = _csv(
                ["学校名称", "所在城市", "学校性质", "办学层次", "学校类别", "学校官网", "双一流建设_第二轮_学科名单"],
                [
                    ["天津城建大学", "天津", "公办", "本科", "理工类", "https://www.tcu.edu.cn/", ""],
                    ["贵州大学", "贵阳", "公办", "本科", "综合类", "https://www.gzu.edu.cn/", "植物保护"],
                    ["贵州医科大学", "贵阳", "公办", "本科", "医药类", "https://www.gmc.edu.cn/", ""],
                ],
            )
        _write_cache(dao_dir / "university-wide-v20230118.csv", DAO_WIDE_URL, dao_data, 2023, DAO_LICENSE)
        nav = "\n".join(
            [
                "- 天津:",
                "  - 天津城建大学: universities/tian-jin-cheng-jian-da-xue.md",
                "  - 天津城建大学人文艺术学院: universities/tian-jin-cheng-jian-da-xue-ren-wen-yi-shu-xue-yuan.md",
            ]
        )
        _write_cache(chat_dir / "nav.txt", COLLEGES_CHAT_NAV_URL, nav.encode("utf-8"), 2026, COLLEGES_CHAT_LICENSE)
        (chat_dir / "universities").mkdir()
        page = """# 天津城建大学

> 数据来源：

<details><summary>来源</summary>
<ul>
<li>A12345: 匿名 (2025 年 06 月)</li>
</ul>
</details>

## Q: 宿舍如何？

- A12345: 宿舍有空调。私信我：13812345678，邮箱hello@example.com，我的QQ号12345678
"""
        _write_cache(
            chat_dir / "universities" / "tian-jin-cheng-jian-da-xue.md",
            "https://raw.githubusercontent.com/CollegesChat/university-information/079a5070420e14f8db42275d66f33eefab569042/docs/universities/tian-jin-cheng-jian-da-xue.md",
            page.encode("utf-8"),
            2026,
            COLLEGES_CHAT_LICENSE,
        )

    def test_builds_offline_profiles_with_exact_matches_and_citations(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            raw_dir = Path(temp)
            self._seed_sources(raw_dir)
            with patch("backend.public_profiles._read_moe_xls", side_effect=_fake_moe_xls):
                profiles, report = build_profiles(
                    ["天津城建大学", "贵州大学", "贵州医科大学"], raw_dir, offline=True
                )
            cached_page_path = (
                raw_dir
                / "public_profiles"
                / "colleges-chat"
                / "universities"
                / "tian-jin-cheng-jian-da-xue.md"
            )
            cached_page = cached_page_path.read_text(encoding="utf-8")
            self.assertIn("13812345678", cached_page)
            self.assertIn("hello@example.com", cached_page)

        self.assertEqual(report["profile_count"], 3)
        profile = profiles["天津城建大学"]
        self.assertEqual(profile["official_roster_2026"], "listed")
        self.assertEqual(report["sources"]["moe"]["roster_count"], 3)
        self.assertEqual(report["sources"]["moe"]["date"], MOE_EXPECTED_DATE)
        self.assertEqual(report["sources"]["moe"]["title"], MOE_EXPECTED_TITLE)
        self.assertEqual(profile["headline"]["city"], "天津市")
        self.assertEqual(profile["headline"]["ownership"], "公办")
        self.assertEqual(profile["official"]["official_site"], "https://www.tcu.edu.cn/")
        self.assertNotIn("tuition_range", profile["headline"])
        self.assertIn("tuition_range", profile["missing_fields"])
        self.assertEqual(len(profile["reviews"]), 1)
        review = profile["reviews"][0]
        self.assertIn("宿舍有空调", review["summary"])
        self.assertNotIn("13812345678", review["summary"])
        self.assertNotIn("hello@example.com", review["summary"])
        self.assertNotIn("12345678", review["summary"])
        self.assertEqual(review["date"], "2025 年 06 月")
        self.assertEqual(review["license"], "CC BY-NC-SA 4.0")
        self.assertIn("079a5070420e14f8db42275d66f33eefab569042", review["source_url"])
        self.assertEqual(profile["year"], 2026)
        self.assertTrue(profile["source_url"].startswith("https://www.moe.gov.cn/"))
        self.assertEqual(profile["review_count_total"], 1)
        self.assertEqual(profile["review_count_selected"], 1)
        self.assertIn("每题最多3条较新回答", profile["source_summary"][-1]["status"])
        strength = profiles["贵州大学"]["sections"]["major_strength"]
        self.assertEqual(len(strength), 1)
        self.assertEqual(strength[0]["value"], "植物保护")
        self.assertEqual(strength[0]["year"], 2023)
        self.assertEqual(strength[0]["program_year"], 2022)
        self.assertIn("不代表现行", strength[0]["status"])
        self.assertEqual(profiles["天津城建大学"]["sections"]["major_strength"], [])

    def test_missing_exact_matches_do_not_block_other_profiles(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            raw_dir = Path(temp)
            self._seed_sources(raw_dir)
            with patch("backend.public_profiles._read_moe_xls", side_effect=_fake_moe_xls):
                profiles, report = build_profiles(
                    ["天津城建大", "不存在大学"], raw_dir, offline=True
                )

        self.assertEqual(set(profiles), {"天津城建大", "不存在大学"})
        self.assertEqual(profiles["天津城建大"]["reviews"], [])
        self.assertEqual(profiles["不存在大学"]["reviews"], [])
        self.assertEqual(report["profile_count"], 2)
        self.assertIn("student_reviews", profiles["不存在大学"]["missing_fields"])

    def test_moe_parser_requires_title_and_cutoff_date(self) -> None:
        rows = [
            ["附件1："],
            ["全国普通高等学校名单"],
            ["（截至2026年6月17日）"],
            ["序号", "学校名称", "学校标识码", "主管部门", "所在地", "办学层次", "备注"],
            ["1", "测试大学", "1234567890", "教育部", "北京市", "本科", ""],
        ]
        roster, validation = _parse_moe_rows(rows)
        self.assertIn("测试大学", roster)
        self.assertEqual(validation["title"], MOE_EXPECTED_TITLE)
        self.assertEqual(validation["date"], MOE_EXPECTED_DATE)
        self.assertEqual(validation["roster_count"], 1)

        bad_date = [*rows[:2], ["（截至2025年6月17日）"], *rows[3:]]
        with self.assertRaisesRegex(ValueError, "日期不匹配"):
            _parse_moe_rows(bad_date)

    def test_offline_cache_requires_matching_metadata_hash_url_and_size(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "source.txt"
            path.write_bytes(b"raw")
            payload, metadata = _read_cached(
                path, "https://example.test/source.txt", offline=True, year=2026, license_name="test"
            )

        self.assertIsNone(payload)
        self.assertEqual(metadata["status"], "invalid_cache")
        self.assertIn("缺少元数据", metadata["error"])

    def test_review_rows_keep_three_newest_per_question_and_truncate_long_answers(self) -> None:
        long_answer = "x" * 2001
        payload = {
            "source_url": "https://example.test/school.md",
            "sources": [
                {"id": "A100", "date": "2025 年 06 月"},
                {"id": "A101", "date": "2025 年 06 月"},
                {"id": "A099", "date": "2023 年 12 月"},
                {"id": "A103", "date": ""},
                {"id": "B1", "date": ""},
                {"id": "B2", "date": "2022 年"},
            ],
            "questions": [
                {
                    "question": "宿舍如何？",
                    "answers": [
                        {"id": "A103", "text": "未知日期"},
                        {"id": "A099", "text": "较早回答"},
                        {"id": "A101", "text": "并列日期二"},
                        {"id": "A100", "text": long_answer},
                    ],
                },
                {
                    "question": "食堂如何？",
                    "answers": [
                        {"id": "B1", "text": "没有日期"},
                        {"id": "B2", "text": "有日期"},
                    ],
                },
            ],
        }

        reviews, total = _make_review_rows(payload)

        self.assertEqual(total, 6)
        self.assertEqual([review["source"] for review in reviews], ["A100", "A101", "A099", "B2", "B1"])
        self.assertTrue(reviews[0]["summary"].startswith("x" * 100))
        self.assertTrue(reviews[0]["summary"].endswith("（节选，完整回答见来源）"))
        self.assertEqual(len(reviews[0]["summary"]), 2000 + len("（节选，完整回答见来源）"))

    def test_valid_legacy_cache_without_byte_count_is_backfilled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "source.txt"
            url = "https://example.test/source.txt"
            data = b"trusted by url and sha"
            path.write_bytes(data)
            path.with_suffix(".txt.meta.json").write_text(
                json.dumps({"source_url": url, "sha256": hashlib.sha256(data).hexdigest()}),
                encoding="utf-8",
            )
            payload, metadata = _read_cached(
                path, url, offline=True, year=2026, license_name="test"
            )
            saved_meta = json.loads(path.with_suffix(".txt.meta.json").read_text(encoding="utf-8"))

        self.assertEqual(payload, data)
        self.assertEqual(metadata["bytes"], len(data))
        self.assertEqual(saved_meta["bytes"], len(data))

    def test_online_invalid_cache_retries_and_replaces_it(self) -> None:
        from urllib.error import URLError

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "source.txt"
            _write_cache(path, "https://example.test/wrong-url", b"old", 2026, "test")
            responses = [URLError("temporary outage"), URLError("temporary outage"), io.BytesIO(b"fresh")]
            with patch("urllib.request.urlopen", side_effect=responses) as fetch, patch(
                "backend.public_profiles.time.sleep"
            ):
                payload, metadata = _read_cached(
                    path, "https://example.test/source.txt", offline=False, year=2026, license_name="test"
                )
            self.assertEqual(fetch.call_count, 3)
            self.assertEqual(payload, b"fresh")
            self.assertEqual(metadata["bytes"], 5)
            self.assertEqual(metadata["source_url"], "https://example.test/source.txt")


if __name__ == "__main__":
    unittest.main()
