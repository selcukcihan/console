'use strict';

const sdk = require('@serverless/sdk');

module.exports.handler = async (event) => {
  if (!sdk) throw new Error('SDK not exported');

  if (!event.isTriggeredByUnitTest) {
    // eslint-disable-next-line import/no-unresolved
    const sdkMirror = require('@serverless/aws-lambda-sdk');
    if (sdk !== sdkMirror) throw new Error('SDK exports mismatch');
  }

  const span = sdk.createTraceSpan('user.parent');

  sdk.createTraceSpan('user.child.one', () => {});

  await sdk.createTraceSpan('user.child.two', async () => {});

  span.close();

  return {
    name: sdk.name,
    version: sdk.version,
    rootSpanName: sdk.traceSpans.root.name,
  };
};