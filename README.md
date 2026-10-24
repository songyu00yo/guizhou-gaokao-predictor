# 贵州物理类高考志愿预测与决策辅助系统

[![build](https://github.com/songyu00yo/guizhou-gaokao-predictor/actions/workflows/ci.yml/badge.svg)](https://github.com/songyu00yo/guizhou-gaokao-predictor/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/songyu00yo/guizhou-gaokao-predictor)](https://github.com/songyu00yo/guizhou-gaokao-predictor/releases/latest)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![ECharts](https://img.shields.io/badge/ECharts-AA344D?logo=apacheecharts&logoColor=white)
![CatBoost](https://img.shields.io/badge/model-CatBoost-FFCC00)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)

这是一个桌面 Web 应用，服务贵州普通类本科批首选物理的考生。你输入高考分数，系统按 2026 年一分一段表换算位次，再生成 96 个冲稳保志愿。每个志愿都附带 2027 年预测位次区间、估算录取概率和院校生活信息。

> **2027 年的结果是临时预测。** 2027 年招生目录和一分一段表尚未发布，分数换位次参考 2026 年表。
>
> 本项目不是官方系统，只做信息整理和概率估算。填报前请以贵州省招生考试院、院校招生章程为准，并人工核验。

## 主要功能

系统有四个页面，用顶部导航切换：

- 总览：位次、平均录取概率和冲稳保数量，全部 96 个志愿列表，位次趋势图，难度与把握散点图，录取概率分布图和城市分布图。
- 志愿推荐：96 个志愿逐行对比，包括风险、录取概率、2024 年～2027 年位次走势、计划和学费。支持筛选、排序和搜索。
- 院校详情：默认显示“录取趋势”，即同校各专业 2026 年实际位次和 2027 年预测位次的对比。另有基础信息、学生生活问卷原文和官网来源。
- 资料说明：数据来源、覆盖情况、模型公式和回测图表。

左栏可以切换三种策略：保守、均衡和冲刺，对应接口参数 `conservative`、`balanced` 和 `aggressive`。不同策略的冲稳保名额不同。对某条志愿点“更换”或“不感兴趣”后，系统会从候选中自动补位。

## 数据与模型现状

下表是当前启用运行包的数据，生成于 2026-10-23。

| 项目 | 数量 |
| --- | ---: |
| 专业预测 | 16,740 条 |
| 院校 | 1,101 所 |
| 有学生生活问卷的院校 | 1,040 所 |
| 有学费的专业 | 15,150 条 |
| 有选科要求的专业 | 15,134 条 |
| 资料源文件 | 1,334 份 |

模型路线是 `catboost_delta_d5`。下表是 2026 年时间外评估的结果，训练时没有用到 2026 年的录取结果。MAE（Mean Absolute Error，平均绝对误差）指预测位次与实际投档位次的平均差距。

| 指标 | 结果 |
| --- | ---: |
| 评估样本 | 13,491 个 |
| MAE | 3,567.72 位 |
| 中位绝对误差 | 2,144 位 |
| 交叉校准后 MAE | 3,118.579 位 |
| 交叉校准后中位绝对误差 | 1,769 位 |
| 80% 区间实际覆盖率 | 79.52% |
| 90% 区间实际覆盖率 | 89.68% |

这些数字是模型报告记录的历史回测，不是录取准确率。

**仓库自带的 `data/artifacts/` 是 2026-08-14 生成的旧运行包。** 它的指标和覆盖数与上表不同。按 [BACKEND_REBUILD.md](BACKEND_REBUILD.md) 重建后，才能得到上表的数据。

## 本地运行

Dockerfile 使用 Python 3.12，本地也建议用这个版本。

```bash
git clone https://github.com/songyu00yo/guizhou-gaokao-predictor.git
cd guizhou-gaokao-predictor
python -m venv .venv
```

激活虚拟环境。Linux 或 macOS：

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

用浏览器打开 <http://127.0.0.1:8000>，健康检查地址是 <http://127.0.0.1:8000/api/health>。

界面按桌面浏览器设计。窗口宽度在 820 px 及以下时会切换为简化的手机布局，没有做全面的手机适配。核心功能在依赖安装后可以离线运行，校徽等外部资源需要联网。

### 用 Docker 运行

直接构建并运行：

```bash
docker build -t guizhou-gaokao-predictor .
docker run --rm -p 8000:8000 guizhou-gaokao-predictor
```

也可以用 `compose.yaml`。它把运行缓存目录 `var/cache`（包括校徽缓存）挂到 `predictor-cache` 卷上。项目根目录有 `.env` 时，compose 会读取它：

```bash
docker compose up --build
```

## 接口

生成推荐：

```http
POST /api/v1/recommendations
Content-Type: application/json

{"score":500,"risk":"balanced"}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `score` | integer | 高考分数，0～750 |
| `current_rank` | integer 或 null | 可选。填写后优先使用这个位次 |
| `risk` | string | `conservative`、`balanced` 或 `aggressive` |

没有传 `current_rank` 时，服务用贵州 2026 年物理类一分一段表把分数换成位次。返回结果里，每个推荐项都带 `rank_trend` 字段，按顺序是 2024 年、2025 年、2026 年的投档位次和 2027 年预测位次，缺失的年份为 `null`。

常用接口：

| 接口 | 说明 |
| --- | --- |
| `POST /api/v1/recommendations` | 返回 96 个推荐项和候补 |
| `GET /api/v1/recommendations/{unit_id}` | 返回单个院校专业的预测详情和完整历史 |
| `GET /api/school-profile/{school_name}` | 返回院校画像和各专业位次 |
| `GET /api/colleges-chat/{school_name}` | 返回院校的学生生活问卷 |
| `GET /api/resources/summary` | 返回数据覆盖和来源汇总 |
| `GET /api/v1/model-report` | 返回模型报告 |
| `GET /api/health` | 返回服务状态、目标年份、候选数量和模型路线 |

旧接口 `POST /generate` 和 `GET /api/detail/{unit_id}` 仍然可用，`difficulty_delta` 参数已弃用。完整接口文档见 `/docs`。

## 模型方法

模型选型和最终评估分开做：

1. 用 2024→2025 年的转换数据做 5 折交叉验证，按院校分组。
2. 根据验证结果锁定 `catboost_delta_d5`。
3. 用锁定的路线预测 2025→2026 年，得到时间外评估结果。2025→2026 年的数据不参与选型。
4. 评估完成后，合并两段转换数据重新训练，生成 2027 年临时预测。

预测分四步：

1. 把每年的投档位次除以当年考生规模，换算成占全省考生的比例。
2. 用 CatBoost 学习这个比例在相邻两年间的对数变化量，再还原成 2027 年预测位次。
3. 按预测位次分成 10 档，用每档的历史残差分位数给出预测区间。
4. 在各分位点之间做线性插值，把考生位次换算成录取概率，再按概率分出强冲、冲、稳、保和兜底。

完整公式和参数在“资料说明”页里。原算法的冻结快照没有公开，所以无法与旧算法做对比。

## 2027 年预测的边界

当前预测把 2026 年普通本科物理类专业作为 2027 年的候选集合。2027 年新增、停招、改名或调整选科要求的专业，要等官方招生目录发布后才能补上或修正。

`plan_2026` 是从 2026 年招生目录核验出的计划人数，`admitted_2026` 是 2026 年首次投档人数。两者含义不同，代码分开处理。

预测区间只描述首次投档位次的不确定性。最终录取还受招生计划、专业组调整、选科要求、政策和考生分布变化影响。

## 重建数据

仓库不分发原始 PDF、处理中间文件、私人 Excel 和训练模型。重建流程会下载投档表、一分一段表、招生目录和院校资料，并记录来源和校验值。第一次运行需要联网，之后可以复用已校验的本地缓存。

```bash
python -m pip install -r requirements-ml.txt
python -m backend.rebuild --train --activate
```

重建结果写在 `var/runtime/` 下，`var/runtime/active.json` 记录当前启用的运行包。启动、重建和回退的完整步骤见 [BACKEND_REBUILD.md](BACKEND_REBUILD.md)。

2027 年招生目录发布后，需要重新生成专业集合和 `plan_2027`。2027 年一分一段表发布后，还要更新分数和位次的换算。

## 目录结构

- `app.py`：ASGI 入口，可以用 `uvicorn app:app` 启动。
- `backend/web.py`：FastAPI 路由、限流和服务组装。
- `backend/runtime_store.py`：加载并校验运行包，用 NumPy 计算推荐结果。
- `backend/data_pipeline.py`：解析官方 PDF，规范院校和专业名称，匹配各年数据。
- `backend/backtest.py`：构造年度转换数据，比较模型路线，生成回测指标。
- `backend/train_forecast.py`：锁定路线后重新训练，生成预测文件和运行清单。
- `backend/logo_service.py`：按白名单获取校徽并写入本地缓存。
- `static/`：前端页面。`app.js` 是主逻辑，`js/` 下是状态、接口和动画模块，图表用 ECharts。
- `data/artifacts/`：仓库自带的运行包。

服务启动时会检查运行包的 schema、文件大小和 SHA-256。校验失败时，不加载这个运行包。公开 Web 服务只读取运行数据，不导入 CatBoost、LightGBM、pandas 等训练依赖。

## 配置

`.env.example` 列出了四个可选环境变量：

| 变量 | 说明 |
| --- | --- |
| `GZ_ADMIN_TOKEN` | 管理员实时核查接口的令牌。不配置时这项功能关闭 |
| `GZ_RUNTIME_CACHE_DIR` | 运行缓存目录，默认是 `var/cache` |
| `GZ_PRIVATE_PROFILE_FILE` | 私人院校画像 JSON。公开功能不依赖这个文件 |
| `GZ_RUNTIME_DATA_DIR` | 指定运行包目录。不设置时先读 `var/runtime/active.json`，再用 `data/artifacts/` |

应用不会自动加载 `.env`，本地运行时请在终端里用 `export` 设置。用 `docker compose` 运行时会读取 `.env`。

## 开发与测试

安装开发依赖：

```bash
python -m pip install -r requirements-dev.txt
```

运行检查和测试：

```bash
ruff check .
pytest
node --test tests/frontend_motion.test.mjs
```

提交代码时，不要加入考生个人信息、私人 Excel、原始 PDF、训练模型或运行缓存。其他约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证与第三方内容

代码按 [Apache License 2.0](LICENSE) 发布。

许可证不覆盖官方招生数据、院校校徽、CollegesChat 问卷和其他第三方内容。各项来源和许可见 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
