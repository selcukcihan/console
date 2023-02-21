from __future__ import annotations

from os import environ
from typing import List, Optional

from typing_extensions import Final

from ..base import Nanoseconds, SLS_ORG_ID, __version__, __name__
from ..span.trace import TraceSpan
from ..span.tags import Tags


__all__: Final[List[str]] = [
    "ServerlessSdk",
]


class ServerlessSdk:
    name: Final[str] = __name__
    version: Final[str] = __version__

    trace_spans: Final = ...
    instrumentation: Final = ...

    org_id: Optional[str] = None

    def _initialize(self, org_id: Optional[str] = None):
        self.org_id = environ.get(SLS_ORG_ID, default=org_id)

    def create_trace_span(
        self,
        name: str,
        input: str,
        output: str,
        start_time: Optional[Nanoseconds] = None,
        tags: Optional[Tags] = None,
    ) -> TraceSpan:
        return TraceSpan(name, input, output, start_time, tags)
