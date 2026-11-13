---
doc_radar:
  sentinels:
    - file: app/tests/tooling/assistant/claude-session.test.ts
      contains: ['only when the model asks for it']
---

# Claude session tests

This suite uses controlled model responses to verify the Claude session's ordered activity and workspace tool behavior.

- [Claude session](claude-session.test.ts). Check streamed activity and on-demand workspace reads.

Run `npm test -- app/tests/tooling/assistant` from the repository root.
