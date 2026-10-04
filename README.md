# 贵州高考志愿预测系统（物理类）

这是一个面向贵州普通类本科批首选物理考生的志愿辅助项目。当前公开运行包使用 2024～2026 年首次投档数据，对 2027 年生成临时预测。

[![build](https://github.com/songyu00yo/guizhou-gaokao-predictor/actions/workflows/ci.yml/badge.svg)](https://github.com/songyu00yo/guizhou-gaokao-predictor/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/songyu00yo/guizhou-gaokao-predictor)](https://github.com/songyu00yo/guizhou-gaokao-predictor/releases/latest)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![platform](https://img.shields.io/badge/platform-Web%20%7C%20Docker-lightgrey)

API 每次返回 96 个推荐项。推荐结果包含预测位次区间、估算录取概率和风险分层，并支持 `conservative`、`balanced` 和 `aggressive` 三种偏好。

> **当前结果不能视为 2027 年正式录取预测。** 2027 年招生目录和一分一段表尚未发布。当前预测沿用 2026 年的专业集合，也没有 `plan_2027`。
>
> 项目只用于信息整理和概率分析，不能替代贵州省招生考试院、院校招生章程或人工核验。

## 当前运行包

| 项目 | 当前值 |
| --- | --- |
| 目标年份 | 2027 |
| 状态 | `provisional_before_2027_catalog` |
| 预测记录 | 16,740 |
| 模型路线 | `catboost_delta_d5` |
| 运行数据 | `predictions_2027.json`、`model_report.json`、`segment_2026.json` |
| 数据生成时间 | 2026-08-14 |

公开 Web 服务只加载运行数据，不导入 CatBoost、LightGBM、pandas 或训练代码。

## 本地运行

Dockerfile 使用 Python 3.12。按同一版本运行最容易复现公开服务环境。

```bash
git clone https://github.com/songyu00yo/guizhou-gaokao-predictor.git
cd guizhou-gaokao-predictor

python -m venv .venv
```

Linux 或 macOS：

```bash
source .venv/bin/activate
```

Windows PowerShell：

```powershell
.venv\Scripts\Activate.ps1
```

安装依赖并启动：

```bash
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000>。健康检查地址是 <http://127.0.0.1:8000/api/health>。

### Docker

仓库提供 `Dockerfile`，没有 `docker-compose.yml`。

```bash
docker build -t guizhou-gaokao-predictor .
docker run --rm -p 8000:8000 guizhou-gaokao-predictor
```

## API

生成推荐：

```http
POST /api/v1/recommendations
Content-Type: application/json

{"score":500,"risk":"balanced"}
```

请求字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `score` | integer | 0～750 |
| `current_rank` | integer 或 null | 可选。填写后优先使用位次 |
| `risk` | string | `conservative`、`balanced` 或 `aggressive` |

如果没有传 `current_rank`，服务会用贵州 2026 年物理类一分一段表把分数换成位次。

主要接口：

- `POST /api/v1/recommendations`：返回 96 个推荐项和候选替补。
- `GET /api/v1/recommendations/{unit_id}`：返回单个院校专业预测详情。
- `GET /api/v1/model-report`：返回公开模型报告。
- `GET /api/health`：返回服务状态、目标年份、候选数量和模型路线。
- `POST /generate`、`GET /api/detail/{unit_id}`：兼容旧接口。`difficulty_delta` 已弃用。

FastAPI 自动生成的接口文档可在 `/docs` 查看。

## 模型选择与评估

模型选择和最终评估分开进行。

1. 用 `2024→2025` 转换数据做 5 折院校分组交叉验证。
2. 根据内部验证结果锁定 `catboost_delta_d5`。
3. 用锁定后的路线预测 `2025→2026`，得到时间外评估结果。
4. 完成评估后，再把 `2024→2025` 和 `2025→2026` 两段数据合并，用于生成 2027 年临时预测。

`2025→2026` 不参与模型路线选择。

### 2026 时间外评估

`data/artifacts/model_report.json` 中的 `time_out_2026_metrics_without_future_plan` 记录了不使用未来招生计划时的结果：

| 指标 | 结果 |
| --- | ---: |
| 样本数 | 13,491 |
| MAE | 3,513.76 位 |
| 中位绝对误差 | 2,058 位 |
| 10% 相对误差内 | 80.91% |
| 20% 相对误差内 | 94.89% |

残差区间使用 5 折 cross-fit 校准。校准后的中位预测 MAE 为 3,131.83 位，中位绝对误差为 1,783 位。

`q10～q90` 覆盖率为 79.48%，`q05～q95` 覆盖率为 89.66%。

在 11,328 条可公平对比的样本上，新路线相对冻结的旧算法把 MAE 降低了 33.10%，中位绝对误差降低了 41.13%。

这些数字描述历史回测，不表示 2027 年录取保证。

## 2027 临时预测的边界

当前预测文件把 2026 年普通本科物理类专业作为 2027 年候选集合。2027 年新增、停招、改名或调整选科要求的专业，要等官方招生目录发布后才能加入或修正。

`plan_2026` 是从 2026 年招生目录核验出的计划人数。`admitted_2026` 是 2026 年首次投档人数。两者含义不同，代码不会把它们当成同一字段。

预测区间描述首次投档位次的不确定性。最终录取还会受招生计划、专业组调整、选科要求、政策和考生分布变化影响。

## 数据与复现范围

数据解析代码中的首次投档来源指向贵州省招生考试院等公开页面。仓库不分发原始 PDF、处理中间 CSV、私人 Excel、冻结缓存和训练模型。

因此，公开仓库可以审查数据清洗、匹配、回测和训练代码，但不能只靠一次 `git clone` 完整重建当前 `data/artifacts/`。要重新训练，需要先准备对应的原始数据和本地缓存。

训练依赖：

```bash
python -m pip install -r requirements-ml.txt
```

相关代码：

- `backend/data_pipeline.py`：解析官方 PDF，规范院校和专业名称，并匹配年度数据。
- `backend/backtest.py`：构造年度转换数据，比较模型路线并生成回测指标。
- `backend/train_forecast.py`：锁定路线后重新训练，生成预测文件和运行清单。

2027 年官方招生目录发布后，需要重新生成专业集合和 `plan_2027`。2027 年一分一段表发布后，还需要更新正式位次映射。

## 运行架构

- `app.py`：ASGI 入口，兼容 `uvicorn app:app`。
- `backend/web.py`：FastAPI 路由、限流和运行时服务组装。
- `backend/runtime_store.py`：校验运行包，并用 NumPy 计算推荐结果。
- `backend/logo_service.py`：按白名单获取校徽，并写入本地缓存。
- `static/`：原生 JavaScript 和 CSS 前端。
- `data/artifacts/`：公开预测文件、模型报告和运行清单。

运行包启动时会检查 schema、文件大小和 SHA-256。校验失败时，服务不会继续加载对应运行包。

## 可选配置

`.env.example` 给出了以下配置：

- `GZ_ADMIN_TOKEN`：管理员实时核查接口令牌。不配置时对应能力保持关闭。
- `GZ_RUNTIME_CACHE_DIR`：运行缓存目录，默认使用 `var/cache`。
- `GZ_PRIVATE_PROFILE_FILE`：私人院校画像 JSON。公开功能不依赖该文件。

校徽不提交到 Git，只在运行时按需缓存。

## 开发

安装开发依赖：

```bash
python -m pip install -r requirements-dev.txt
```

运行检查：

```bash
ruff check .
pytest
```

提交代码时，不要加入考生个人信息、私人 Excel、原始 PDF、训练模型或运行缓存。更多约束见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证与第三方内容

代码依据 [Apache License 2.0](LICENSE) 发布。

许可证不覆盖官方招生数据、院校校徽、CollegesChat 内容和其他第三方内容。

相关说明见 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
