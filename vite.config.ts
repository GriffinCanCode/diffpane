import { defineConfig, lazyPlugins } from 'vite-plus';
import { syntaxCatalog } from './syntax.ts';
export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  fmt: {
    singleQuote: true,
    arrowParens: 'avoid',
    ignorePatterns: ['syntax/*.json'],
  },
  lint: {
    categories: { correctness: 'error' },
    env: { browser: true, node: true },
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'eslint/no-undef': 'error',
      'eslint/no-unused-expressions': ['error', { allowTernary: true }],
    },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [syntaxCatalog()]),
  base: './',
  build: { target: 'esnext', chunkSizeWarningLimit: 2500, outDir: 'dist', sourcemap: false },
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@wooorm/starry-night', '@shikijs/langs'],
  },
  test: {
    environment: 'node',
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
            'media-types.ts',
            'text-lines.ts',
            'public/**',
            '!dist/**',
          ],
          output: ['dist/**'],
        },
      },
    },
  },
});
