import pytest
from backend.major_taxonomy import parse_major_pages


def test_major_taxonomy_keeps_national_code_separate_from_school_admission_code():
    data = parse_major_pages(['普通高等学校本科专业目录（2026年）', '',
        '08 学科门类：工学\n0809 计算机类\n080901 计算机科学与技术\n'
        '14 学科门类：交叉学科\n140001TK 未来机器人（注：原专业代码为083201TK。授予工学学士学位）'])
    assert data['majors'][0]['code'] == '080901'
    assert data['majors'][0]['category']['name'] == '计算机类'
    assert data['majors'][1]['category'] is None
    assert data['majors'][1]['discipline']['name'] == '交叉学科'
    assert data['majors'][1]['name'] == '未来机器人'
    assert '原专业代码' in data['majors'][1]['degree_note']


def test_major_taxonomy_rejects_wrong_year_and_category():
    with pytest.raises(ValueError):
        parse_major_pages(['普通高等学校本科专业目录（2025年）'])
    with pytest.raises(ValueError):
        parse_major_pages(['普通高等学校本科专业目录（2026年）', '',
                          '08 学科门类：工学\n0809 计算机类\n070101 数学与应用数学'])


def test_official_seven_digit_language_code_is_not_dropped():
    data = parse_major_pages(['普通高等学校本科专业目录（2026年）', '',
        '05 学科门类：文学\n0502 外国语言文学类\n0502105T 法律英语'])
    assert data['majors'][0]['code'] == '0502105T'
    assert data['majors'][0]['name'] == '法律英语'
