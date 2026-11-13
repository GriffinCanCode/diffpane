---
doc_radar:
  sentinels:
    - file: changelog/workspace/review/live-change-review.added
      contains: ['live Changes queue']
---

# Changelog

Each fragment records a shipped change. File names use a descriptive kebab-case slug with an `.added`, `.changed`, `.fixed`, or `.performance` suffix. Older fragments carry their original numeric ID as a two-digit prefix. The IDs trace historical fragments and can recur across categories.

- [Workspace](workspace/README.md). Explorer, search, review and notebook changes.
- [Editor](editor/README.md). Rendering, editing and resource use.
- [Platform](platform/README.md). Desktop launch, recovery and local preferences.
- [Integrations](integrations/README.md). Language tooling and HowMany analysis.
- [Development](development/README.md). Build tooling and performance coverage.

Run `npm run test:docs` from the repository root to validate the documentation assertions.
