# 2027 预测后端说明

线上服务只读取 schema v2 公共运行包，不导入 CatBoost、LightGBM、PDF 或 Excel 解析依赖。模型路线通过 `2024→2025` 五折院校分组交叉验证确定为 `catboost_delta_d5`，随后锁定路线，在 `2025→2026` 上只执行一次最终评估。

最终评估中位绝对误差为 1,783 位，MAE 为 3,131.83 位，10% 相对误差内占 82.44%。公平样本上相对旧算法 MAE 降低 33.10%。完整字段、分位数覆盖率和限制条件以 `data/artifacts/model_report.json` 为准。

运行包包含预测、位次映射、模型报告和 manifest。服务启动时校验 schema、行数、字节数及 SHA-256；任何损坏都会明确失败，不回退到旧算法。

离线复现：

```powershell
python -m pip install -r requirements-ml.txt
python -m backend.data_pipeline
python -m backend.catalog_pipeline --years 2025 2026
python -m backend.backtest
python -m backend.train_forecast
```

2027 招生目录和一分一段表发布后必须重新生成正式运行包。在此之前，产品状态始终为 `provisional_before_2027_catalog`。
