'use strict';

const path = require('path');
const apiRequest = require('@serverless/utils/api-request');
const backendUrl = require('@serverless/utils/lib/auth/urls').backend;
const createCoreResources = require('../create-core-resources');
const resolveTestScenarios = require('../resolve-test-scenarios');
const processFunction = require('../process-function');
const cleanup = require('../cleanup');
const resolveFileZipBuffer = require('../../utils/resolve-file-zip-buffer');
const { median } = require('../../utils/stats');
const log = require('log').get('test');

const fixturesDirname = path.resolve(__dirname, '../../fixtures/lambdas');
const ingestionServerUrl = `${backendUrl}/ingestion/kinesis`;
const service = 'benchmark';
const stage = 'test';

const resolveIngestionData = async () => {
  const orgToken = process.env.SLS_ORG_TOKEN;
  const orgName = process.env.SLS_ORG_NAME;

  if (!orgToken) {
    log.warn('No SLS_ORG_TOKEN provided - reporting to ingestion server will not be benchmarked');
    return {};
  }
  if (!orgName) {
    log.warn('No SLS_ORG_NAME provided - reporting to ingestion server will not be benchmarked');
    return {};
  }
  const orgId = (await apiRequest(`/api/identity/orgs/name/${orgName}`)).orgId;

  const token = (
    await apiRequest(`/ingestion/kinesis/org/${orgId}/service/${service}/stage/${stage}`)
  ).token.accessToken;

  await apiRequest('/ingestion/kinesis/token', {
    method: 'PATCH',
    body: { orgId, serviceId: service, stage, token },
  });

  return { token, orgId };
};

module.exports = async () => {
  const cases = new Map([
    [
      'bare',
      {
        configuration: {
          Layers: [],
          Environment: { Variables: {} },
        },
      },
    ],
    [
      'external-only',
      {
        configuration: {
          Environment: {
            Variables: {
              SLS_OTEL_USER_SETTINGS: JSON.stringify({ logs: { disabled: true } }),
              DEBUG_SLS_OTEL_LAYER: '1',
            },
          },
        },
      },
    ],
    [
      'to-log',
      {
        configuration: {
          Environment: {
            Variables: {
              AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-extension-internal-node/exec-wrapper.sh',
              DEBUG_SLS_OTEL_LAYER: '1',
              SLS_OTEL_USER_SETTINGS: JSON.stringify({
                metrics: { outputType: 'json' },
                traces: { outputType: 'json' },
                logs: { disabled: true },
              }),
            },
          },
        },
      },
    ],
  ]);

  const { token, orgId } = await resolveIngestionData();
  if (token) {
    cases.set('to-console', {
      configuration: {
        Environment: {
          Variables: {
            AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-extension-internal-node/exec-wrapper.sh',
            DEBUG_SLS_OTEL_LAYER: '1',
            OTEL_RESOURCE_ATTRIBUTES: `sls_service_name=${service},sls_stage=${stage},sls_org_id=${orgId}`,
            SLS_OTEL_USER_SETTINGS: JSON.stringify({
              common: { destination: { requestHeaders: `serverless_token=${token}` } },
              logs: { disabled: true },
              metrics: { destination: `${ingestionServerUrl}/v1/metrics` },
              request: { destination: `${ingestionServerUrl}/v1/request-response` },
              response: { destination: `${ingestionServerUrl}/v1/request-response` },
              traces: { destination: `${ingestionServerUrl}/v1/traces` },
            }),
          },
        },
      },
    });
  }

  const config = new Map([
    [
      'success-callback',
      {
        config: {
          configuration: {
            Code: {
              ZipFile: resolveFileZipBuffer(path.resolve(fixturesDirname, 'success-callback.js')),
            },
          },
        },
        cases,
      },
    ],
  ]);

  const coreConfig = {};
  await createCoreResources(coreConfig);
  const testScenarios = resolveTestScenarios(config, { multiplyBy: 5 });
  for (const testConfig of testScenarios) {
    testConfig.deferredResult = processFunction(testConfig, coreConfig).catch((error) => ({
      // As we process result promises sequentially step by step in next turn, allowing them to
      // reject will generate unhandled rejection.
      // Therefore this scenario is converted to successuful { error } resolution
      error,
    }));
  }

  const resultsMap = new Map();
  for (const testConfig of testScenarios) {
    const testResult = await testConfig.deferredResult;
    if (testResult.error) throw testResult.error;
    const basename = testConfig.name.slice(0, -2);
    if (!resultsMap.has(basename)) resultsMap.set(basename, []);
    resultsMap.get(basename).push(testResult);
  }
  await cleanup({ skipFunctionsCleanup: true });

  process.stdout.write(
    `${[
      [
        'name',
        'external:init',
        'internal:init',
        'aws:init',

        'internal:first:request',
        'internal:first:response',
        'external:first:response',
        'aws:first:duration',
        'aws:first:billedDuration',
        'local:first:duration',
        'aws:first:maxMemoryUsed',

        'internal:following:request',
        'internal:following:response',
        'external:following:response',
        'aws:following:duration',
        'aws:following:billedDuration',
        'local:following:duration',
        'aws:following:maxMemoryUsed',
      ]
        .map(JSON.stringify)
        .join('\t'),
      ...Array.from(resultsMap, ([name, results]) => {
        return [
          JSON.stringify(name),
          Math.round(
            median(
              results.map(
                ({
                  processesData: [
                    {
                      extensionOverheadDurations: { externalInit },
                    },
                  ],
                }) => externalInit || 0
              )
            )
          ),
          Math.round(
            median(
              results.map(
                ({
                  processesData: [
                    {
                      extensionOverheadDurations: { internalInit },
                    },
                  ],
                }) => internalInit || 0
              )
            )
          ),
          Math.round(median(results.map(({ processesData: [{ initDuration }] }) => initDuration))),

          Math.round(
            median(
              results.map(
                ({
                  invocationsData: [
                    {
                      extensionOverheadDurations: { internalRequest },
                    },
                  ],
                }) => internalRequest || 0
              )
            )
          ),
          Math.round(
            median(
              results.map(
                ({
                  invocationsData: [
                    {
                      extensionOverheadDurations: { internalResponse },
                    },
                  ],
                }) => internalResponse || 0
              )
            )
          ),
          Math.round(
            median(
              results.map(
                ({
                  invocationsData: [
                    {
                      extensionOverheadDurations: { externalResponse },
                    },
                  ],
                }) => externalResponse || 0
              )
            )
          ),
          Math.round(median(results.map(({ invocationsData: [{ duration }] }) => duration))),
          Math.round(
            median(results.map(({ invocationsData: [{ billedDuration }] }) => billedDuration))
          ),
          Math.round(
            median(results.map(({ invocationsData: [{ localDuration }] }) => localDuration))
          ),
          Math.round(
            median(results.map(({ invocationsData: [{ maxMemoryUsed }] }) => maxMemoryUsed))
          ),

          Math.round(
            median(
              results.map(
                ({
                  invocationsData: [
                    ,
                    {
                      extensionOverheadDurations: { internalRequest },
                    },
                  ],
                }) => internalRequest || 0
              )
            )
          ),
          Math.round(
            median(
              results.map(
                ({
                  invocationsData: [
                    ,
                    {
                      extensionOverheadDurations: { internalResponse },
                    },
                  ],
                }) => internalResponse || 0
              )
            )
          ),
          Math.round(
            median(
              results.map(
                ({
                  invocationsData: [
                    ,
                    {
                      extensionOverheadDurations: { externalResponse },
                    },
                  ],
                }) => externalResponse || 0
              )
            )
          ),
          Math.round(median(results.map(({ invocationsData: [, { duration }] }) => duration))),
          Math.round(
            median(results.map(({ invocationsData: [, { billedDuration }] }) => billedDuration))
          ),
          Math.round(
            median(results.map(({ invocationsData: [, { localDuration }] }) => localDuration))
          ),
          Math.round(
            median(results.map(({ invocationsData: [, { maxMemoryUsed }] }) => maxMemoryUsed))
          ),
        ].join('\t');
      }),
    ].join('\n')}\n`
  );
};