from __future__ import annotations
from types import MethodType

import pytest

from . import ServerlessSdk, get_params
from ..base import SLS_ORG_ID


@pytest.fixture
def sdk() -> ServerlessSdk:
    from .. import serverlessSdk

    return serverlessSdk


def test_can_import_serverless_sdk():
    try:
        from .. import serverlessSdk

    except ImportError as e:
        raise AssertionError("Cannot import `serverlessSdk`") from e


def test_has_name(sdk: ServerlessSdk):
    assert hasattr(sdk, "name")
    assert isinstance(sdk.name, str)


def test_has_version(sdk: ServerlessSdk):
    assert hasattr(sdk, "version")
    assert isinstance(sdk.version, str)


def test_has_tracespans(sdk: ServerlessSdk):
    assert hasattr(sdk, "trace_spans")


def test_has_instrumentation(sdk: ServerlessSdk):
    assert hasattr(sdk, "instrumentation")


def test_has_initialize_method_with_params(sdk: ServerlessSdk):
    assert hasattr(sdk, "_initialize")
    assert isinstance(sdk._initialize, MethodType)

    # check if method takes `org_id` param
    params = get_params(sdk._initialize)

    assert len(params) >= 1
    assert "org_id" in params


def test_initialize_supports_org_id(sdk: ServerlessSdk):
    org_id: str = "test"

    sdk._initialize(org_id=org_id)
    assert sdk.org_id == org_id


def test_initialize_favors_env_var(sdk: ServerlessSdk):
    from os import environ

    org_id: str = "test"
    env: str = "env"

    environ[SLS_ORG_ID] = env

    sdk._initialize(org_id=org_id)
    assert sdk.org_id != org_id
    assert sdk.org_id == env


def test_has_create_trace_span_method(sdk: ServerlessSdk):
    assert hasattr(sdk, "create_trace_span")
    assert isinstance(sdk.create_trace_span, MethodType)

    args = "name", "input", "output", "start_time", "tags"
    params = get_params(sdk.create_trace_span)

    assert len(params) >= len(args)
    assert all(arg in params for arg in args)


def test_create_trace_span_returns_trace_span(sdk: ServerlessSdk):
    from ..span.trace import TraceSpan

    span = sdk.create_trace_span("name", "input", "output")

    assert isinstance(span, TraceSpan)
