---
doc_radar:
  sentinels:
    - file: app/shared/appearance/palette.ts
      contains: ['colorPairs', 'linearSrgb', 'colorHex']
    - file: app/shared/appearance/typography.ts
      contains: ['editorDefaultSize', 'editorDefaultLineHeight', 'monoFont']
    - file: app/index.html
      contains: ['theme-tokens.css']
---

# Diffpane appearance

[`palette.ts`](palette.ts) defines the light and dark OKLCH values. [`typography.ts`](typography.ts) defines the type scale, font stacks, and editor defaults. The window loads [the generated CSS](../../renderer/shell/workspace/theme-tokens.css) on first paint. Monaco, Mermaid, and Electron receive sRGB hex values through `colorHex`. The Appearance previews resolve the same CSS tokens with their own `color-scheme`.

## Color roles

| Role          | Use                                                                                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neutrals      | Cool slate in light mode and charcoal in dark mode. The dark canvas and workbench both use `oklch(20.904% 0 0)` (sRGB `#181818`). Use `line` for separators and `control-border` when the boundary identifies an input. |
| Blue · 255°   | Primary actions, links, focus, and selection. Pair `action` with `action-text` and `selection` with `text`.                                                                                                             |
| Amber · 75°   | Search highlights and warnings. Pair `match-background` with `match-text` and `warning-surface` with `warning`.                                                                                                         |
| Green · 164°  | Added code and success.                                                                                                                                                                                                 |
| Rose · 15°    | Removed code and errors.                                                                                                                                                                                                |
| Cyan · 225°   | Modified files and informational states.                                                                                                                                                                                |
| Violet · 305° | Secondary categorical emphasis.                                                                                                                                                                                         |

The diff palette distinguishes row, gutter, inline, marker, and text roles. Use a plus or minus in comparison gutters and text labels in the change queue. Working-tree gutter markers use a solid rule for additions, a dashed rule for modifications, and a triangle for deletions. Keep syntax colors on diff rows so users can read the code and see what changed at the same time.

Use `hover` for pointer feedback, `selection` for the current row or mode, and `focus-ring` for keyboard focus. In search, keep amber match highlights visible inside blue selected rows. Use a semantic foreground with its matching surface for warnings, errors, and confirmations. Keep a text label or symbol alongside each state. In reading views and assistant diffs, use the main text color for content and apply status colors to the surrounding label, marker, or surface.

Source inspection uses a flat workbench with editor-specific text, gutter, and toolbar roles. The dark syntax palette uses teal keywords, pink strings and docstrings, lilac numbers and constants, and warm orange symbols. Monaco find results use their own amber foreground and background pairs.

## Typography

The UI and Markdown prose use the platform's system sans-serif. Code defaults to SF Mono, with Menlo, Monaco, Consolas, and Liberation Mono as fallbacks. Code uses 14 px text with a 22 px line height by default. The user's font family and size settings apply to the editor and its settings preview.

| Role                             | Size  |
| -------------------------------- | ----- |
| Caption and metadata             | 11 px |
| Control labels                   | 12 px |
| UI body                          | 13 px |
| Reading content and default code | 14 px |
| Subheading                       | 16 px |
| Heading                          | 20 px |
| Display                          | 26 px |

## Updating the tokens

After editing the source tokens, run `node app/tooling/appearance/theme-css.ts`. Run `npm test -- app/tests/interface/appearance/theme.test.ts` to check the generated CSS, sRGB gamut, and representative color pairs. Text pairs target 4.5:1 and meaningful state indicators target 3:1.
