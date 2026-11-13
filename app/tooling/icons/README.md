---
doc_radar:
  sentinels:
    - file: app/tooling/icons/build-icons.ts
      contains: ['sips', 'iconutil', 'faviconSizes', 'favicon.ico']
---

# Icon generation

Run `npm run build:icons` from the repository root on macOS. [`build-icons.ts`](build-icons.ts) reads the [master artwork](../../../branding/desktop/diffpane.png), sizes PNG variants with `sips`, writes a multi-size ICO, and builds the macOS icon with `iconutil`. The generated files live under [branding](../../../branding/README.md).
