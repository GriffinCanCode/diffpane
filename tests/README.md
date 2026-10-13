---
doc_radar:
  sentinels:
    - file: tests/app.e2e.mjs
      contains: ['4000', '80', 'rendererErrors']
    - file: tests/files.e2e.mjs
      contains: ['file-picker', 'view-files', 'node:assert/strict']
    - file: tests/languages.integration.mjs
      contains: ['LanguageRuntime', 'swift', 'elixir']
    - file: tests/configs.e2e.mjs
      contains: ['settings.jsonc', 'source byte']
    - file: tests/billy.integration.mjs
      contains: ['ls-files', 'billy-filetypes.json']
    - file: tests/repository.test.mjs
      contains: ['Repository.open', 'node:test']
---

# Checks

We test actual Git repositories, including partial staging, unusual paths, renames, worktrees, conflicts, binary previews, and ignore behavior. The Electron check drives the real app through edits and scrolling, then verifies models are released when files leave the viewport. The file-viewer check reads unchanged code, saves and commits it, searches the picker, and launches a file directly.

The config check exercises syntax colors, source preservation, live updates, and keyboard navigation in Electron. The optional Billy check reads the tracked inventory, opens text representatives, and records actual language IDs and preview limits without changing the checkout.

The language matrix runs actual servers serially against nested projects and checks advertised capabilities, real responses, and process cleanup.

Run `npm test` for the backend and documentation; run `npm run build && npm run test:app` for the desktop check. App screenshots land in the ignored `test-results` directory.
