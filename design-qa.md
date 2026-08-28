# Video history detail design QA

## Scope

- Reference: `C:\Users\LIUHAO~1\AppData\Local\Temp\codex-clipboard-7e3a6977-4beb-4bba-9df9-0b1c776ea83d.png`
- Implementation capture: `outputs/ui-audit/06-video-segment-side-by-side-final.png`
- Combined comparison: `outputs/ui-audit/07-video-layout-comparison.png`
- State: completed three-segment G2 project opened from history at a 1692 × 842 CSS-pixel viewport.

## Comparison

- Layout: each segment now uses a two-column 1082 × 275 px body. The video is fixed at 489 × 275 px on the left and the 575 × 275 px prompt editor fills the right column.
- Stability: the merged video and segment players have fixed aspect-ratio boxes. All four modal videos use `preload="metadata"` and have first-frame poster URLs, so their cards reserve space before media loading.
- Controls: the prompt textarea fills the available editor height. Download remains secondary while regeneration uses the product's red primary treatment, with a distinct disabled state.
- Content: three segment prompts hydrate from the stored project and remain editable. Each segment retains its status and duration label.
- Responsive behavior: the two-column layout collapses to a single column at the existing mobile breakpoint without changing desktop behavior.

## Visual review

- P0: none.
- P1: none. The original empty-right-space and vertical prompt layout are resolved.
- P2: none. Typography, borders, spacing, radii, and button colors follow the existing RedBase history UI tokens.

final result: passed
