from __future__ import annotations

from datetime import datetime
from typing import List, Union
from pathlib import Path
from typing_extensions import Final


SLS_ORG_ID: Final[str] = "SLS_ORG_ID"

# module metadata
__name__ = "serverless-sdk"
with open(Path(__file__).parent / "VERSION") as version_file:
    __version__ = version_file.read().strip()


TraceId = str
Nanoseconds = int
DateStr = str

TagType = Union[str, int, float, DateStr, bool, datetime]
TagList = List[TagType]
ValidTags = Union[TagType, TagList]
