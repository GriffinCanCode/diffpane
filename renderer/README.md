---
doc_radar:
  sentinels:
    - file: renderer/main.js
      contains: ['createDecorationsCollection', 'restoreViewState', 'model.applyEdits']
    - file: renderer/navigator.js
      contains: ['flattenNavigationTree', 'OVERSCAN', 'requestAnimationFrame']
    - file: renderer/languages.js
      contains: ['createLanguageFeatures', 'semanticChanged', 'inlayHints']
    - file: renderer/grammars.js
      contains: ['createOnigurumaEngine', 'shikiToMonaco']
    - file: renderer/icons.js
      contains: ['material-icon-theme']
---

# Viewer

The explorer projects metadata into a virtualized folder tree. Its flat chrome and Material icons follow the supplied editor reference; filtering appears when typing or using ⌘F in the tree. Files opens one full-height editor; Changes keeps light cards and mounts Monaco around the viewport. Each editor shows current code with Git decorations.

Language providers attach to visible models. Syntax grammars load on demand; real language servers supply only the features they advertise. Requests cancel when models change or close, and stale results never replace newer content.

Live updates edit the existing model and restore its view state. Editor disposal keeps the card height and view state. The chrome uses OKLCH colors and adapts to narrower windows.
