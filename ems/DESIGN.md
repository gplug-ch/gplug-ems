---
name: gPlug EMS UI
description: The on-device gPlug EMS dashboard — a warm-paper, provenance-first energy ledger
colors:
  cream-bg: "#F3EFE2"
  surface: "#FFFFFF"
  navy: "#1A1A38"
  navy-2: "#35355A"
  text-mut: "#6B6B77"
  amber: "#F3B738"
  line: "#E3DED0"
  production: "#D99A06"
  consumption: "#2D9CDB"
  export: "#3E7C28"
  import: "#C62D20"
  battery: "#0F766E"
  import-fill: "#F5C1BC"
  export-fill: "#C4E3C9"
  active: "#2FA452"
  inactive: "#6B6B77"
typography:
  display:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "40px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.5px"
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.15
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.4px"
rounded:
  xs: "8px"
  sm: "10px"
  md: "12px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "20px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.navy}"
    rounded: "{rounded.sm}"
    padding: "10px 22px"
  button-secondary:
    backgroundColor: "{colors.navy}"
    textColor: "#F7F3E5"
    rounded: "{rounded.sm}"
    padding: "10px 22px"
  button-danger:
    backgroundColor: "{colors.import}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: "10px 22px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "18px 20px"
  badge-active:
    backgroundColor: "{colors.active}"
    textColor: "#FFFFFF"
    rounded: "{rounded.pill}"
    padding: "3px 12px"
  badge-waiting:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.navy}"
    rounded: "{rounded.pill}"
    padding: "3px 12px"
  pill-tab:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.navy}"
    rounded: "{rounded.pill}"
    padding: "8px 18px"
  pill-tab-active:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.navy}"
    rounded: "{rounded.pill}"
    padding: "8px 18px"
  textfield:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.navy}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
---

# Design System: gPlug EMS UI

## Overview

**Creative North Star: "The Swiss Energy Ledger"**

This is the account book of a household's energy and money — kept on warm paper, in a
steady hand, by an instrument that never overstates what it knows. The interface reads
like a trustworthy statement: a cream-paper ground, deep-navy structure, a single gold
accent used with discipline, and — its defining habit — every number carries its
provenance. A value is either a **Register** reading (authoritative, from the meter) or
**berechnet** (derived in the browser), and it is always labelled as such. That honesty
is the product; the visual system exists to make an invisible optimisation believable to
a non-expert who may be looking at their own bill.

The system is **precise and trustworthy** before it is anything else. Density is calm, not
crowded: white surfaces sit **softly lifted** above the warm paper, separated by warm
hairlines and one gentle shadow, and each card announces which part of the energy world it
belongs to through a 4px colour-coded left edge. Colour is never decoration — it is domain
meaning, following the Swiss/DACH convention (Produktion gelb, Verbrauch blau, Einspeisung
grün, Bezug rot, Batterie türkis), and it is never the *only* signal, because state and
direction must survive colour-blindness and a monochrome print of a quarterly statement.

The world is deliberately **not** a dark "energy app" dashboard, not neon gradients on
black, not a gamified consumption tracker. It is closer to a well-set financial document
that happens to update live. Restraint is the register; the live flow diagram and the KPI
gauges are allowed a little animation, but they collapse to legible static forms under
`prefers-reduced-motion`.

**Key Characteristics:**
- Warm cream paper ground; white is reserved for surfaces that hold data.
- Deep navy for structure and type; a single gold accent, used sparingly.
- Every number is provenance-tagged (Register vs. berechnet).
- Colour = domain meaning (Swiss energy convention), never colour-alone.
- Softly lifted surfaces: hairline borders + one gentle shadow + a colour-coded left edge.
- Calm density; instrument-grade honesty about stale, provisional, and missing data.

## Colors

A warm-paper foundation with a disciplined navy/gold brand triad, over which a fixed,
legally-conventional energy palette carries all domain meaning. Names are functional and
literal on purpose — the Swiss colour convention must stay unmistakable.

### Primary
- **Amber** (#F3B738): the single brand accent. Logo wordmark, primary button, focus ring,
  active nav marker, warning/hint borders, the `waiting` state, and the `Hochtarif` tag.
  Its scarcity is the point — it never appears as a data-series colour (production data uses
  the darker **Production** gold instead).

### Neutral
- **Cream BG** (#F3EFE2): the page ground. The paper the ledger is written on. The body
  background is never pure white.
- **Surface** (#FFFFFF): cards, sub-panels, fields, floating chrome. White means "this holds
  data."
- **Navy** (#1A1A38): body text *and* primary structure — the fixed sidebar, primary
  secondary-button fill, the Netzanschluss card edge, chart axes, tooltip/toast backgrounds.
- **Navy-2** (#35355A): the lighter navy for the active nav-item fill and the `Niedertarif` tag.
- **Text Muted** (#6B6B77): secondary text, labels, captions, muted table rows. Deliberately
  darkened from the prototype's #8A8A93 to clear WCAG AA 4.5:1 on white (FR-209).
- **Line** (#E3DED0): warm hairline borders and dividers — the ruled lines of the ledger.

### Energy palette (domain-semantic; do not repurpose)
These map 1:1 to concepts and follow the Swiss/DACH convention. Treat them as reserved.
- **Production** (#D99A06): PV / Erzeugung — Gelb/Ocker. Card-edge for Erzeuger.
- **Consumption** (#2D9CDB): Verbrauch / Haus / Lasten — Blau. Card-edge for Lasten.
- **Export** (#3E7C28): Netzeinspeisung — Grün. Positive/credit values in tables.
- **Import** (#C62D20): Netzbezug — Rot. Negative/debit values, danger buttons, field errors.
  Darkened for AA 4.5:1 (FR-209).
- **Battery** (#0F766E): Batterie — Türkis/Petrol (AA 5.5:1 on white).
- **Import Fill** (#F5C1BC) / **Export Fill** (#C4E3C9): the pale tints used for the lighter
  segment of composition bars and chips.
- **Grid** (#6B6B77, `--c-grid`): the neutral grey «Netz» node in the flow view; the grid edge
  itself takes Import red / Export green by direction.
- **Active** (#2FA452) / **Inactive** (#6B6B77): load-state badge fills.

### Named Rules
**The Warm-Paper Rule.** The page ground is Cream BG (#F3EFE2); pure white is reserved for
data-bearing surfaces. Never invert this — a white page body reads as a generic web app, not
the ledger.

**The One-Accent Rule.** Amber is the *only* brand accent and appears on a small fraction of
any screen (logo, one primary action, focus, active nav, warnings). If two things are amber
for attention on the same view, one of them is wrong.

**The Never-Colour-Alone Rule.** State and direction are never encoded by colour alone. A
flow has position + arrow + label; a load state has a text badge; a table sign has a glyph.
This is load-bearing for WCAG AA, deuteranopia, and monochrome print of statements.

## Typography

**Display / Body / Label Font:** the system UI stack —
`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. One family, no web fonts. This
is a hard constraint, not a taste: the on-device asset budget is ≤150 KB and the UI ships no
downloaded fonts.

**Character:** Neutral, legible, native to every OS. Personality comes from weight, size, and
restraint — not from a typeface. Numbers do the talking; tabular figures are used wherever
values align in columns (`font-variant-numeric: tabular-nums`).

### Hierarchy
- **Display** (800, 40px, −0.5px tracking): the single hero number — the signed live meter
  total on the «Zähler» page. Used once per view at most.
- **Headline** (700, 28px): page titles. 24px on mobile.
- **Title** (700, 20px): card titles. The numeric KPI figure runs heavier (800, 26px) as a
  sibling emphasis, never larger than the display.
- **Body** (400, 14px, 1.45): all running text and table cells. Base document size.
- **Label** (600, 12px): field labels, captions, chart ticks, metadata — usually in Text
  Muted. The micro-tag variant (700, ~10.5px, uppercase, +0.3–0.6px tracking) is reserved for
  provenance tags and section eyebrows.

### Named Rules
**The Tabular-Numbers Rule.** Any value that stacks in a column or updates in place uses
tabular figures, so digits don't jitter as data refreshes. Money, power, and register readings
always.

**The One-Hero-Number Rule.** Display size (40px) is spent on at most one number per view. If a
second value competes at that size, demote it to KPI (26px) or Title.

## Layout

A fixed left rail and a paper canvas. On desktop (≥1024px) a **260px navy sidebar** is pinned
full-height; content sits in `margin-left: 260px`, padded `32px clamp(16px,3vw,44px) 48px`, and
capped at **max-width 1450px**. Below 1024px the rail collapses into a sticky navy top bar +
drawer; content padding relaxes to 16–20px.

Content is organised as a vertical stack of cards, with purpose-built grids inside:
- **Übersicht sub-grid:** 2-up (`repeat(2, minmax(0,1fr))`), stacks to 1 column ≤767px.
- **Settings form:** `auto-fill, minmax(240px, 1fr)`; a **master–detail** split of `260px 1fr`
  that becomes a list→detail push-navigation view with a back affordance ≤767px.

The spacing rhythm is quiet and consistent: 6/10/16/20/32px. Cards carry 18–20px internal
padding (14px on mobile); sections breathe with ~20–22px gaps. Wide content (tables, meter
registers, flow diagram) scrolls inside its own container — **the page body never scrolls
horizontally.**

### Named Rules
**The Fixed-Rail Rule.** Navigation is a persistent navy rail on desktop and a navy drawer on
mobile — never a light-on-light nav. The rail is the one large field of navy; content is paper.

## Elevation & Depth

Surfaces are **softly lifted**, not flat and not floating. Depth is built primarily from
material contrast — white **Surface** on **Cream BG**, edged by warm **Line** hairlines — and
finished with a single, gentle, two-part shadow that reads as a low lift off the paper rather
than drama. The signature depth cue is not the shadow at all: it is the **4px colour-coded left
edge** that gives every card its domain identity.

### Shadow Vocabulary
- **Soft lift** (`box-shadow: 0 1px 3px rgba(26,26,56,0.07), 0 4px 14px rgba(26,26,56,0.05)`):
  the one and only shadow. Cards, floating chrome (tooltip, toast, chart hover, drawer), and
  nodes. Tinted with navy, never neutral black. There is no second, heavier elevation step —
  if something needs more emphasis, it earns a colour edge or a border, not a bigger shadow.

### Named Rules
**The Single-Shadow Rule.** The system has exactly one shadow token. Don't introduce a second
elevation tier; hierarchy comes from the colour-coded left edge, hairlines, and paper contrast.

**The Colour-Edge Rule.** A card's identity is its 4px left border: Netz = Navy, Erzeuger =
Production gold, Lasten = Consumption blue. Warning/hint surfaces use an
amber left edge on a pale-amber (#FCF3DC) wash.

## Shapes

Gently rounded, calm geometry. Three corner radii and a pill:
- **Cards / flow nodes** — 12px (`--radius`, "md").
- **Buttons, fields, sub-panels, banners** — 10px (`--radius-s`, "sm").
- **Small controls** (icon buttons, nav-item, tooltip, segmented toggle, provenance tags) — 8px.
- **Badges, filter pills, name tags, status dots** — full pill (999px) or circle.

Borders are 1px warm **Line** hairlines; the card's left edge thickens to 4px to carry colour.
There is no hard-cornered or heavily-stroked language — the form vocabulary is soft, ruled, and
consistent. Icons are inline geometric SVGs on a 20×20 grid, `currentColor`, ~1.6–1.8px stroke.

## Components

Components lead with restraint; the "feel" across all of them is **precise and trustworthy** —
exact padding, calm colour, no unnecessary motion. Transitions are short (0.15s) on hover/state.

### Buttons
- **Shape:** 10px radius (`--radius-s`), min-height 40px (32px for `.btn-small`).
- **Primary:** Amber fill, Navy text, padding 10px 22px. The single high-emphasis action per view.
- **Secondary:** Navy fill, cream (#F7F3E5) text — the workhorse for neutral actions.
- **Danger:** Import red fill, white text — destructive only (delete load, delete production).
- **Hover / Active:** `filter: brightness(0.95)` on hover; `translateY(1px)` on press. Disabled
  drops to 0.45 opacity. Focus shows the amber 2px ring (`:focus-visible`).

### Badges (load state)
- **Style:** full-pill, 12px/600, 3px 12px padding, white text.
- **State:** Active = green (#2FA452); Waiting = amber with navy text; Inactive = muted grey.
  Always paired with the German state word — colour is never the sole signal.

### Cards / Containers
- **Corner:** 12px. **Background:** Surface white on the cream page.
- **Signature:** a 4px colour-coded **left** border keyed to domain (see The Colour-Edge Rule).
- **Shadow:** the single Soft-lift token. **Border:** 1px Line hairline on the other three sides.
- **Padding:** 18–20px (14px mobile). Head row: title (20/700) left, value/subtitle right.

### Fields / Inputs
- **Style:** Surface background, 1px Line border, 10px radius, 10px 14px padding, min-height 40px.
- **Focus:** border shifts to Amber; keyboard focus additionally keeps the amber outline ring,
  pointer focus shows only the border tint (`:focus-visible` split).
- **Error:** Import-red border + a 12px red helper line under the field.
- **Select:** custom caret (muted chevron); **toggle/checkbox:** `accent-color: amber`.

### Pill Tabs
- **Style:** pill (999px), 1px Line border, Surface background, navy text, 8px 18px.
- **Active:** Amber fill + Amber border + navy text. Used for settings sections and view switches.

### Navigation
- **Style:** vertical list in the navy rail; items 500-weight, muted-lavender (#B9B9C9) at rest,
  brightening on hover (`rgba(255,255,255,0.06)` wash).
- **Active:** Navy-2 fill, **Amber** text, plus a 3px amber tab marker bleeding off the left edge.
- **Mobile:** same items inside a sticky navy drawer toggled by a burger.

### Provenance Tags (signature)
- **Register** tag: cool blue chip (#E7EEF6 / #2b527d) — an authoritative meter reading.
- **berechnet** tag: warm gold chip (#F1ECDD / #7a6a3a) — derived in the browser; the value
  itself gets a **dashed underline** and a help cursor with an adjacent tooltip.
- This pairing is the visual embodiment of the product's trust doctrine and must not be dropped
  when new numeric surfaces are added.

### Energy Flow Diagram (signature)
- Hand-built in HTML + CSS grid (not SVG, no chart library; only the node icons are inline SVG)
  with its own node/edge language: PV and Batterie before Haus, Netz after it; the layout
  switches between a vertical chain and a horizontal one (container ≥ 520px).
- Live edges animate dots drifting *in the flow direction* (`hub-flow-v` / `hub-flow-h`, 0.9s);
  an edge's arrow flips with its direction (battery charging, grid import); a real 0 W edge is
  dimmed, an unknown one is grey dashed with «–».
- A **words-first status headline** (`.flow-status`) sits above the diagram, and every edge label
  is redundant with position + arrow. Under `prefers-reduced-motion` the global reduced-motion
  rule stops the drift.

### KPI Tile & Gauge
- Horizontal tile (Surface, Line border, 10px), a 58px circular **SVG gauge** left, a heavy
  numeric (800/26px) and a 13px label right. Used for Autarkiegrad / Eigenverbrauchsgrad /
  Ersparnis / CO₂.

## Do's and Don'ts

### Do:
- **Do** keep the page ground Cream BG (#F3EFE2) and reserve white for data-bearing surfaces.
- **Do** give every card its domain identity via the 4px colour-coded left edge.
- **Do** tag every number's provenance (Register vs. berechnet); dash-underline derived values.
- **Do** encode state/direction redundantly — colour **plus** label/arrow/position/glyph.
- **Do** use tabular figures for any value that aligns in a column or updates live.
- **Do** honour the Swiss energy colour convention exactly (gelb/blau/grün/rot/türkis).
- **Do** collapse all motion to a legible static form under `prefers-reduced-motion`.

### Don't:
- **Don't** use Amber as a data-series colour, or place two attention-amber elements on one view.
- **Don't** introduce a second shadow tier or heavier elevation — hierarchy comes from the colour
  edge, hairlines, and paper contrast.
- **Don't** add a downloaded/web font or any third-party asset — one system font stack, ≤150 KB,
  no external requests.
- **Don't** repurpose an energy-palette colour for decoration, or invert a Verbrauch/Produktion
  mapping.
- **Don't** render a value as final when its data is provisional (`provisorisch`) or stale —
  surface the caveat.
- **Don't** let tables or the flow diagram scroll the page body horizontally; scroll inside the
  component instead.
