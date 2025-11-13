// ESLint flat config for argocd-config-updater
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import github from 'eslint-plugin-github';
import vitest from '@vitest/eslint-plugin';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default [
  // Ignore patterns
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.json',
      'vitest.config.mts',
      'eslint.config.mjs',
    ],
  },

  // Base configs
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  github.getFlatConfigs().recommended,

  // Main configuration
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        project: ['./tsconfig-for-eslint.json', './tsconfig.json'],
      },
      globals: {
        ...globals.node,
        ...globals.es6,
        Atomics: 'readonly',
        SharedArrayBuffer: 'readonly',
      },
    },
    rules: {
      camelcase: 'off',
      'eslint-comments/no-use': 'off',
      'eslint-comments/no-unused-disable': 'off',
      'i18n-text/no-en': 'off',
      'import/no-namespace': 'off',
      'import/no-unresolved': 'off', // TypeScript handles this
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@actions/core',
              message:
                'Use of @actions/core is only allowed in index.ts and log.ts',
            },
          ],
        },
      ],
      'no-unused-vars': 'off',
      semi: 'off',
      '@typescript-eslint/array-type': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/consistent-type-assertions': 'error',
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { accessibility: 'no-public' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true },
      ],
      '@typescript-eslint/func-call-spacing': ['error', 'never'],
      '@typescript-eslint/no-array-constructor': 'error',
      '@typescript-eslint/no-empty-interface': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-extraneous-class': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-inferrable-types': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-namespace': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-useless-constructor': 'error',
      '@typescript-eslint/no-var-requires': 'error',
      '@typescript-eslint/prefer-for-of': 'error',
      '@typescript-eslint/prefer-function-type': 'error',
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/space-before-function-paren': 'off',
      '@typescript-eslint/type-annotation-spacing': 'error',
      '@typescript-eslint/unbound-method': 'error',
    },
  },

  // Vitest configuration for test files
  {
    files: ['__tests__/**/*.ts'],
    plugins: {
      vitest,
    },
    rules: {
      ...vitest.configs.recommended.rules,
    },
  },

  // Override for index.ts and log.ts: allow @actions/core imports
  {
    files: ['src/index.ts', 'src/log.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Override for index.ts: disallow exports
  {
    files: ['src/index.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportNamedDeclaration',
          message: 'Exports are not allowed in index.ts',
        },
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Exports are not allowed in index.ts',
        },
        {
          selector: 'ExportAllDeclaration',
          message: 'Exports are not allowed in index.ts',
        },
      ],
    },
  },

  // Prettier must be last
  prettierRecommended,
];
