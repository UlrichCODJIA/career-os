# ARM-23 / DSV-020 Design QA

## Evidence

- Source visual truth: `artifacts/design-qa/source-shell.png`
- Rendered desktop implementation: `artifacts/design-qa/implementation-desktop-final.png`
- Rendered mobile implementation: `artifacts/design-qa/implementation-mobile-final.png`
- Combined comparison input: `artifacts/design-qa/source-vs-implementation.png`
- Source pixels: 1265 × 828; implementation pixels: 1265 × 1021.
- Desktop CSS viewport: the in-app browser's restored default 1265 px viewport; device scale factor was unchanged. The source and implementation have the same pixel width, so no density normalization was required. Their heights differ because the source is the compact foundation shell while the implementation contains the complete Discovery workspace.
- Mobile CSS viewport: 390 × 844; full-page implementation capture. The explicit override was reset after capture.
- State: dark theme, demo canonical data, first result selected. The second result, stale lifecycle warning, report dialog, report success, filters, and direct-source link were also exercised.

## Findings

- No actionable P0, P1, or P2 findings remain.
- [P3] The mobile primary navigation intentionally scrolls horizontally, so the third future-only destination can be partly visible at 390 px. Core Discovery and private-workspace destinations remain fully visible and reachable.

## Required Fidelity Surfaces

- Fonts and typography: the implementation preserves the source's heavy geometric display hierarchy, compact uppercase mono labels, system sans fallback, tight headline tracking, and readable small evidence text. Wrapping remains intentional at desktop and mobile widths.
- Spacing and layout rhythm: the source's generous dark canvas, fine borders, low-radius evidence cards, and teal-accented grouping carry into a dense two-pane search/detail workspace. The 980 px and 680 px breakpoints collapse the detail pane and sidebar without overlap.
- Colors and visual tokens: the near-black/teal radial background, mint action color, muted blue-gray supporting copy, fine teal borders, and amber stale-state token match the source language and preserve semantic contrast.
- Image quality and asset fidelity: neither source nor implementation uses imagery, logos requiring a source asset, illustrations, or non-standard icons. No placeholder, CSS-art, handcrafted SVG, or fake image substitute was introduced.
- Copy and content: app copy is evidence-first and standalone. It explicitly distinguishes posted/found/verified dates, identifies the shared/private boundary, labels lifecycle uncertainty, and explains that reports cannot mutate canonical state.
- States and accessibility: semantic search, navigation, status regions, buttons, labeled selects, a native dialog, focus styling, loading/error/empty copy, selected cards, stale warnings, report success, and safe external-link attributes were verified. Browser console logs were checked after the interaction pass and were empty.

## Full-View Comparison Evidence

The combined source/implementation image shows the same visual system rather than a 1:1 screen clone: dark teal foundation, oversized white headline, mint evidence labels/actions, hairline bordered surfaces, and restrained system typography. The intentional change is information architecture—the three foundation cards become a persistent product sidebar, canonical search controls, result cards, and a provenance detail pane. Hierarchy, palette, surface treatment, and density remain coherent with the source.

## Focused Region Evidence

A separate crop was not needed: at the equal-width 2530 × 1021 combined comparison, headline typography, filters, result cards, detail actions, evidence metrics, and provenance rows are legible. Mobile received its own full-page capture because responsive stacking and status-pill behavior could not be judged from the desktop comparison.

## Interaction Verification

- Loaded two realistic canonical opportunities in the browser.
- Selected the possibly-closed opportunity and verified its lifecycle warning.
- Opened the report dialog, entered evidence, submitted it in demo mode, and verified the non-mutating success message.
- Verified the employer source uses `target="_blank"` and `rel="noopener noreferrer"`.
- Verified the desktop and 390 px responsive layouts.
- Checked browser console logs: zero entries.

## Comparison History

1. Initial responsive pass found one P2 issue: on mobile, the status pill in `.detail-head` inherited cross-axis stretch and became a tall vertical capsule beside a wrapped title.
2. Fix: added `align-items:flex-start` to `.detail-head` in `apps/web/src/shell.ts`.
3. Post-fix evidence: `artifacts/design-qa/implementation-mobile-final.png` shows the status as a compact horizontal pill with the title wrapping independently. The corrected desktop capture and combined comparison show no regression.

## Implementation Checklist

- [x] Preserve the established dark evidence-first visual language.
- [x] Make canonical search, filters, results, provenance, source links, and reports interactive.
- [x] Keep shared-index queries free of candidate/profile fields.
- [x] Render untrusted API values only through text nodes.
- [x] Provide loading, empty, error, lifecycle-warning, and report-success states.
- [x] Verify desktop and mobile browser rendering.
- [x] Resolve all P0/P1/P2 visual findings.

## Follow-up Polish

- P3: a future mobile navigation iteration can replace horizontal scrolling once the Applications destination becomes active and deserves persistent prominence.

final result: passed
