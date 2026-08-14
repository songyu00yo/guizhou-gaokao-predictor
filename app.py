"""ASGI 入口。

运行时实现位于 backend.web；保留本文件是为了兼容 ``uvicorn app:app``。
"""

from backend.web import app, create_app

__all__ = ["app", "create_app"]


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=False)
