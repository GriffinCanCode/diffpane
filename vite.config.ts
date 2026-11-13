import { defineConfig, lazyPlugins } from 'vite-plus'
import { safetyLint } from './oxlint-safety.ts'
import { typeAwareLint } from './oxlint-typeaware.ts'
export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  fmt: {
    printWidth: 120,
    tabWidth: 2,
    useTabs: false,
    singleQuote: true,
    semi: false,
    trailingComma: 'all',
    arrowParens: 'avoid',
    endOfLine: 'lf',
    sortImports: {
      newlinesBetween: false,
      partitionByNewline: true,
      groups: ['builtin', 'external', ['internal', 'subpath'], ['parent', 'sibling', 'index'], 'unknown'],
    },
    ignorePatterns: ['syntax/*.json'],
  },
  lint: {
    extends: [safetyLint, typeAwareLint],
    plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import', 'promise', 'node'],
    categories: { correctness: 'error', suspicious: 'error', perf: 'error' },
    env: { node: true },
    ignorePatterns: ['electron/preload.cjs'],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'eslint/no-undef': 'error',
      'eslint/no-unused-expressions': ['error', { allowTernary: true }],
      'eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'eslint/no-console': ['error', { allow: ['info', 'warn', 'error'] }],
      'eslint/prefer-template': 'error',
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      'import/no-unassigned-import': ['error', { allow: ['**/*.css', '@parcel/watcher', 'monaco-editor/**/*.js'] }],
      'typescript/no-explicit-any': 'error',
      'typescript/no-non-null-assertion': 'error',
      'typescript/consistent-type-definitions': ['error', 'interface'],
    },
    overrides: [
      { files: ['renderer/**/*.{ts,js}', 'shortcuts.ts'], env: { browser: true } },
      // Node Worker and MessagePort are point-to-point and have no target origin argument.
      {
        files: ['electron/main.mjs', 'electron/session.mjs', 'electron/diff-worker.ts'],
        rules: { 'unicorn/require-post-message-target-origin': 'off' },
      },
      {
        files: ['tests/*.test.{ts,mjs}'],
        plugins: ['vitest'],
        rules: {
          'vitest/no-focused-tests': 'error',
          'vitest/no-standalone-expect': [
            'error',
            { additionalTestBlockFunctions: ['beforeAll', 'beforeEach', 'afterAll', 'afterEach'] },
          ],
          'vitest/valid-expect': ['error', { maxArgs: 2 }],
          'vitest/valid-expect-in-promise': 'error',
        },
      },
    ],
    options: { denyWarnings: true, reportUnusedDisableDirectives: 'error', typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(async () => {
    const { syntaxCatalog } = await import('./syntax.ts')
    return [syntaxCatalog()]
  }),
  base: './',
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 2500,
    outDir: 'dist',
    reportCompressedSize: false,
    sourcemap: false,
  },
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@wooorm/starry-night', '@shikijs/langs'],
  },
  test: {
    environment: 'node',
    // Git-backed suites spawn native processes and watchers. Bound their shared concurrency.
    maxWorkers: 4,
    include: ['tests/*.test.mjs', 'tests/*.test.ts'],
  },
  run: {
    tasks: {
      bundle: {
        command: 'vp build',
        cache: {
          env: ['NODE_ENV', 'VITE_*'],
          input: [
            { auto: true },
            'renderer/**',
            'syntax/**',
            'syntax.ts',
            'app-errors.ts',
            'ideas.ts',
            'media-types.ts',
            'review-notes.ts',
            'text-lines.ts',
            'shortcuts.ts',
            'public/**',
            '!dist/**',
          ],
          output: ['dist/**'],
        },
      },
    },
  },
})
