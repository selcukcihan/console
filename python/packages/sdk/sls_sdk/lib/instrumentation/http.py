import time
import contextvars
from urllib.parse import urlparse
from urllib.parse import parse_qs
from ..error import report as report_error
from .import_hook import ImportHook
import sls_sdk

SDK = sls_sdk.serverlessSdk
_IGNORE_FOLLOWING_REQUEST = contextvars.ContextVar("ignore", default=False)


def ignore_following_request():
    _IGNORE_FOLLOWING_REQUEST.set(True)


def reset_ignore_following_request():
    _IGNORE_FOLLOWING_REQUEST.set(False)


_HTTP_SPAN = contextvars.ContextVar("http-span", default=None)


class BaseInstrumenter:
    def __init__(self, target_module):
        self._import_hook = ImportHook(target_module)
        self._is_installed = False
        self._module = None

    def install(self, should_monitor_request_response):
        if self._is_installed:
            return
        self.should_monitor_request_response = should_monitor_request_response

        if self._import_hook.enabled:
            return

        self._import_hook.enable(self._install)
        self._is_installed = True

    def uninstall(self):
        if not self._is_installed:
            return

        self._import_hook.disable(self._uninstall)
        self._is_installed = False

    def _install(self, module):
        raise NotImplementedError

    def _uninstall(self, module):
        raise NotImplementedError


class NativeAIOHTTPInstrumenter(BaseInstrumenter):
    def __init__(self):
        super().__init__("aiohttp")
        self._original_init = None

    def _capture_request_body(self, trace_span, body):
        if not body:
            return
        if not self.should_monitor_request_response:
            return
        if len(body) > SDK._maximum_body_byte_length:
            SDK._report_notice(
                "Large body excluded",
                "INPUT_BODY_TOO_LARGE",
                trace_span,
            )
            return
        try:
            trace_span.input = body.decode("utf-8")
        except Exception:
            pass

    async def _capture_response_body(self, trace_span, response):
        if not self.should_monitor_request_response:
            return
        if (
            response.content_length
            and response.content_length > SDK._maximum_body_byte_length
        ):
            SDK._report_notice(
                "Large body excluded",
                "OUTPUT_BODY_TOO_LARGE",
                trace_span,
            )
            return
        try:
            response_body = await response.read()
            if response_body:
                trace_span.output = response_body.decode("utf-8")
        except Exception as ex:
            report_error(ex)

    async def _on_request_start(self, session, trace_config_ctx, params):
        if hasattr(session, "_sls_ignore") and session._sls_ignore:
            return
        trace_config_ctx.start_time = time.perf_counter_ns()
        SDK._debug_log("HTTP request")
        trace_config_ctx.trace_span = SDK._create_trace_span(
            f"python.{params.url.scheme}.request",
            start_time=trace_config_ctx.start_time,
        )
        trace_config_ctx.trace_span.tags.update(
            {
                "method": params.method,
                "protocol": "HTTP/1.1",
                "host": f"{params.url.host}:{params.url.port}",
                "path": params.url.path,
                "request_header_names": list(params.headers.keys()),
                "query_parameter_names": list(params.url.query.keys()),
            },
            prefix="http",
        )
        trace_config_ctx.request_body = None

    async def _on_request_chunk_sent(self, session, trace_config_ctx, params):
        if not hasattr(trace_config_ctx, "trace_span"):
            return
        if trace_config_ctx.request_body is None:
            trace_config_ctx.request_body = params.chunk
        else:
            trace_config_ctx.request_body += params.chunk

    async def _on_request_exception(self, session, trace_config_ctx, params):
        if not hasattr(trace_config_ctx, "trace_span"):
            return
        self._capture_request_body(
            trace_config_ctx.trace_span, trace_config_ctx.request_body
        )
        trace_config_ctx.trace_span.tags.update(
            {"error_code": params.exception.__class__.__name__}, prefix="http"
        )
        if trace_config_ctx.trace_span.end_time is None:
            trace_config_ctx.trace_span.close()

    async def _on_request_end(self, session, trace_config_ctx, params):
        if not hasattr(trace_config_ctx, "trace_span"):
            return
        self._capture_request_body(
            trace_config_ctx.trace_span, trace_config_ctx.request_body
        )
        trace_config_ctx.trace_span.tags.update(
            {"status_code": params.response.status}, prefix="http"
        )
        await self._capture_response_body(trace_config_ctx.trace_span, params.response)
        if trace_config_ctx.trace_span.end_time is None:
            trace_config_ctx.trace_span.close()

    def _instrumented_init(self, trace_config):
        def _init(_self, *args, **kwargs):
            if "trace_configs" in kwargs:
                kwargs["trace_configs"].append(trace_config)
            else:
                kwargs["trace_configs"] = [trace_config]
            self._original_init(_self, *args, **kwargs)

        return _init

    def _install(self, module):
        self._module = module
        if hasattr(self._module, "TraceConfig"):
            trace_config = self._module.TraceConfig()
            trace_config.on_request_start.append(self._on_request_start)
            trace_config.on_request_chunk_sent.append(self._on_request_chunk_sent)
            trace_config.on_request_end.append(self._on_request_end)
            trace_config.on_request_exception.append(self._on_request_exception)

            self._original_init = self._module.ClientSession.__init__
            self._module.ClientSession.__init__ = self._instrumented_init(trace_config)

    def _uninstall(self, module):
        if self._original_init:
            self._module.ClientSession.__init__ = self._original_init
        self._module = None


class NativeHTTPInstrumenter(BaseInstrumenter):
    def __init__(self):
        super().__init__("http")
        self._original_request = None
        self._original_getresponse = None

    def _instrumented_request(self):
        def _func(_self, method, url, body=None, headers={}, *, encode_chunked=False):
            _self._sls_ignore = _IGNORE_FOLLOWING_REQUEST.get()
            reset_ignore_following_request()

            if _self._sls_ignore:
                return self._original_request(
                    _self, method, url, body, headers, encode_chunked=encode_chunked
                )
            start_time = time.perf_counter_ns()

            SDK._debug_log("HTTP request")
            protocol = (
                "https" if _self.__class__.__name__ == "HTTPSConnection" else "http"
            )

            trace_span = SDK._create_trace_span(
                f"python.{protocol}.request",
                start_time=start_time,
            )
            _HTTP_SPAN.set(trace_span)

            try:
                parsed_path = urlparse(url)
                query = parse_qs(parsed_path.query)
                trace_span.tags.update(
                    {
                        "method": method,
                        "protocol": "HTTP/1.1",
                        "host": f"{_self.host}:{_self.port}",
                        "path": parsed_path.path,
                        "request_header_names": [h for h in headers.keys()],
                        "query_parameter_names": [q for q in query.keys()],
                    },
                    prefix="http",
                )
                self._capture_request_body(trace_span, body)

                self._original_request(
                    _self, method, url, body, headers, encode_chunked=encode_chunked
                )
            except Exception as ex:
                trace_span = _HTTP_SPAN.get()
                trace_span.tags["http.error_code"] = ex.__class__.__name__
                if trace_span.end_time is None:
                    trace_span.close()
                raise

        return _func

    def _capture_request_body(self, trace_span, body):
        if not body:
            return
        if not self.should_monitor_request_response:
            return
        if len(body) > SDK._maximum_body_byte_length:
            SDK._report_notice(
                "Large body excluded",
                "INPUT_BODY_TOO_LARGE",
                trace_span,
            )
            return
        try:
            trace_span.input = body.decode("utf-8")
        except Exception:
            pass

    def _instrumented_getresponse(self):
        def _func(_self, *args, **kwargs):
            trace_span = _HTTP_SPAN.get()
            if _self._sls_ignore or not trace_span:
                return self._original_getresponse(_self, *args, **kwargs)

            try:
                response = self._original_getresponse(_self, *args, **kwargs)
                trace_span.tags["http.status_code"] = response.status
                self._capture_response_body(trace_span, response)
                return response
            finally:
                if trace_span.end_time is None:
                    trace_span.close()

        return _func

    def _capture_response_body(self, trace_span, response):
        if not self.should_monitor_request_response:
            return
        if response.length > SDK._maximum_body_byte_length:
            SDK._report_notice(
                "Large body excluded",
                "OUTPUT_BODY_TOO_LARGE",
                trace_span,
            )
            return
        try:
            response_body = response.peek()
            if response_body:
                trace_span.output = response_body.decode("utf-8")
        except Exception as ex:
            report_error(ex)

    def _install(self, module):
        self._module = module
        self._original_request = self._module.client.HTTPConnection.request
        self._original_getresponse = self._module.client.HTTPConnection.getresponse
        self._module.client.HTTPConnection.request = self._instrumented_request()
        self._module.client.HTTPConnection.getresponse = (
            self._instrumented_getresponse()
        )

    def _uninstall(self, module):
        self._module.client.HTTPConnection.request = self._original_request
        self._module.client.HTTPConnection.getresponse = self._original_getresponse
        self._module = None


_instrumenters = [NativeHTTPInstrumenter(), NativeAIOHTTPInstrumenter()]
_is_installed = False


def install():
    global _is_installed
    if _is_installed:
        return
    _is_installed = True
    for instrumenter in _instrumenters:
        instrumenter.install(
            SDK._is_dev_mode and not SDK._settings.disable_request_response_monitoring
        )


def uninstall():
    global _is_installed
    if not _is_installed:
        return
    for instrumenter in _instrumenters:
        instrumenter.uninstall()
    _is_installed = False
