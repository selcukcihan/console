'use strict';

const { expect } = require('chai');

const fsp = require('fs').promises;
const path = require('path');
const log = require('log').get('test');
const wait = require('timers-ext/promise/sleep');
const toml = require('toml');
const { TracePayload } = require('@serverless/sdk-schema/dist/trace');
const { default: fetch } = require('node-fetch');
const { ApiGatewayV2 } = require('@aws-sdk/client-apigatewayv2');
const { Lambda } = require('@aws-sdk/client-lambda');
const cleanup = require('./lib/cleanup');
const createCoreResources = require('./lib/create-core-resources');
const basename = require('./lib/basename');
const getProcessFunction = require('../../lib/get-process-function');
const resolveOutcomeEnumValue = require('../../utils/resolve-outcome-enum-value');
const resolveNanosecondsTimestamp = require('../../utils/resolve-nanoseconds-timestamp');
const normalizeEvents = require('../../utils/normalize-events');
const awsRequest = require('../../utils/aws-request');
const resolveTestVariantsConfig = require('../../lib/resolve-test-variants-config');
const resolveFileZipBuffer = require('../../utils/resolve-file-zip-buffer');
const { exec } = require('node:child_process');

const fixturesDirname = path.resolve(
  __dirname,
  '../../../../python/packages/aws-lambda-sdk/tests/fixtures/lambdas'
);

for (const name of ['TEST_EXTERNAL_LAYER_FILENAME']) {
  // In tests, current working directory is mocked,
  // so if relative path is provided in env var it won't be resolved properly
  // with this patch we resolve it before cwd mocking
  if (process.env[name]) process.env[name] = path.resolve(process.env[name]);
}

describe('Python: integration', function () {
  this.timeout(120000);
  const coreConfig = {};

  const getCreateHttpApi = (payloadFormatVersion) => async (testConfig) => {
    const apiId = (testConfig.apiId = (
      await awsRequest(ApiGatewayV2, 'createApi', {
        Name: testConfig.configuration.FunctionName,
        ProtocolType: 'HTTP',
      })
    ).ApiId);
    const deferredAddPermission = awsRequest(Lambda, 'addPermission', {
      FunctionName: testConfig.configuration.FunctionName,
      Principal: '*',
      Action: 'lambda:InvokeFunction',
      SourceArn: `arn:aws:execute-api:${process.env.AWS_REGION}:${coreConfig.accountId}:${apiId}/*`,
      StatementId: testConfig.name,
    });
    const integrationId = (
      await awsRequest(ApiGatewayV2, 'createIntegration', {
        ApiId: apiId,
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: `arn:aws:lambda:${process.env.AWS_REGION}:${coreConfig.accountId}:function:${testConfig.configuration.FunctionName}`,
        PayloadFormatVersion: payloadFormatVersion,
      })
    ).IntegrationId;

    await awsRequest(ApiGatewayV2, 'createRoute', {
      ApiId: apiId,
      RouteKey: 'POST /test',
      Target: `integrations/${integrationId}`,
    });

    await awsRequest(ApiGatewayV2, 'createStage', {
      ApiId: apiId,
      StageName: '$default',
      AutoDeploy: true,
    });

    await deferredAddPermission;
  };

  const devModeConfiguration = {
    configuration: {
      Environment: {
        Variables: {
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/sls-sdk-python/exec_wrapper.py',
          SLS_ORG_ID: process.env.SLS_ORG_ID,
          SLS_DEV_MODE_ORG_ID: process.env.SLS_ORG_ID,
          SLS_SDK_DEBUG: '1',
        },
      },
    },
    deferredConfiguration: () => ({
      Layers: [coreConfig.layerInternalArn, coreConfig.layerExternalArn],
    }),
  };

  const flaskInvoke = async function self(testConfig) {
    const startTime = process.hrtime.bigint();
    const response = await fetch(
      `https://${testConfig.apiId}.execute-api.${process.env.AWS_REGION}.amazonaws.com/test`,
      {
        method: 'POST',
        body: JSON.stringify({ some: 'content' }),
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
    if (response.status !== 200) {
      if (response.status === 404) {
        await wait(1000);
        return self(testConfig);
      }
      throw new Error(`Unexpected response status: ${response.status}`);
    }
    const payload = { raw: await response.text() };
    const duration = Math.round(Number(process.hrtime.bigint() - startTime) / 1000000);
    log.debug('invoke response payload %s', payload.raw);
    return { duration, payload };
  };

  const sdkTestConfig = {
    isCustomResponse: true,
    capturedEvents: [
      { name: 'telemetry.error.generated.v1', type: 'ERROR_TYPE_CAUGHT_USER' },
      { name: 'telemetry.error.generated.v1', type: 'ERROR_TYPE_CAUGHT_USER' },
      { name: 'telemetry.warning.generated.v1', type: 'WARNING_TYPE_USER' },
      { name: 'telemetry.warning.generated.v1', type: 'WARNING_TYPE_USER' },
    ],
    test: ({ invocationsData }) => {
      for (const [index, { trace, responsePayload }] of invocationsData.entries()) {
        const { spans, events, customTags } = trace;
        let awsLambdaInvocationSpan;
        if (index === 0) {
          awsLambdaInvocationSpan = spans[2];
          expect(spans.map(({ name }) => name)).to.deep.equal([
            'aws.lambda',
            'aws.lambda.initialization',
            'aws.lambda.invocation',
            'user.span',
          ]);
        } else {
          awsLambdaInvocationSpan = spans[1];
          expect(spans.map(({ name }) => name)).to.deep.equal([
            'aws.lambda',
            'aws.lambda.invocation',
            'user.span',
          ]);
        }
        const payload = JSON.parse(responsePayload.raw);
        expect(payload.name).to.equal(pyProjectToml.project.name);
        expect(payload.version).to.equal(pyProjectToml.project.version);
        expect(payload.rootSpanName).to.equal('aws.lambda');
        expect(JSON.parse(customTags)).to.deep.equal({ 'user.tag': `example:${index + 1}` });

        const normalizeEvent = (event) => {
          event = { ...event };
          expect(Buffer.isBuffer(event.id)).to.be.true;
          expect(typeof event.timestampUnixNano).to.equal('number');
          if (event.tags.error) {
            delete event.tags.error.stacktrace;
            if (event.tags.error.message) {
              event.tags.error.message = event.tags.error.message.split('\n')[0];
            }
          }
          if (event.tags.warning) {
            delete event.tags.warning.stacktrace;
          }
          delete event.id;
          delete event.timestampUnixNano;
          event.customTags = JSON.stringify(JSON.parse(event.customTags));
          return event;
        };
        expect(events.map(normalizeEvent)).to.deep.equal([
          {
            traceId: awsLambdaInvocationSpan.traceId,
            spanId: awsLambdaInvocationSpan.id,
            eventName: 'telemetry.error.generated.v1',
            customTags: JSON.stringify({ 'user.tag': 'example', 'invocationid': index + 1 }),
            tags: {
              error: {
                name: 'Exception',
                message: 'Captured error',
                type: 2,
              },
            },
          },
          {
            traceId: awsLambdaInvocationSpan.traceId,
            spanId: awsLambdaInvocationSpan.id,
            eventName: 'telemetry.error.generated.v1',
            customTags: JSON.stringify({}),
            tags: {
              error: {
                name: 'str',
                message: 'My error:',
                type: 2,
              },
            },
          },
          {
            traceId: awsLambdaInvocationSpan.traceId,
            spanId: awsLambdaInvocationSpan.id,
            eventName: 'telemetry.warning.generated.v1',
            customTags: JSON.stringify({ 'user.tag': 'example', 'invocationid': index + 1 }),
            tags: {
              warning: {
                message: 'Captured warning',
                type: 1,
              },
            },
          },
          {
            traceId: awsLambdaInvocationSpan.traceId,
            spanId: awsLambdaInvocationSpan.id,
            eventName: 'telemetry.warning.generated.v1',
            customTags: JSON.stringify({}),
            tags: {
              warning: {
                message: 'Consoled warning 12 True',
                type: 1,
              },
            },
          },
        ]);
      }
    },
  };

  const httpTestConfig = new Map([
    [
      'http',
      {
        test: ({ invocationsData }) => {
          for (const [
            index,
            {
              trace: { spans },
            },
          ] of invocationsData.entries()) {
            spans.shift();
            if (!index) spans.shift();
            const [invocationSpan, httpRequestSpan] = spans;

            expect(httpRequestSpan.name).to.equal('python.http.request');
            expect(httpRequestSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());

            const { tags } = httpRequestSpan;
            expect(tags.http.method).to.equal('GET');
            expect(tags.http.protocol).to.equal('HTTP/1.1');
            expect(tags.http.host).to.equal('127.0.0.1:3177');
            expect(tags.http.path).to.equal('/');
            expect(tags.http.queryParameterNames).to.deep.equal(['foo']);
            expect(tags.http.requestHeaderNames).to.deep.equal(['someHeader']);
            expect(tags.http.statusCode.toString()).to.equal('200');
          }
        },
      },
    ],
    [
      'https',
      {
        hooks: {
          afterCreate: async function self(testConfig) {
            const urlEndpointLambdaName =
              (testConfig.urlEndpointLambdaName = `${testConfig.configuration.FunctionName}-endpoint`);
            try {
              await awsRequest(Lambda, 'createFunction', {
                FunctionName: urlEndpointLambdaName,
                Handler: 'api-endpoint.handler',
                Role: coreConfig.roleArn,
                Runtime: 'python3.9',
                Code: {
                  ZipFile: resolveFileZipBuffer(path.resolve(fixturesDirname, 'api-endpoint.py')),
                },
                MemorySize: 1024,
              });
            } catch (error) {
              if (
                error.message.includes(
                  'The role defined for the function cannot be assumed by Lambda'
                ) ||
                error.message.includes('because the KMS key is invalid for CreateGrant')
              ) {
                // Occassional race condition issue on AWS side, retry
                await self(testConfig);
                return;
              }
              if (error.message.includes('Function already exist')) {
                log.notice('Function %s already exists, deleting and re-creating', testConfig.name);
                await awsRequest(Lambda, 'deleteFunction', {
                  FunctionName: urlEndpointLambdaName,
                });
                await self(testConfig);
                return;
              }
              throw error;
            }
            await awsRequest(Lambda, 'createAlias', {
              FunctionName: urlEndpointLambdaName,
              FunctionVersion: '$LATEST',
              Name: 'url',
            });
            const deferredFunctionUrl = (async () => {
              try {
                return (
                  await awsRequest(Lambda, 'createFunctionUrlConfig', {
                    AuthType: 'NONE',
                    FunctionName: urlEndpointLambdaName,
                    Qualifier: 'url',
                  })
                ).FunctionUrl;
              } catch (error) {
                if (error.message.includes('FunctionUrlConfig exists for this Lambda function')) {
                  return (
                    await awsRequest(Lambda, 'getFunctionUrlConfig', {
                      FunctionName: urlEndpointLambdaName,
                      Qualifier: 'url',
                    })
                  ).FunctionUrl;
                }
                throw error;
              }
            })();
            await Promise.all([
              deferredFunctionUrl,
              awsRequest(Lambda, 'addPermission', {
                FunctionName: urlEndpointLambdaName,
                Qualifier: 'url',
                FunctionUrlAuthType: 'NONE',
                Principal: '*',
                Action: 'lambda:InvokeFunctionUrl',
                StatementId: 'public-function-url',
              }),
            ]);
            testConfig.functionUrl = await deferredFunctionUrl;
            let state;
            do {
              await wait(100);
              ({
                Configuration: { State: state },
              } = await awsRequest(Lambda, 'getFunction', {
                FunctionName: urlEndpointLambdaName,
              }));
            } while (state !== 'Active');
          },
          beforeDelete: async (testConfig) => {
            await Promise.all([
              awsRequest(Lambda, 'deleteFunctionUrlConfig', {
                FunctionName: testConfig.urlEndpointLambdaName,
                Qualifier: 'url',
              }),
              awsRequest(Lambda, 'deleteFunction', {
                FunctionName: testConfig.urlEndpointLambdaName,
              }),
            ]);
          },
        },
        invokePayload: (testConfig) => {
          return { url: `${testConfig.functionUrl}?foo=bar` };
        },
        test: ({ invocationsData, testConfig: { functionUrl } }) => {
          for (const [
            index,
            {
              trace: { spans },
            },
          ] of invocationsData.entries()) {
            spans.shift();
            if (!index) spans.shift();
            const [invocationSpan, httpRequestSpan] = spans;

            expect(httpRequestSpan.name).to.equal('python.https.request');
            expect(httpRequestSpan.parentSpanId.toString()).to.equal(invocationSpan.id.toString());

            const { tags } = httpRequestSpan;
            expect(tags.http.method).to.equal('GET');
            expect(tags.http.protocol).to.equal('HTTP/1.1');
            expect(tags.http.host.match(functionUrl.slice('https://'.length, -1))).to.not.be.null;
            expect(tags.http.path).to.equal('/');
            expect(tags.http.queryParameterNames).to.deep.equal(['foo']);
            expect(tags.http.requestHeaderNames).to.deep.equal(['someHeader']);
            expect(tags.http.statusCode.toString()).to.equal('200');
          }
        },
      },
    ],
  ]);

  const useCasesConfig = new Map([
    [
      'success',
      {
        variants: new Map([
          ['v3-8', { configuration: { Runtime: 'python3.8' } }],
          ['v3-9', { configuration: { Runtime: 'python3.9' } }],
          [
            'sampled',
            {
              configuration: {
                Environment: {
                  Variables: {
                    SLS_ORG_ID: process.env.SLS_ORG_ID,
                    SLS_CRASH_ON_SDK_ERROR: '1',
                    AWS_LAMBDA_EXEC_WRAPPER: '/opt/sls-sdk-python/exec_wrapper.py',
                  },
                },
              },
            },
          ],
        ]),
      },
    ],
    [
      'error',
      {
        variants: new Map([
          ['v3-8', { configuration: { Runtime: 'python3.8' } }],
          ['v3-9', { configuration: { Runtime: 'python3.9' } }],
        ]),
        config: { expectedOutcome: 'error:handled' },
      },
    ],
    [
      'error_unhandled',
      {
        variants: new Map([
          ['v3-8', { configuration: { Runtime: 'python3.8' } }],
          ['v3-9', { configuration: { Runtime: 'python3.9' } }],
        ]),
        config: { expectedOutcome: 'error:unhandled' },
      },
    ],
    [
      'sdk',
      {
        variants: new Map([
          ['v3-8', { configuration: { Runtime: 'python3.8' } }],
          ['v3-9', { configuration: { Runtime: 'python3.9' } }],
          ['dev-mode', devModeConfiguration],
        ]),
        config: sdkTestConfig,
      },
    ],
    [
      'dashboard/s_hello',
      {
        variants: new Map([
          ['v3-8', { configuration: { Runtime: 'python3.8' } }],
          ['v3-9', { configuration: { Runtime: 'python3.9' } }],
        ]),
      },
    ],
    [
      'http_requester',
      {
        variants: httpTestConfig,
      },
    ],
    [
      'aiohttp_requester',
      {
        variants: httpTestConfig,
      },
    ],
    [
      'flask_app',
      {
        hooks: {
          afterCreate: getCreateHttpApi('2.0'),
          beforeDelete: async (testConfig) => {
            await awsRequest(ApiGatewayV2, 'deleteApi', { ApiId: testConfig.apiId });
          },
        },
        invoke: flaskInvoke,
        test: ({ invocationsData }) => {
          for (const [
            index,
            {
              trace: { spans },
            },
          ] of invocationsData.entries()) {
            spans.shift();
            if (!index) spans.shift();

            const [invocationSpan, flaskSpan, ...routeSpans] = spans;
            expect(flaskSpan.parentSpanId).to.deep.equal(invocationSpan.id);

            expect(routeSpans.map(({ name }) => name)).to.deep.equal(['flask.route.post.test']);
            for (const routeSpan of routeSpans) {
              expect(String(routeSpan.parentSpanId)).to.equal(String(flaskSpan.id));
            }
          }
        },
      },
    ],
  ]);

  const testVariantsConfig = resolveTestVariantsConfig(useCasesConfig);

  let pyProjectToml;
  let beforeTimestamp;

  before(async () => {
    exec(
      `pip install aiohttp==3.8.4 serverless-wsgi==3.0.2 flask==2.2.3 --target="${fixturesDirname}/test_dependencies"`
    );

    pyProjectToml = toml.parse(
      await fsp.readFile(
        path.resolve(__dirname, '../../../../python/packages/aws-lambda-sdk/pyproject.toml'),
        'utf8'
      )
    );
    await createCoreResources(coreConfig);

    const processFunction = await getProcessFunction(basename, coreConfig, {
      TracePayload,
      fixturesDirname,
      baseLambdaConfiguration: {
        Runtime: 'python3.9',
        Layers: [coreConfig.layerInternalArn],
        Environment: {
          Variables: {
            AWS_LAMBDA_EXEC_WRAPPER: '/opt/sls-sdk-python/exec_wrapper.py',
          },
        },
      },
    });

    beforeTimestamp = resolveNanosecondsTimestamp() - 2000000000; // 2 seconds ago

    for (const testConfig of testVariantsConfig) {
      testConfig.deferredResult = processFunction(testConfig).catch((error) => ({
        // As we process result promises sequentially step by step in next turn, allowing them to
        // reject will generate unhandled rejection.
        // Therefore this scenario is converted to successuful { error } resolution
        error,
      }));
    }
  });

  for (const testConfig of testVariantsConfig) {
    // eslint-disable-next-line no-loop-func
    it(testConfig.name, async () => {
      const testResult = await testConfig.deferredResult;
      if (testResult.error) throw testResult.error;
      log.debug('%s test result: %o', testConfig.name, testResult);
      const afterTimestamp = resolveNanosecondsTimestamp() + 2000000000; // 2 seconds after
      const { expectedOutcome, capturedEvents } = testConfig;
      const { invocationsData } = testResult;
      if (
        expectedOutcome === 'success' ||
        expectedOutcome === 'error:handled' ||
        expectedOutcome === 'error:unhandled'
      ) {
        if (
          expectedOutcome === 'success' &&
          !testConfig.isAsyncInvocation &&
          !testConfig.isCustomResponse
        ) {
          for (const { responsePayload } of invocationsData) {
            expect(responsePayload.raw).to.equal('"ok"');
          }
        }
        for (const [index, { trace }] of invocationsData.entries()) {
          if (!trace) throw new Error('Missing trace payload');
          const { spans, slsTags, events } = trace;
          const lambdaSpan = spans[0];
          if (index === 0 || expectedOutcome === 'error:unhandled') {
            expect(spans.map(({ name }) => name).slice(0, 3)).to.deep.equal([
              'aws.lambda',
              'aws.lambda.initialization',
              'aws.lambda.invocation',
            ]);
            expect(lambdaSpan.tags.aws.lambda.isColdstart).to.be.true;
            const [, initializationSpan, invocationSpan] = spans;
            expect(String(initializationSpan.parentSpanId)).to.equal(String(lambdaSpan.id));
            expect(String(invocationSpan.parentSpanId)).to.equal(String(lambdaSpan.id));
            expect(lambdaSpan.startTimeUnixNano).to.equal(initializationSpan.startTimeUnixNano);
            expect(lambdaSpan.endTimeUnixNano).to.equal(invocationSpan.endTimeUnixNano);
            if (initializationSpan.endTimeUnixNano > invocationSpan.startTimeUnixNano) {
              throw new Error('Initialization span overlaps invocation span');
            }
          } else {
            if (!testConfig.hasOrphanedSpans) {
              expect(spans.map(({ name }) => name).slice(0, 2)).to.deep.equal([
                'aws.lambda',
                'aws.lambda.invocation',
              ]);
              const [, invocationSpan] = spans;
              expect(lambdaSpan.startTimeUnixNano).to.equal(invocationSpan.startTimeUnixNano);
              expect(lambdaSpan.endTimeUnixNano).to.equal(invocationSpan.endTimeUnixNano);
            }
            expect(lambdaSpan.tags.aws.lambda.isColdstart).to.be.false;
            const [, invocationSpan] = spans;
            expect(String(invocationSpan.parentSpanId)).to.equal(String(lambdaSpan.id));
          }
          for (const span of spans) {
            if (span.endTimeUnixNano <= span.startTimeUnixNano) {
              throw new Error(
                `Span ${span.name} has invalid time range: ` +
                  `${span.startTimeUnixNano} - ${span.endTimeUnixNano}`
              );
            }
            if (span.startTimeUnixNano < beforeTimestamp) {
              throw new Error(
                `Span ${span.name} has invalid start time: ${span.startTimeUnixNano}`
              );
            }
            if (span.endTimeUnixNano > afterTimestamp) {
              throw new Error(`Span ${span.name} has invalid end time: ${span.endTimeUnixNano}`);
            }
            if (!testConfig.hasOrphanedSpans) {
              if (span.startTimeUnixNano < lambdaSpan.startTimeUnixNano) {
                throw new Error(
                  `Span ${span.name} start time is earlier than start time of ` +
                    `root span: ${span.startTimeUnixNano}`
                );
              }
              if (span.endTimeUnixNano > lambdaSpan.endTimeUnixNano) {
                throw new Error(
                  `Span ${span.name} end time is past end time of ` +
                    `root span: ${span.startTimeUnixNano}`
                );
              }
            }
          }
          expect(slsTags).to.deep.equal({
            orgId: process.env.SLS_ORG_ID,
            service: testConfig.configuration.FunctionName,
            sdk: { name: pyProjectToml.project.name, version: pyProjectToml.project.version },
          });
          expect(lambdaSpan.tags.aws.lambda).to.have.property('arch');
          expect(lambdaSpan.tags.aws.lambda.name).to.equal(testConfig.configuration.FunctionName);
          expect(lambdaSpan.tags.aws.lambda).to.have.property('requestId');
          expect(lambdaSpan.tags.aws.lambda).to.have.property('version');
          expect(lambdaSpan.tags.aws.lambda.outcome).to.equal(
            resolveOutcomeEnumValue(expectedOutcome)
          );
          const normalizedEvents = normalizeEvents(events);
          if (expectedOutcome === 'success') {
            if (!capturedEvents) expect(normalizedEvents).deep.equal([]);
          } else {
            const errorTags = events.find(
              (event) => event.tags.error && event.tags.error.type === 1
            ).tags.error;
            expect(typeof errorTags.message).to.equal('string');
            expect(typeof errorTags.stacktrace).to.equal('string');
            if (!capturedEvents) {
              expect(normalizedEvents).deep.equal([
                {
                  name: 'telemetry.error.generated.v1',
                  type: 'ERROR_TYPE_UNCAUGHT',
                },
              ]);
            }
          }
          if (capturedEvents) expect(normalizedEvents).deep.equal(capturedEvents);
        }
      }

      if (testConfig.test) {
        testConfig.test({ invocationsData, testConfig });
      }
    });
  }

  after(async () => {
    cleanup({ mode: 'core' });
    await fsp.rmdir(`${fixturesDirname}/test_dependencies`, { recursive: true, force: true });
  });
});
