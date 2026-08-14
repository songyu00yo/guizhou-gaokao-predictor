# 贵州高考志愿预测系统（物理类）

面向贵州物理类考生的开源志愿辅助工具。项目依据 2024—2026 历史投档数据生成 2027 预预测，提供 96 个志愿推荐、风险分层、院校画像、校徽占位与 CollegesChat 公开信息读取。

> **重要声明：本项目仅用于信息整理和概率分析，不保证录取，也不能替代贵州省招生考试院、院校招生章程或专业人士建议。2027 招生目录和一分一段表发布前，结果均属于预预测。**

## 快速启动

需要 Python 3.11 或 3.12。公开运行只加载仓库内约 7MB 的运行时数据包，不需要原始 PDF、Excel 或训练模型。

```bash
git clone https://github.com/songyu00yo/guizhou-gaokao-predictor.git
cd guizhou-gaokao-predictor
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000>。健康检查位于 <http://127.0.0.1:8000/api/health>。

Docker 启动：

```bash
docker compose up --build
```

## API

```http
POST /api/v1/recommendations
Content-Type: application/json

{"score": 500, "risk": "balanced"}
```

- `POST /api/v1/recommendations`：生成推荐列表。
- `GET /api/v1/recommendations/{unit_id}`：按需读取院校专业详情。
- `GET /api/v1/model-report`：读取由训练报告生成的公开指标。
- `POST /generate`、`GET /api/detail/{unit_id}`：兼容旧版；`difficulty_delta` 已弃用。

## 模型与回测口径

```text
2024 数据 ──训练/校准──> 预测 2025 ──按院校分组交叉验证──> 选择模型路线
                                                               │
2025 数据 ─────────────────────────────────────────────────────┘
                         选定后锁定路线
                                │
                                └──> 2025→2026 仅做一次最终评估
```

- 模型路线只依据 `2024→2025` 的 5 折院校分组交叉验证选择，避免同一院校泄漏到验证折。
- `2025→2026` 只用于最终测试，不参与模型选择、融合权重或阈值调优。
- 当前选定路线为 `catboost_delta_d5`。2026 严格测试集 MAE 为 3,131.83 位，中位绝对误差为 1,783 位，10% 相对误差内占 82.44%。
- 公平可比样本上，新路线相对旧算法 MAE 降低 33.10%，中位绝对误差降低 41.13%。区间覆盖率约为 79.48%（内层）和 89.66%（外层）。
- `plan_2026` 表示招生目录计划人数，`admitted_2026` 表示首次投档人数，两者不混用。
- 公开指标来源于 [`data/artifacts/model_report.json`](data/artifacts/model_report.json)，运行包由 manifest 校验 schema、行数、字节数和 SHA-256。

这些指标描述历史回测，不代表未来录取保证。专业组调整、招生计划、选科要求、政策和考生分布变化都可能造成明显偏差。

## 架构

- `app.py`：最小 ASGI 入口。
- `backend/web.py`：应用工厂、路由、限流和安全边界。
- `backend/runtime_store.py`：只读数据仓库、NumPy 向量化推荐和查询缓存。
- `backend/logo_service.py`：白名单校徽下载、图片校验与原子缓存。
- `backend/train_forecast.py`、`backend/backtest.py`：离线训练与回测，不会在公开启动时导入。
- `static/`：原生 JavaScript/CSS 前端；请求、状态和动效模块分离。
- `data/artifacts/`：公开运行时数据及模型报告。

## 数据与复现

预测使用贵州省招生考试院公开的一分一段表、招生目录和首次投档信息。原始 PDF、处理中间 CSV、私人 Excel 与训练模型不随仓库发布。维护者可在取得合法数据后安装 `requirements-ml.txt`，按 `backend/data_pipeline.py`、`backend/backtest.py`、`backend/train_forecast.py` 的顺序离线复现。

2027 官方招生目录发布后，应重新生成 `plan_2027`；2027 一分一段表发布后，应重新生成正式位次映射及预测包。未完成这两步前，界面必须保留“预预测”标识。

## 可选配置

复制 `.env.example` 后按需填写。`GZ_ADMIN_TOKEN` 保护实时核查接口；`GZ_PRIVATE_PROFILE_FILE` 可接入私人院校画像，但公开功能不依赖它。校徽不进入 Git，只在 `var/cache` 中按需缓存。

## 开发与许可

```bash
python -m pip install -r requirements-dev.txt
ruff check .
pytest
```

代码依据 [Apache License 2.0](LICENSE) 发布。该许可证不覆盖官方数据、校徽和 CollegesChat 内容，详见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
