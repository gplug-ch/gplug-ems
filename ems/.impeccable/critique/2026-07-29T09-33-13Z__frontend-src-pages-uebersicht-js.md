---
target: Übersicht (live monitor)
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-07-29T09-33-13Z
slug: frontend-src-pages-uebersicht-js
---
Method: dual-agent (A: design-review · B: detector+browser)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live timestamp + flow headline are good, but first paint is a wall of "–"/empty charts with no loading skeleton — reads as broken, not loading. |
| 2 | Match System / Real World | 3 | Strong German domain language, but Autarkiegrad/Eigenverbrauchsgrad/Import/Stromherkunft all surface at once for a non-technical persona; tooltips slip Sie→du. |
| 3 | User Control and Freedom | 3 | Dismissible hints + Jetzt/Heute toggle; low-stakes load actions fire immediately (acceptable); dismissals reset per session. |
| 4 | Consistency and Standards | 3 | Tight system, but KPI strip mixes 2 gauges + 2 bare numbers; hint-amber + waiting-badge-amber can co-occur (One-Accent-Rule); Sie/du split. |
| 5 | Error Prevention | 3 | Excellent: null never coerced to 0, KPIs null out past 20% data holes, unknown≠zero edges. |
| 6 | Recognition Rather Than Recall | 2 | 3-series Netzanschluss chart has no legend; flow diagram has no colour legend — user must recall gelb/blau/grün/rot or hover (pointer-only). |
| 7 | Flexibility and Efficiency | 3 | Jetzt/Heute toggle + hover readouts; adequate for a monitor surface. |
| 8 | Aesthetic and Minimalist Design | 2 | Flagship stacks ~8 analytic regions (flow + status + 2 comp bars + 4 KPI + Netz chart + per-production/load/member charts) — past "calm density." |
| 9 | Error Recovery | 3 | "Keine Live-Daten … Integration/Erreichbarkeit prüfen", offline toast, comp_nodata — genuinely diagnostic copy. |
| 10 | Help and Documentation | 3 | Tooltips explain every term; Ersparnis arithmetic one click away. |
| **Total** | | **28/40** | **Good** |

## Design Specificity Verdict

**Authored where it invented; generic and off-doctrine where it borrowed.**

Genuinely non-interchangeable, north-star-aligned work is real: the hand-rolled flow diagram with the Swiss/DACH colour convention wired to domain nodes, the `ok`/`zero`/`unknown` edge grammar ("no data ≠ night"), the words-first status headline, the composition bars, and the honest-null doctrine (`num`/`ratedW` return `null` not 0; KPIs null out past a 20% data hole). This is the "instrument that never overstates" made literal — a stance no neighbouring solar dashboard bothers with.

**But the design system's single defining habit — every number carries its provenance (Register vs. berechnet, dashed-underline on derived values) — is entirely absent from this page,** though every value on it is browser-derived. And strip the flow diagram away and the KPI strip (gauge + big number + label) is category-interchangeable — every solar portal ships exactly this.

**Deterministic scan:** detector clean on `uebersicht.js` and the whole `pages/` dir (exit 0) — but that is a coverage gap, not a clean bill: the detector can't parse `htm`-templated Preact, so treat the JS target as *unscanned*. The only findings are 10× `side-tab` (thick coloured left border) in the shared `style.css` (L228, 452, 481-482, 504, 949, 1098, 1109, 1264, 1298). These are a **brief-sanctioned false positive**: DESIGN.md prescribes the 4px colour-coded left edge as a load-bearing signature ("The Colour-Edge Rule"). Keep it.

**Browser evidence:** a Vite dev server was already up on :5173; the page was screenshotted in its offline/no-data state. It lays out cleanly; empty-state placeholders ("Keine Daten" hatched bars, em-dash KPI values) behave as designed; the connection-lost toast renders correctly. No JS runtime errors (one expected 404 for the absent device backend). Live-data visuals could not be exercised without a device.

## Overall Impression

This is a trustworthy, well-engineered instrument that is quietly excellent at *honesty* (nulls, provisional states, unknown-vs-zero) and quietly generic at *hierarchy*. The single biggest opportunity: the page has no hero. A PV owner opens it for one feeling — "am I winning right now, and what did it save me?" — yet the emotional payoff (Ersparnis in CHF) is one of four equal tiles, the flagship provenance doctrine is missing, and two headline KPIs are invisible to screen readers.

## What's Working

1. **Honest unknown-vs-zero throughout** — `num`/`ratedW` return `null` not 0 (`uebersicht.js:28-34`), charts render nulls as gaps (`charts.js:165-173`), `flowsNow` distinguishes `unknown`/`zero`/`ok` edges. PRODUCT principle #4 made literal; genuinely differentiating.
2. **Words-first flow status headline** (`uebersicht.js:368-369`) — a plain-German sentence above the SVG that doubles as the diagram's text alternative for a non-expert.
3. **KPI incomplete/partial honesty** — `insights.kpis` nulls all KPIs past a 20% data hole (`insights.js:57-62`); period label switches to "Heute bis {time}" when partial. Instrument-grade restraint on the most-glanced numbers.

## Priority Issues

**[P1] Gauge KPI values are invisible to screen readers.** `Gauge` wraps the whole SVG in `aria-hidden="true"` (`uebersicht.js:508`) and the percent text lives inside it (:514-515); the tile body exposes only the label. A screen-reader user hears "Autarkiegrad"/"Eigenverbrauchsgrad" with no value.
- *Why it matters:* the two flagship numbers for the PV-owner persona; a WCAG AA / PRODUCT "semantic structure" requirement.
- *Fix:* add a visually-hidden `<span>` with the percent by the label, or an `aria-label` on `.kpi-tile` combining label+value; never rely on text inside an `aria-hidden` SVG.
- *Suggested command:* /impeccable harden

**[P1] Colour-carried numeric text likely fails AA contrast.** Values tinted with domain colours as text: `ov-stat-value` 16px/700 in `--c-production` #D99A06 (~2.9:1) and `--c-consumption` #2D9CDB (~3.0:1) on white; CO₂ `kpi-num` 26px/800 in #D99A06 (`uebersicht.js:150-152,564`).
- *Why it matters:* DESIGN.md/PRODUCT commit to WCAG AA; these are text, so 1.4.3 applies independently of the never-colour-alone rule.
- *Fix:* keep dot/edge/line in domain colour, render the value text in navy; or reserve gold/blue for ≥18.66px-bold contexts only.
- *Suggested command:* /impeccable colorize

**[P2] Grid line is red-filled even during export.** `GridPanel` passes `fill: 'var(--c-import-fill)'` unconditionally (`uebersicht.js:164-166`) despite a comment promising "green-filled when exporting." Feed-in periods paint under the cost/rot colour.
- *Why it matters:* red = Netzbezug = money out; showing solar export in red inverts the good news and contradicts the Swiss convention the flow diagram honours correctly.
- *Fix:* split the series at the zero crossing, or drive fill from sign (`--c-vzev-fill` when negative), mirroring `flowsNow`.
- *Suggested command:* /impeccable colorize

**[P2] No legend on the 3-series Netzanschluss chart.** Grid (red)/consumption (blue)/production (yellow) overlaid with no rendered legend (`uebersicht.js:161-168`); only decode path is pointer-only hover.
- *Why it matters:* recognition-over-recall fails for the non-expert persona; no hover on touch/keyboard.
- *Fix:* add a static legend row — `.chart-legend` already exists in `style.css:936-944` — or label lines inline.
- *Suggested command:* /impeccable clarify

**[P2] The provenance doctrine is missing from the flagship.** Nothing on Übersicht carries a Register/berechnet tag or dashed-underline, though the whole page is browser-derived; the signature exists on Zähler but not here.
- *Why it matters:* DESIGN.md's defining, must-not-drop habit; its absence on the most-viewed page makes the doctrine look aspirational.
- *Fix:* at minimum tag the KPI/flow block "berechnet aus Zählerdaten", or apply the dashed-underline + tooltip to derived KPI figures.
- *Suggested command:* /impeccable delight

## Persona Red Flags

**Jordan (PV owner, first-timer):** First paint is a screen of "–" and empty charts with no "wird geladen" skeleton — looks broken (`:725-738`). Then eight stacked regions (Autarkiegrad / Eigenverbrauchsgrad / Import / Stromherkunft / Stromverwendung) — the opposite of "at-a-glance." The Netzanschluss chart's three unlabelled lines are undecodable without hovering. Red fill under the grid line while their panels export tells them they're buying costly power exactly when they're selling. Only the flow status headline rescues the glance.

**Sam (accessibility-dependent):** The two headline KPIs expose no value to assistive tech (Gauge aria-hidden, P1). Coloured stat/KPI values fail AA contrast (P1). Every chart is pointer-only — no keyboard access to a single data point (`charts.js:186-215`); the flow SVG's `aria-label` is static prose with no live numbers, so only the status `<p>` conveys the headline figure; all per-load/production/member chart values are unreadable.

**Casey (distracted mobile):** `.ov-subgrid` collapses to one column ≤767px (`style.css:539-541`), turning the page into a very long scroll: flow + status + 2 composition bars + toggle + note + 4 KPI tiles + Netz chart + one chart per production + per load + per vZEV member. The "quick glance" is buried; no sticky/condensed summary. Tap targets are fine, but density defeats the use case.

## Minor Observations

- "Erzeugung" stat (`uebersicht.js:152-153`) is the only GridPanel stat without a tooltip; siblings all have one.
- `common.stale` = "Zuletzt aktualisiert {time}" does double duty as neutral page-header timestamp and the shell's *offline* stale note; the header never actually signals staleness (no age threshold vs now).
- Hint-banner amber + a waiting-load amber badge can appear together — borderline One-Accent-Rule violation.
- `CompositionBars` "Heute" omits the battery (with a note) while "Jetzt" includes it — the segment set changes between toggles, which can read as a data glitch.
- vZEV panel charts are in Wh while sibling panels are in W (correct per domain, but visual sameness invites misreading).
- Flow SVG capped at `max-width:520px` and centred; on wide desktop it's a small island in a wide card.
- `prefers-reduced-motion` collapse is present and correct (`style.css:1173-1180`).

## Questions to Consider

1. Persona B's job is "at-a-glance," yet the flagship stacks ~8 analytic regions. Should Übersicht be *only* flow + status + four KPIs, with per-load/production/member charts relocated to Verlauf or a disclosure?
2. Provenance tagging is the system's signature move — why is it absent from the one page everyone opens? Is the doctrine real, or does it only survive where it's cheap (Zähler)?
3. Two gauges plus two bare numbers in one strip: is the gauge earning its pixels, or would four consistent, screen-reader-legible number tiles read faster *and* fix the P1 a11y gap?
4. The emotional payoff is Ersparnis (CHF saved). Why is it one of four equal tiles instead of the page's single hero — the number a non-expert actually came for?
5. If a value being red means "money leaving," can the product afford any chart that paints solar export in the import colour, even for a frame?
