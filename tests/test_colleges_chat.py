from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import app
import backend.web
from colleges_chat import parse_colleges_chat_markdown, parse_colleges_chat_nav


class CollegesChatParsingTests(unittest.TestCase):
    def test_parse_nav_keeps_current_universities(self) -> None:
        nav = """
    - 贵州:
      - 贵州中医药时珍学院: universities/gui-zhou-zhong-yi-yao-shi-zhen-xue-yuan.md
      - 归档学校 (已归档): archived/universities/archived-school.md
"""
        rows = parse_colleges_chat_nav(nav)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["school"], "贵州中医药时珍学院")
        self.assertEqual(rows[0]["normalized"], "贵州中医药时珍学院")
        self.assertEqual(rows[0]["path"], "universities/gui-zhou-zhong-yi-yao-shi-zhen-xue-yuan.md")

    def test_parse_markdown_extracts_sources_questions_and_free_notes(self) -> None:
        markdown = """
# 北京大学

> 数据来源：

<details><summary>点击展开</summary>
<ul>
<li>A16924: 匿名 (2023 年 03 月)</li>
<li>A34077: 匿名 (2026 年 06 月)</li>
</ul>
</details>

## Q: 宿舍是上床下桌吗？

- A16924: 不是

- A34077: 大部分不是，有一批新建宿舍是上床下桌

## Q: 教室和宿舍有没有空调？

- A16924: 有
  宿舍不能制热只能制冷

## 自由补充部分

A34077: 全国最自由的大学
"""
        payload = parse_colleges_chat_markdown(markdown, "universities/bei-jing-da-xue.md")
        self.assertTrue(payload["available"])
        self.assertEqual(payload["school"], "北京大学")
        self.assertEqual(payload["source_count"], 2)
        self.assertEqual(payload["question_count"], 3)
        self.assertEqual(payload["answer_count"], 4)
        self.assertEqual(payload["latest_response_date"], "2026 年 06 月")
        self.assertIn("宿舍不能制热", payload["questions"][1]["answers"][0]["text"])


class FakeCollegesChatService:
    def get_school(self, school_name: str) -> dict[str, object]:
        return {
            "available": False,
            "status": "not_found",
            "school": school_name,
            "questions": [],
            "message": "CollegesChat 当前院校索引中没有匹配到该院校。",
        }

    def search(self, query: str, limit: int = 20) -> dict[str, object]:
        return {"query": query, "count": 0, "list": []}


class CollegesChatRouteTests(unittest.TestCase):
    def test_route_returns_not_found_payload_without_breaking_api(self) -> None:
        with patch.object(backend.web, "get_colleges_chat_service", return_value=FakeCollegesChatService()):
            with TestClient(app.app) as client:
                response = client.get("/api/colleges-chat/不存在大学")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["available"])
        self.assertEqual(payload["status"], "not_found")


if __name__ == "__main__":
    unittest.main()
