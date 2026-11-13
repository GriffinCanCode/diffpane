---
doc_radar:
  sentinels:
    - file: package.json
      contains: ['app/tooling/commands/dev.ts']
---

# Tooling

The root npm scripts are the entry points for these development and release tools.

- [Commands](commands/README.md) owns the Make targets, development launcher, and preload generator.
- [Distribution](distribution/README.md) owns the macOS installer and terminal launcher.
- [Dependencies](dependencies/README.md) owns language tool setup and the bundled HowMany release pin.
- [Grammars](grammars/README.md) owns the syntax catalog and pinned grammar data.
- [Quality](quality/README.md) owns the lint profiles and source-size exception registry.

The [branding index](../../branding/README.md) describes the icon generator and its output locations.
