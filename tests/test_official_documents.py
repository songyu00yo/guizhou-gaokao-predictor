import json
from pathlib import Path

import pytest

from backend import official_documents as docs


def test_html_text_excludes_scripts_and_preserves_fee_table_rows():
    content = ('<h1>测试大学2026年招生章程</h1><script>转专业假内容</script>'
               '<p>为了规范普通本科招生，学校制定下列招生规定。' + '符合招生要求的考生均可报考。' * 30 + '</p>'
               '<table><tr><td>住宿费</td><td>1200元/学年</td></tr></table>').encode()
    record = {'school': '测试大学', 'year': 2026, 'kind': 'charter'}
    lines = docs.parse_document(content, record)
    assert '转专业假内容' not in '\n'.join(lines)
    assert '住宿费 | 1200元/学年' in lines
    with pytest.raises(ValueError):
        docs.parse_document(content, {**record, 'year': 2027})


def test_official_references_preserve_year_and_cohort_scope(monkeypatch, tmp_path: Path):
    document = {'school': '测试大学', 'year': 2026, 'kind': 'transfer',
                'title': '测试大学2025级转专业工作方案', 'url': 'https://test.edu.cn/2026/transfer.html',
                'scope': '仅适用于2025级计算机学院学生',
                'expected_phrases': ['测试大学2025级转专业工作方案', '2026年']}
    registry = tmp_path / 'registry.json'
    registry.write_text(json.dumps([document]), encoding='utf-8')
    content = ('<h1>测试大学2025级转专业工作方案</h1><p>发布时间：2026年6月</p>'
               '<p>申请条件：' + '转入学生须满足本学院所列全部条件，按原文审核。' * 20 + '</p>').encode()
    monkeypatch.setattr(docs, '_read_cached', lambda *a, **k: (content, {'sha256': 'verified', 'fetched_at': 1}))
    profiles = {'测试大学': {'sections': {}, 'source_summary': []}}
    report = docs.attach_official_documents(profiles, tmp_path, offline=True, registry_paths=[registry])
    assert report['verified_documents'] == 1
    row = profiles['测试大学']['sections']['development'][0]
    assert row['year'] == 2026
    assert row['scope'] == document['scope']
    assert row['sha256'] == 'verified'
    assert '2027' not in row['value']
    assert 'tuition_range' not in profiles['测试大学']


def test_unofficial_host_and_wrong_identity_cannot_fill_profile(monkeypatch, tmp_path: Path):
    registry = tmp_path / 'registry.json'
    registry.write_text(json.dumps([{'school': '目标大学', 'year': 2026, 'kind': 'charter',
        'url': 'https://example.com/article', 'title': '目标大学招生章程'}]), encoding='utf-8')
    def no_network(*a, **k):
        raise AssertionError('unapproved domain should not be fetched')
    monkeypatch.setattr(docs, '_read_cached', no_network)
    profiles = {'目标大学': {'sections': {}, 'source_summary': []}}
    report = docs.attach_official_documents(profiles, tmp_path, registry_paths=[registry])
    assert report['verified_documents'] == 0
    assert len(report['errors']) == 1
    assert profiles['目标大学']['sections'] == {}


def test_fee_validation_keeps_nested_table_cells_and_rejects_substring_major(monkeypatch, tmp_path: Path):
    document = {'school': '测试大学', 'year': 2026, 'kind': 'fees', 'title': '测试大学2026学费公示',
        'url': 'https://test.edu.cn/fees', 'fees_rows': [
            {'major': '药学', 'tuition': 4200, 'currency': 'CNY', 'unit': '元/年', 'scope': '普通本科'},
            {'major': '药学', 'tuition': 4500, 'currency': 'CNY', 'unit': '元/年', 'scope': '普通本科'},
            {'major': '医学影像技术', 'tuition': 18000, 'currency': 'CNY', 'unit': '元/年', 'scope': '普通本科'},
        ]}
    registry = tmp_path / 'registry.json'
    registry.write_text(json.dumps([document]), encoding='utf-8')
    content = ('<h1>测试大学2026学费公示</h1><p>' + '收费项目须按公开标准执行，具体专业标准如表。'*30 + '</p>'
        '<table><tr><td><p>药学、中药学</p></td><td><p>4200元/年</p></td></tr>'
        '<tr><td>临床药学</td><td>4500元/年</td></tr>'
        '<tr><td>医学影像技术(中外合作)</td><td>18000元/年</td></tr></table>').encode()
    monkeypatch.setattr(docs, '_read_cached', lambda *a, **k: (content, {'sha256': 'hash', 'fetched_at': 1}))
    profiles = {'测试大学': {'sections': {}, 'source_summary': []}}
    docs.attach_official_documents(profiles, tmp_path, registry_paths=[registry])
    fees = profiles['测试大学']['official_documents'][0]['tuition_rows']
    assert [(row['major'], row['tuition']) for row in fees] == [('药学', '4200')]


def test_exact_major_fee_fills_missing_and_keeps_existing_conflict():
    supplement = {'schools': {'测试大学': {'official_documents': [{
        'year': 2026, 'source_url': 'https://test.edu.cn/fees', 'sha256': 'hash', 'scope': '普通本科',
        'tuition_rows': [{'major': '药学', 'tuition': '4200'}, {'major': '化学', 'tuition': '5000'}],
    }]}}, 'programs': {'a': {'missing_fields': ['tuition']}, 'b': {'tuition': '4500'}}, 'coverage': {}}
    forecasts = [{'school': '测试大学', 'major': '药学', 'unit_id': 'a'},
                 {'school': '测试大学', 'major': '化学', 'unit_id': 'b'}]
    report = docs.attach_verified_tuitions(supplement, forecasts)
    assert report['filled'] == 1
    assert supplement['programs']['a']['tuition'] == '4200'
    assert supplement['programs']['a']['missing_fields'] == []
    assert supplement['programs']['b']['tuition'] == '4500'
    assert len(report['conflicts']) == 1
