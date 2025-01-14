'use strict';

const path = require('path');

const projectDir = path.resolve(__dirname, '../..');

module.exports = {
  extends: path.resolve(projectDir, '.eslintrc.js'),
  parserOptions: { ecmaVersion: 2019 },
  rules: {
    'import/no-extraneous-dependencies': [
      'error',
      {
        devDependencies: ['**/scripts/**', '**/test/**'],
        packageDir: [projectDir, path.resolve(projectDir, 'packages/sdk')],
      },
    ],
    'no-console': ['error', { allow: ['warn', 'error'] }],
  },
};
