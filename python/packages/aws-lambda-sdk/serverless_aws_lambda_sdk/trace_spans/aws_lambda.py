from typing_extensions import Final
import os
import platform
import logging

from serverless_sdk.lib.trace import TraceSpan

__all__ = [
    "aws_lambda_span",
    "reset",
]


IMMUTABLE_TAGS: Final[dict] = {
    "aws.lambda.name": os.environ.get("AWS_LAMBDA_FUNCTION_NAME"),
    "aws.lambda.version": os.environ.get("AWS_LAMBDA_FUNCTION_VERSION"),
}


def _arch():
    arch = platform.machine()
    if arch == "x64" or arch == "x86_64":
        return "x86_64"
    elif arch == "aarch64" or arch == "arm64":
        return "arm64"
    else:
        logging.warning(
            {
                "source": "serverlessSdk",
                "message": f'Unrecognized architecture: "{arch}"',
            }
        )
    return None


arch = _arch()
if arch:
    IMMUTABLE_TAGS["aws.lambda.arch"] = arch


aws_lambda_span = TraceSpan(
    "aws.lambda",
    start_time=int(os.environ.get("_SLS_PROCESS_START_TIME", 0)),
    immediate_descendants=["aws.lambda.initialization"],
    tags=IMMUTABLE_TAGS,
)

if os.environ.get("AWS_LAMBDA_INITIALIZATION_TYPE") == "on-demand":
    aws_lambda_span.tags["aws.lambda.is_coldstart"] = True


def reset():
    aws_lambda_span.tags.clear()
    aws_lambda_span.tags.update(IMMUTABLE_TAGS)
    aws_lambda_span.sub_spans.clear()
