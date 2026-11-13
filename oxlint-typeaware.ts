import type { OxlintConfig } from 'oxlint'

export const typeAwareLint = {
  plugins: ['typescript'],
  rules: {
    'typescript/no-floating-promises': [
      'error',
      {
        ignoreVoid: false,
      },
    ],
    'typescript/no-misused-promises': 'error',
    'typescript/await-thenable': 'error',
    'typescript/no-implied-eval': 'error',
    'typescript/no-misused-spread': 'error',
    'typescript/no-base-to-string': 'error',
    'typescript/unbound-method': 'error',
    'typescript/no-redundant-type-constituents': 'error',
    'typescript/restrict-template-expressions': 'error',
    'typescript/no-unsafe-assignment': 'error',
    'typescript/no-unsafe-member-access': 'error',
    'typescript/no-unsafe-argument': 'error',
    'typescript/no-unsafe-return': 'error',
    'typescript/no-unsafe-call': 'error',
    'typescript/no-unsafe-enum-comparison': 'error',
    'typescript/no-unnecessary-type-assertion': 'error',
    'typescript/only-throw-error': [
      'error',
      {
        allowThrowingAny: false,
        allowThrowingUnknown: true,
      },
    ],
    'typescript/prefer-optional-chain': 'error',
    'typescript/prefer-nullish-coalescing': 'error',
    'typescript/no-array-delete': 'error',
    'typescript/no-duplicate-type-constituents': 'error',
    'typescript/no-for-in-array': 'error',
    'typescript/no-generated-empty-object-type': 'error',
    'typescript/no-meaningless-void-operator': 'error',
    'typescript/no-mixed-enums': 'error',
    'typescript/no-unsafe-unary-minus': 'error',
    'typescript/no-useless-default-assignment': 'error',
    'typescript/require-array-sort-compare': [
      'error',
      {
        ignoreStringArrays: true,
      },
    ],
    'typescript/related-getter-setter-pairs': 'error',
    'typescript/prefer-promise-reject-errors': [
      'error',
      {
        allowThrowingUnknown: true,
      },
    ],
    'typescript/use-unknown-in-catch-callback-variable': 'error',
    'typescript/switch-exhaustiveness-check': [
      'error',
      {
        considerDefaultExhaustiveForUnions: false,
      },
    ],
    'typescript/return-await': ['error', 'error-handling-correctness-only'],
    'typescript/restrict-plus-operands': [
      'error',
      {
        allowAny: false,
        allowBoolean: false,
        allowNullish: false,
        allowNumberAndString: false,
        allowRegExp: false,
      },
    ],
  },
} satisfies OxlintConfig
