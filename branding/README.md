---
doc_radar:
  sentinels:
    - file: app/tooling/icons/build-icons.ts
      contains: ['branding/desktop', 'branding/public/img', 'apple-touch-icon.png', 'favicons']
---

# Diffpane icons

- [Desktop](desktop/README.md) owns the master artwork and the macOS package icon.
- [`public/img/`](public/img/) contains the generated window icon and Apple touch icon. [`public/img/favicons/`](public/img/favicons/) holds the browser favicon variants.

Run `npm run build:icons` on macOS to regenerate the browser and desktop icons from the master artwork. The [icon writer](../app/tooling/icons/README.md) owns the output sizes and formats.
