# 项目说明

这是贵州普通类本科批首选物理考生的志愿推荐 Web 应用。用户输入分数，系统换算位次，生成 96 个冲稳保志愿和 2027 年预测位次。

- 后端：FastAPI，Python 3.12，虚拟环境在 `.venv/`。
- 前端：原生 JavaScript 和 ECharts，没有构建步骤。
- 模型：CatBoost，路线名 `catboost_delta_d5`。
- 2027 年招生目录和一分一段表还没发布，所有 2027 年结果都是临时预测。

## 常用命令

```bash
# 启动网页，打开 http://127.0.0.1:8000
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000

# 检查和测试
.venv/bin/ruff check app.py backend colleges_chat.py tests
.venv/bin/python -m pytest
node --test tests/frontend_motion.test.mjs
```

重建数据用 `.venv/bin/python -m backend.rebuild --train --activate`。这个命令要联网，耗时很长，用户明确要求时才运行。

## 目录

- `app.py`：入口，实际代码在 `backend/web.py`（路由和服务组装）。
- `backend/runtime_store.py`：加载运行包，计算推荐结果。
- `backend/data_pipeline.py`：解析官方 PDF，匹配各年数据。
- `backend/backtest.py`、`backend/train_forecast.py`：回测和训练。
- `backend/rebuild.py`：重建、启用和回退的命令入口。
- `static/app.js`：前端主逻辑。`static/js/` 下是状态、接口和动画模块。
- `tests/`：pytest 测试，加一个 Node 前端测试。

运行包是推荐服务读取的数据。`var/runtime/active.json` 记录当前启用的运行包。`data/artifacts/` 是仓库自带的旧包，生成于 2026-08-14，用来回退。

## 规则

- 改后端后跑 ruff 和 pytest。改前端后再跑 Node 测试。
- 不要手动改运行包里的文件。服务启动时会校验 SHA-256，改了就加载失败。新数据用 `backend.rebuild` 生成。
- 学校和专业匹配不上时，数据留空。不要按相似名称、其他学校或其他校区的数据补。
- `plan_2026` 是招生计划人数，`admitted_2026` 是首次投档人数，两者不能混用。
- 2026 年归一化尺度是 393 分对应的累计位次 158,893。不要改回 166,669，那是特殊预科的位次。
- 不要提交考生个人信息、私人 Excel、原始 PDF、训练模型，以及 `var/`、`data/raw/`、`data/processed/` 下的文件。
- 提交说明和 PR 描述里不加 AI 工具的共同作者署名，例如 `Co-Authored-By: Claude`，也不加 “Generated with” 一类的生成说明。工具默认要求加署名时，以这条为准。
- 代码注释只解释数据口径、业务规则和不直观的实现。
- 不要整份读取大文件：`static/echarts.min.js`、`data/` 下的 CSV 和 JSON、`var/cache/`。需要时用搜索或只读几行。
- 用中文回复用户。

## 按需阅读

- `进度.md`：当前进度和下一步。开始新任务前先读。
- `BACKEND_REBUILD.md`：重建、启用和回退的完整步骤。
- `REBUILD_STATUS.md`：数据覆盖情况和缺项。
- `README.md`：功能、接口、配置和模型方法。

完成一项任务后，把结果和下一步写进 `进度.md`。
