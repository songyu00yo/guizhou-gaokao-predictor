"""Attach explicitly scoped public policy references without inventing rates."""
from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path

from .data_pipeline import normalize_school
from .public_profiles import _read_cached

QUALIFICATION_URL = "https://yz.chsi.com.cn/kyzx/kp/202509/20250918/2293427403.html"
TRANSFER_URL = "https://eie.gzu.edu.cn/2026/0727/c19137a277977/page.htm"
OFFICIAL_ENTITIES = {
    "复旦大学医学院": ("上海市", "https://shmc.fudan.edu.cn/",
        "https://xxgk.fudan.edu.cn/ec/18/c5195a781336/page.htm", "复旦大学上海医学院",
        "复旦大学上海医学院是单独编制计划和录取的校内招生部分，毕业证书使用复旦大学名称；不作为独立高校。"),
    "山东大学威海分校": ("威海市", "https://bkzsw.wh.sdu.edu.cn/",
        "https://www.view.sdu.edu.cn/info/1003/2839.htm", "山东大学",
        "历史名称对应现山东大学（威海）/威海校区；保留校区招生项，不与其他校区混用资料。"),
    "西南大学(荣昌校区)": ("重庆市荣昌区", "https://bkzsw.swu.edu.cn/info/1067/2015.htm",
        "https://bkzsw.swu.edu.cn/info/1067/2015.htm", "荣昌",
        "西南大学荣昌校区，2026章程明确校区分别使用学校代码；不作为独立高校。"),
    "陆军军医大学": ("重庆市", "https://www.tmmu.edu.cn/",
        "https://zs.tmmu.edu.cn/", "陆军军医大学",
        "军籍与无军籍招生须分别核对；本系统只展示已纳入普通物理类本科首次投档表的记录，未核验军籍招生资格。"),
}


class SchoolTable(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.cells: list[str] = []
        self.names: set[str] = set()
        self.buffer: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "tr":
            self.cells = []
        elif tag == "td":
            self.buffer = []

    def handle_data(self, data: str) -> None:
        if self.buffer is not None:
            self.buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "td" and self.buffer is not None:
            self.cells.append("".join(self.buffer).strip())
            self.buffer = None
        elif tag == "tr" and len(self.cells) == 2 and self.cells[0] != "单位名称":
            self.names.add(normalize_school(self.cells[0]))


def attach_policy_notes(profiles: dict, raw_dir: Path, offline: bool = False) -> dict:
    report = {"qualification_matched": 0, "transfer_references": 0, "errors": []}
    root = raw_dir / "public_profiles" / "policies"
    report["official_entity_references"] = 0
    for school, (city, site, evidence, expected, scope) in OFFICIAL_ENTITIES.items():
        if school not in profiles:
            continue
        content, state = _read_cached(root / f"entity-{school}.html", evidence, offline=offline,
                                     year=None, license_name="高校官网公开资料，未声明开放许可")
        if not content or expected not in content.decode("utf-8", errors="replace"):
            report["errors"].append({"school": school, "reason": "官网主体或校区证据未通过核对"})
            continue
        profile = profiles[school]
        profile["headline"]["city"] = city
        profile["official"]["official_site"] = site
        profile["entity_scope"] = scope
        reference = {"title": "招生主体与校区范围（官网核对）", "type": "高校官网", "value": scope,
                     "source": "高校官网", "source_url": evidence, "retrieved_at": state.get("fetched_at"),
                     "status": "已核对", "confidence": "高", "license": "高校官网公开资料，未声明开放许可"}
        profile["sections"]["basic"].append(reference)
        profile["source_summary"].append(reference)
        profile["missing_fields"] = [key for key in profile.get("missing_fields", []) if key not in ("city", "official_site")]
        report["official_entity_references"] += 1
    content, state = _read_cached(root / "postgraduate-qualification-2025.html", QUALIFICATION_URL,
                                 offline=offline, year=2025, license_name="研招网公开名单，未声明开放许可")
    if content:
        text = content.decode("utf-8")
        parser = SchoolTable()
        parser.feed(text)
        if "2025推免高校名单" in text and len(parser.names) >= 200:
            for school, profile in profiles.items():
                if normalize_school(school) in parser.names:
                    profile["sections"]["development"].append({
                        "title": "推免资格（2025公开名单）", "value": "列入研招网2025推免高校名单；不代表个人保研概率或当年保研比例。",
                        "source": "中国研究生招生信息网", "source_url": QUALIFICATION_URL, "year": 2025,
                        "confidence": "高", "license": "公开名单，未声明开放许可"})
                    report["qualification_matched"] += 1
        else:
            report["errors"].append("研招网名单标题或学校数量未通过核对")
    else:
        report["errors"].append(state.get("error", "推免名单不可用"))
    content, state = _read_cached(root / "gzu-eie-transfer-2026.html", TRANSFER_URL,
                                 offline=offline, year=2026, license_name="高校公开政策，未声明开放许可")
    if content:
        text = content.decode("utf-8")
        if "2026年本科生转专业工作实施方案" in text and "贵州大学" in profiles:
            profiles["贵州大学"]["sections"]["development"].append({
                "title": "转专业官方参考（限指定学院）",
                "value": "大数据与信息工程学院2026年本科生转专业方案；适用学院、专业和条件以原文为准，不能推广到全校。",
                "source": "贵州大学大数据与信息工程学院", "source_url": TRANSFER_URL,
                "year": 2026, "confidence": "高", "license": "高校公开政策，未声明开放许可"})
            report["transfer_references"] += 1
    else:
        report["errors"].append(state.get("error", "转专业参考文件不可用"))
    return report
