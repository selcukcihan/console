from __future__ import annotations

import logging
from functools import lru_cache
from os import environ
from pathlib import Path
from time import time_ns
from typing import Optional, Tuple

from strenum import StrEnum

from typing_extensions import Final, Self


NS_IN_MS: Final[int] = 1_000_000
NEW_HANDLER: Final[
    str
] = "selcuk_serverless_aws_lambda_sdk.internal_extension.wrapper.handler"
PYTHON_EXTS: Final[Tuple[str, ...]] = (".py", ".pyc", ".pyo", ".pyd")


class Env(StrEnum):
    HANDLER: Self = "_HANDLER"
    ORIGIN_HANDLER: Self = "_ORIGIN_HANDLER"
    LAMBDA_RUNTIME_DIR: Self = "LAMBDA_RUNTIME_DIR"
    LAMBDA_TASK_ROOT: Self = "LAMBDA_TASK_ROOT"

    SLS_ORG_ID: Self = "SLS_ORG_ID"
    SLS_SDK_DEBUG: Self = "SLS_SDK_DEBUG"


# Lambda env vars
HANDLER: Final[Optional[str]] = environ.get(Env.HANDLER)
LAMBDA_TASK_ROOT: Final[Optional[str]] = environ.get(Env.LAMBDA_TASK_ROOT)

# Serverless env vars
SLS_ORG_ID: Final[Optional[str]] = environ.get(Env.SLS_ORG_ID)
SLS_SDK_DEBUG: Final[Optional[str]] = environ.get(Env.SLS_SDK_DEBUG)

DEFAULT_TASK_ROOT: Final[str] = "/var/task"


cache = lru_cache(maxsize=1)


def initialize(handler: Optional[str] = HANDLER):
    start = time_ns()

    if SLS_SDK_DEBUG:
        logging.basicConfig(level=logging.DEBUG, format="⚡ SDK: %(message)s")

    logging.debug("Wrapper initialization")

    if not handler or "." not in handler or ".." in handler:
        # Bad handler, let error naturally surface
        return

    if not SLS_ORG_ID:
        logging.error(
            "Serverless SDK Warning: "
            "Cannot instrument function: "
            'Missing "SLS_ORG_ID" environment variable',
        )
        return

    get_module_path(handler)
    set_handler_vars()

    end = time_ns()
    ms = round((end - start) / NS_IN_MS)

    logging.debug(f"Overhead duration: Internal initialization: {ms}ms")


@cache
def get_module_path(handler: str = HANDLER) -> Optional[Path]:
    handler = Path(handler).resolve()
    handler_dir = handler.parent
    handler_basename = handler.name
    handler_module_name, *_ = handler_basename.split(".")

    task_root = Path(LAMBDA_TASK_ROOT).resolve()

    if not task_root.exists():
        task_root = Path(DEFAULT_TASK_ROOT)

    handler_module_dir = (task_root / handler_dir.name).resolve()
    handler_module = (handler_module_dir / handler_module_name).resolve()

    for ext in PYTHON_EXTS:
        module_file = handler_module.with_suffix(ext)

        if module_file.exists():
            return module_file

    if handler_module.exists():
        return handler_module

    return None


def set_handler_vars():
    environ[Env.ORIGIN_HANDLER] = HANDLER
    environ[Env.HANDLER] = NEW_HANDLER
