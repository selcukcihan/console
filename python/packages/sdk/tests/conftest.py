import pytest
import sys
import importlib
from . import TEST_ORG, TEST_DEV_MODE_ORG_ID


@pytest.fixture()
def sdk(monkeypatch, request):
    _reset_sdk_reimport(monkeypatch, request, False, True)
    from serverless_sdk import serverlessSdk

    serverlessSdk._initialize()
    yield serverlessSdk


@pytest.fixture()
def reset_sdk(monkeypatch, request):
    _reset_sdk_reimport(monkeypatch, request)


@pytest.fixture()
def reset_sdk_dev_mode(monkeypatch, request):
    _reset_sdk_reimport(monkeypatch, request, True, True)


def _reset_sdk_reimport(
    monkeypatch, request, is_dev_mode: bool = False, is_debug_mode: bool = False
):
    module_prefixes_to_delete = [
        "serverless_sdk",
        "sls_sdk",
        "http.client",
        "urllib",
        "urllib3",
        "aiohttp",
        "requests",
    ]
    deleted_modules = []
    for key in list(sys.modules.keys()):
        if [prefix for prefix in module_prefixes_to_delete if key.startswith(prefix)]:
            deleted_modules.append(key)
            del sys.modules[key]

    monkeypatch.setenv("SLS_ORG_ID", TEST_ORG)
    if is_dev_mode:
        monkeypatch.setenv("SLS_DEV_MODE_ORG_ID", TEST_DEV_MODE_ORG_ID)
    else:
        monkeypatch.delenv("SLS_DEV_MODE_ORG_ID", False)

    if is_debug_mode:
        monkeypatch.setenv("SLS_SDK_DEBUG", "1")
    else:
        monkeypatch.delenv("SLS_SDK_DEBUG", False)

    if hasattr(request, "param") and type(request.param) is dict:
        for key in request.param:
            monkeypatch.setenv(key, request.param[key])

    # make sure the SDK & other deleted modules are reimported
    for module in deleted_modules + module_prefixes_to_delete:
        importlib.import_module(module)

    # make sure the SDK is imported
    importlib.import_module("serverless_sdk")


@pytest.fixture(scope="session")
def httpserver_listen_address():
    return ("127.0.0.1", 9800)
