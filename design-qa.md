# Homepage design QA - September 15, 2026

Target: user-selected option 3, `../generated_images/exec-9120c824-400b-4780-a3c3-92d86648db93.png`.
Implementation: `/display`, local cloud browser, unauthenticated, default range-brief demo.
Viewport: 1363 x 936 CSS pixels. Source image: 1003 x 1570 pixels; normalized to 1363 x 2131 for comparison. Implementation full-page screenshot is 1363 pixels wide at 1x density.

## Findings and corrections

- P1, corrected: shared app styles painted the hero's main surface white. Renamed its landmark ID to avoid the existing `main#main` rule and explicitly set its surface transparent. The demo sidebar now has its own navy surface.
- P2, corrected: the demo was too small and dense relative to the selected concept. Increased desktop demo height to 570px, attachment height to 140px, labels and body sizes, and spacing. Kept compact mobile rules.
- P2, corrected: automatic parser typing ignored reduced-motion preferences. It now shows the complete sample immediately when reduced motion is requested, and does not announce each character while auto-typing.

## Comparison evidence

Full comparison: `../homepage-qa-comparison.jpg`; earlier comparison: `../homepage-comparison.jpg`.
Final browser capture: `/workspace/scratch/homepage-verified.jpg`; initial failing captures: `/workspace/scratch/vantage-homepage-review.jpg` and `/workspace/scratch/vantage-homepage-fixed.jpg`.
Focused demo comparison: `../homepage-demo-comparison.jpg`.

Typography: Inter, strong two-line hero, blue emphasis in the white section, visible body hierarchy. Fonts use existing bundled assets.
Layout: left-aligned hero, dark full-width top, product demonstration, three-step explanation and white evidence section follow the selected reference. Added existing parser, video navigation, FAQ and footer below the reference to preserve required product discovery content.
Colors: navy, white, cobalt and teal retained. Flat supplied logo preserved. Generated contour background stays behind text.
Images: generated topographic background and illustrative field photo are compressed WebP; logo remains the supplied SVG. The training image is marked illustrative and no adoption evidence is claimed.
Content: the mock's decorative sidebar destinations become real demo stage buttons. Source record and report preview are labeled sample content. Removed unverified speed and readiness claims from the mock. This is an intentional functional adaptation, not a claim that the preview is the authenticated app.

## Browser checks

Passed: task selection changes title and outcome; source-record view; report preview; replay; parser recognizes 30 ULOs and $1,118.38; video selection updates the active player; FAQ opens; no horizontal overflow at 1363px. The GTM script appears in the rendered DOM with container GTM-T9N83KTQ.
Console inspection found extension metadata errors only; no application errors in the inspected log.
Mobile CSS is implemented but a dedicated mobile viewport was not available through the browser API. No mobile-browser verification is claimed.

## Follow-up polish

P3: verify 390px mobile viewport and screen-reader behavior on a physical device. Synthetic demo intentionally omits decorative mock search/avatar controls.

final result: passed
