# 公开数据重建与本地运行

## 启动网页

在项目目录运行：

```bash
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

打开 <http://127.0.0.1:8000>。按 `Control + C` 停止服务。修改启用记录或生成新数据后，需要重启服务。

## 下载、解析并重新训练

首次使用时准备独立环境并安装训练依赖：

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements-ml.txt
.venv/bin/python -m backend.rebuild --train --activate
```

这个命令下载公开资料、解析数据、验证候选模型，再生成预测和院校资料。输出保存在 `var/runtime/build-日期-时间/`，不覆盖 `data/artifacts/`。校验通过后，命令更新 `var/runtime/active.json`。重启网页服务即可使用新包。

仅下载和解析数据：

```bash
.venv/bin/python -m backend.rebuild
```

使用完整缓存重建，不访问网络：

```bash
.venv/bin/python -m backend.rebuild --offline --train --activate
```

招生基础文件缓存缺失或损坏时，离线准备会报错。院校补充来源失败时，会记录缺项并继续其他学校。在线模式会重试失败下载，成功的文件按来源和 SHA-256 复用。解析结果同时校验输入和解析器版本，避免无故重复解析。

原始资料位于 `data/raw/`，标准数据位于 `data/processed/`。这些目录和本地运行包均不提交到 Git。换电脑时可以重新下载，也可以复制已校验的缓存。

## 查看来源与覆盖率

- `data/processed/public_sources.json` 记录招生基础文件的来源、发布时间、获取时间及校验值。
- 运行包中的 `supplement.json` 保存可核实的历年数据、院校资料和来源。
- 运行包中的 `coverage_report.json` 汇总覆盖率与缺项。
- `/api/resources/summary` 返回当前加载包的资料覆盖统计。
- `/api/v1/model-report` 返回当前包的真实回测指标。指标只描述历史验证结果。

学校和专业须能唯一匹配，才会接入历史记录。招生计划与首次投档人数分别保存。未找到的数据保持为空，不用其他学校或其他校区的数据替代。

院校基础资料优先采用教育部名单。历史数据会标注资料年份。CollegesChat 问卷属于学生反馈，展示来源、日期和许可；不代表学校官方承诺。

## 单独补资料、启用与回退

已有重建运行包时，可补建资料后启用：

```bash
.venv/bin/python -m backend.rebuild --enrich --activate --artifact-dir var/runtime/rebuild-20261023
```

回退到仓库自带运行包：

```bash
.venv/bin/python -m backend.rebuild --activate --artifact-dir data/artifacts
```

上述命令都需要重启服务后生效。启用前会校验文件大小、SHA-256 和推荐结果，失败时保留原启用记录。设置环境变量 `GZ_RUNTIME_DATA_DIR` 可以直接指定运行包，优先级高于启用记录。

## 评估口径与现有限制

模型只用 `2024→2025` 的五折院校分组验证选择路线。锁定路线后，用 `2025→2026` 做时间外评估，再合并两段数据生成 2027 年临时预测。区间覆盖率采用交叉校准结果。重建命令同时报告简单基线的表现。

2026 年年度归一化尺度改为普通物理类本科线 393 分对应的累计位次 158,893。旧代码的 166,669 是特殊预科投档记录的位次，不能作为填报前公布的普通本科控制线尺度。依据见[官方转载的分数线公告](https://gyzkzx.cn/html/2026-06/25/content_939383.htm)和[考试院一分一段表](https://zsksy.guizhou.gov.cn/zlxz/202606/P020260625601945906859.pdf)。因此，新指标与旧包可能不同。

原算法冻结快照没有公开，旧算法对比不能重现。2027 年招生目录、计划和一分一段表尚未发布，当前状态保持 `provisional_before_2027_catalog`。学校转专业、就业和保研政策若未找到对应年度的可核实资料，页面会显示缺失。

运行检查：

```bash
uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/ruff check app.py backend colleges_chat.py tests
.venv/bin/python -m pytest
```
