---
doc_radar:
  sentinels:
    - file: app/tooling/icons/build-icons.ts
      contains: ['branding/desktop', 'diffpane.png', 'diffpane.icns', 'iconutil']
---

# Desktop icons

[`diffpane.png`](diffpane.png) is the 1024 × 1024 master artwork. [`diffpane.icns`](diffpane.icns) is the generated icon for the macOS application bundle. Run `npm run build:icons` after changing the master artwork. The same command regenerates the [window and browser icons](../public/img/).
