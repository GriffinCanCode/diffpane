import type { OxlintConfig } from 'oxlint'

export const safetyLint = {
  rules: {
    'eslint/array-callback-return': 'error',
    'eslint/eqeqeq': ['error', 'always'],
    'eslint/no-constructor-return': 'error',
    'eslint/no-fallthrough': 'error',
    'eslint/no-new-func': 'error',
    'eslint/no-promise-executor-return': [
      'error',
      {
        allowVoid: true,
      },
    ],
    'eslint/no-prototype-builtins': 'error',
    'eslint/no-var': 'error',
    'eslint/prefer-const': 'error',
    'eslint/preserve-caught-error': 'error',
    'typescript/ban-ts-comment': [
      'error',
      {
        'ts-ignore': true,
        'ts-nocheck': true,
        'ts-expect-error': 'allow-with-description',
        minimumDescriptionLength: 10,
      },
    ],
    'typescript/no-confusing-non-null-assertion': 'error',
    'typescript/no-empty-object-type': 'error',
    'typescript/no-import-type-side-effects': 'error',
    'typescript/no-unnecessary-type-constraint': 'error',
    'typescript/no-unsafe-function-type': 'error',
  },
} satisfies OxlintConfig
