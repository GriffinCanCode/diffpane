---
doc_radar:
  sentinels:
    - file: app/tests/interface/ideas/idea-markdown.test.ts
      contains: ['vite-plus/test']
---

# Ideas tests

The notebook uses these checks to preserve Markdown structure and editing behavior in the Ideas panel. Store and migration coverage lives in the runtime project suite.

- [Idea Markdown](idea-markdown.test.ts). Exercise Markdown handling in the notebook editor.

Run `npm test -- app/tests/interface/ideas` from the repository root.
