---
doc_radar:
  sentinels:
    - file: app/renderer/review/notes/review-notes.ts
      contains: ['createReviewNotes']
---

# Review notes

The workspace supplies the selected file or lines as an anchor. This panel sends edits through the preload bridge and displays the saved notes and handoff.

- [`review-notes.ts`](review-notes.ts) — Owns note composition, save and conflict feedback, and anchor navigation.
- [`review-notes.css`](review-notes.css) — Styles the note list, composer, and action controls.

Run `npm run dev -- .` and add, reopen, and copy a handoff for a note. Run `npm test -- app/tests/interface/review/review-notes.test.ts` for shared anchor behavior.
