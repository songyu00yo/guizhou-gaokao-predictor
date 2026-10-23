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
