# ARM-24 / DSV-021 Design QA

## Evidence

- Source visual truth: `artifacts/design-qa/source-discovery-desktop.png` — the shipped DSV-020 Discovery workspace.
- Initial desktop implementation: `artifacts/design-qa/operator-desktop.png`.
- Final desktop implementation: `artifacts/design-qa/operator-desktop-revised.png`.
- Mobile implementation: `artifacts/design-qa/operator-mobile.png`.
- Combined comparison input: `artifacts/design-qa/design-qa-comparison.png`.
- Source pixels: 1425 × 1036; final desktop implementation pixels: 1425 × 1392; combined pixels: 2882 × 1456.
- Desktop CSS viewport override: 1440 × 1000; device scale factor unchanged. Both captures have the same 1425 px content width, so no density normalization was required. Heights differ because the operator console includes a full evidence region below the queue.
- Mobile CSS viewport override: 390 × 844; full-page capture pixels: 375 × 2157. The browser's scrollbar/content treatment accounts for the 15 px width difference.
- State: dark theme, deterministic demo fixtures, healthy and quarantined sources, an active breaker, company and opportunity reviews, empty evidence prompt, populated evidence view, and decision dialog.

## Findings

- No actionable P0, P1, or P2 findings remain.
- [P3] The 390 px navigation remains horizontally scrollable as in the source visual system. All current operator destinations remain visible; this can be revisited as more destinations become active.

## Required Fidelity Surfaces

- Fonts and typography: preserves the source's system-sans body, heavy oversized display heading, compact uppercase mono evidence labels, tight headline tracking, and readable operational metadata. Desktop and mobile wrapping is intentional and unclipped.
- Spacing and layout rhythm: preserves the sidebar/content frame, generous top hierarchy, one-pixel grouped metric surfaces, compact evidence cards, fine borders, and low radii. The two-column work area collapses cleanly to one column without overlap.
- Colors and visual tokens: reuses the near-black/teal radial background, mint primary actions, muted blue-gray metadata, amber review states, and red quarantine state. Tokens retain the source hierarchy and semantic contrast.
- Image quality and asset fidelity: neither source nor implementation relies on imagery, illustrations, non-standard icons, or logo artwork beyond text branding. No placeholder imagery, CSS art, handcrafted SVG, or glyph substitute was introduced.
- Copy and content: operator copy is evidence-first, explains irreversible audit recording and reversible domain actions, distinguishes paused/quarantined states, and explicitly states that raw response bodies, headers, and credential-bearing URLs are unavailable.
- States and accessibility: semantic navigation, summary region, headings, native selects, buttons, labeled mandatory-reason textarea, native dialog, live status output, loading/failure/empty/populated states, focusable actions, and responsive tap targets were verified. Browser console errors and warnings were empty.

## Full-View Comparison Evidence

`artifacts/design-qa/design-qa-comparison.png` places the source Discovery workspace and final operator implementation in the same image. The comparison shows a coherent extension of the existing product rather than a redesign: identical dark-teal canvas, sidebar proportions, heavy white heading, mint labels and actions, fine bordered surfaces, restrained semantic colors, and matching density. The information architecture changes intentionally from search/results/detail to health metrics/source queue/review queue/evidence, while the visual grammar remains stable.

## Focused Region Evidence

The combined 2882 × 1456 comparison keeps headings, filters, source cards, review cards, pills, actions, and evidence copy legible, so a separate crop was not necessary. Mobile received a dedicated full-page capture because stacking, navigation overflow, action wrapping, filter alignment, status pills, and tap targets could not be evaluated from the desktop comparison.

## Interaction Verification

- Loaded healthy and quarantined sources plus company and opportunity review fixtures.
- Filter controls rendered and remained usable at desktop and 390 px widths.
- Opened a source's redacted evidence view and verified scan ledger, artifact count, breaker history, and raw-artifact restriction copy.
- Opened the company merge decision dialog, entered a mandatory reason, submitted in non-persistent demo mode, and verified the success state.
- Verified source pause/activation, breaker-clearance, company-merge, and opportunity-attach controls are present; no destructive bulk action exists.
- Checked browser console errors and warnings after interactions: zero entries.

## Comparison History

1. Initial desktop pass found a P2 readability issue: native selects were cramped against their uppercase `View` and `Type` labels, and status/review pills could grow into circular shapes.
2. Fix: added flex alignment and spacing to `.heading label`, normalized `.heading select`, and constrained `.operator-head .pill` to content height with no wrapping in `apps/web/src/operator-shell.ts`.
3. Post-fix evidence: `artifacts/design-qa/operator-desktop-revised.png` shows aligned filter controls and compact horizontal pills. `artifacts/design-qa/operator-mobile.png` confirms the fix at 390 px without card, action, or evidence-region regressions.

## Implementation Checklist

- [x] Preserve the DSV-020 dark evidence-first visual language.
- [x] Render healthy, blocked/quarantined, review, loading, empty, error, and populated evidence states.
- [x] Keep raw artifact bytes, response headers, and credential-bearing URLs outside the console.
- [x] Require reasons, CSRF evidence, and idempotency keys for operator mutations.
- [x] Make source inspection and review decisions functional with realistic fixtures.
- [x] Verify desktop and mobile rendering, dialog submission, and console output.
- [x] Resolve all P0/P1/P2 visual findings.

## Follow-up Polish

- P3: revisit compact navigation behavior when the operator console gains enough destinations to justify a mobile menu treatment.

final result: passed
