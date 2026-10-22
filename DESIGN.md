---
version: 2
name: Omnidex
description: >
  Dark professional tool for multi-DCC asset management.
  Dense, precise, confident. Power-user density over consumer comfort.
  Source of truth: this file. Values here are mirrored by
  renderer-react/src/styles/global.css and nothing else may disagree.

# ---------------------------------------------------------------------------
# COLOR — OKLCH only. There is no hex stack. The v1 hex values
# (#111111/#1c1c1c/#242424) are deleted; they described a second, conflicting
# system that never shipped. Every value below is byte-identical to a
# --color-* token in global.css.
# ---------------------------------------------------------------------------
colors:
  # Surface ramp — 14 steps. 50 = lightest text on dark, 950 = deepest surface.
  surface-50: "oklch(0.97 0.003 250)"   # primary text
  surface-100: "oklch(0.93 0.004 250)"  # secondary text
  surface-200: "oklch(0.86 0.005 250)"  # muted text
  surface-300: "oklch(0.74 0.006 250)"  # dim text, inactive nav
  surface-400: "oklch(0.62 0.006 250)"  # dimmer text, icons
  surface-500: "oklch(0.5 0.007 250)"   # faint text, section labels
  surface-600: "oklch(0.4 0.008 250)"   # disabled, empty-well glyphs
  surface-700: "oklch(0.32 0.009 250)"  # strong border, input border
  surface-800: "oklch(0.25 0.01 250)"   # elevated: selected row, active nav, floating chrome
  surface-850: "oklch(0.21 0.01 250)"   # status bar
  surface-900: "oklch(0.17 0.011 250)"  # input fill, table header
  surface-925: "oklch(0.145 0.012 250)" # panel: sidebar, header, toolbar, footer
  surface-935: "oklch(0.135 0.012 250)" # list column (queue, course list)
  surface-950: "oklch(0.12 0.012 250)"  # page

  # Accent — single reserved orange. Active state, primary CTA, focus ring,
  # selection. Never on inactive chrome, never on more than one control per
  # region. Color is a budget.
  accent-300: "oklch(0.78 0.16 55)"     # accent text on a tinted fill
  accent-400: "oklch(0.72 0.18 55)"     # accent icon
  accent-500: "oklch(0.66 0.2 55)"      # accent fill
  accent-on: "oklch(0.14 0.02 55)"      # text/icon ON an accent-500 fill

  # Semantic — fill at -500, text at -300 when sitting on a tinted fill.
  success-500: "oklch(0.65 0.14 150)"
  warning-300: "oklch(0.78 0.15 75)"
  warning-500: "oklch(0.72 0.16 75)"
  danger-300: "oklch(0.68 0.19 25)"
  danger-500: "oklch(0.62 0.2 25)"

  # Ecosystem channel — the second color axis, spent at last. This is what
  # DESIGN.md v1 reserved as "cyan #06b6d4" and never implemented. One hue per
  # DCC, applied as an 8x8px 2px-radius mark, never as a fill or a text color.
  # Maya, Houdini and ZBrush claim the next hues when a scan first finds them.
  eco-unreal: "oklch(0.70 0.13 220)"
  eco-blender: "oklch(0.76 0.15 75)"
  eco-agnostic: "oklch(0.45 0.008 250)"
  eco-unclassified: "oklch(0.62 0.2 25)"

  # Borders — opacity-modified surface, never a hardcoded value.
  border: "oklch(0.25 0.01 250 / 0.6)"   # standard divider
  border-strong: "oklch(0.32 0.009 250)" # input, button outline, table header rule

# ---------------------------------------------------------------------------
# TYPOGRAPHY
# Archivo for prose and labels. JetBrains Mono for every numeric
# value and every uppercase micro-label. Sizes are applied through the Capsize
# `cap-N` classes (see Typography prose below), never raw font-size.
# ---------------------------------------------------------------------------
typography:
  # Proportional
  body:                                 # default reading size
    fontFamily: "Archivo"
    fontSize: 15px
    fontWeight: 400
    letterSpacing: 0
  body-medium:                          # table name cell, list item title
    fontFamily: "Archivo"
    fontSize: 15px
    fontWeight: 500
    letterSpacing: 0
  secondary:                            # table cell, sidebar row, chip
    fontFamily: "Archivo"
    fontSize: 14px
    fontWeight: 400
    letterSpacing: 0
  control:                              # button, nav item, toolbar control
    fontFamily: "Archivo"
    fontSize: 13px
    fontWeight: 500
    letterSpacing: 0
  title-sm:                             # panel title, course title
    fontFamily: "Archivo"
    fontSize: 16px
    fontWeight: 600
    letterSpacing: -0.01em

  # Mono — numerics and micro-labels
  numeric:                              # size, count, price, duration, %
    fontFamily: "JetBrains Mono"
    fontSize: 14px
    fontWeight: 400
    letterSpacing: 0
  numeric-strong:                       # confidence %, health headline figure
    fontFamily: "JetBrains Mono"
    fontSize: 14px
    fontWeight: 600
    letterSpacing: -0.02em
  status:                               # status bar
    fontFamily: "JetBrains Mono"
    fontSize: 12px
    fontWeight: 400
    letterSpacing: 0
  label:                                # column header, metadata key, badge
    fontFamily: "JetBrains Mono"
    fontSize: 12px
    fontWeight: 400
    textTransform: uppercase
    letterSpacing: 0.14em
  label-section:                        # sidebar group heading
    fontFamily: "JetBrains Mono"
    fontSize: 11px
    fontWeight: 600
    textTransform: uppercase
    letterSpacing: 0.16em

# ---------------------------------------------------------------------------
# RADIUS — three values plus a dot. v1 named a 2/4/6/8/12 ladder; global.css
# shipped 4/6/10/14/18. Neither survives. `rounded-md` is the structural
# default and it is 4px.
# ---------------------------------------------------------------------------
rounded:
  xs: 2px      # ecosystem mark, progress bar
  sm: 3px      # badge, status pill
  md: 4px      # STRUCTURAL DEFAULT — card, button, input, table row, panel, nav item
  lg: 6px      # floating only — modal, dropdown, popover, command palette, bulk bar
  full: 9999px # status dot only

spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px

# ---------------------------------------------------------------------------
# COMPONENTS — every height here is fixed and does not flex.
# ---------------------------------------------------------------------------
components:
  title-bar:
    height: 22px
    backgroundColor: "oklch(0.255 0.008 253)"

  nav-bar:
    height: 44px
    backgroundColor: "{colors.surface-925}"
    typography: "{typography.control}"

  toolbar:
    height: 44px
    backgroundColor: "{colors.surface-925}"

  filter-chip-row:
    height: 40px

  status-bar:
    height: 28px
    backgroundColor: "{colors.surface-850}"
    typography: "{typography.status}"

  sidebar:
    width: 260px
    backgroundColor: "{colors.surface-925}"
    rowHeight: 30px

  inspector:
    width: 420px
    minWidth: 360px
    maxWidth: 560px

  table-header:
    height: 34px
    backgroundColor: "{colors.surface-900}"
    typography: "{typography.label}"

  table-row:
    height: 44px

  bulk-action-bar:
    height: 52px
    backgroundColor: "{colors.surface-800}"
    rounded: "{rounded.lg}"
    offsetFromBottom: 64px

  button-primary:
    backgroundColor: "{colors.accent-500}"
    textColor: "{colors.accent-on}"
    rounded: "{rounded.md}"
    height: 32px
    padding: "0 12px"

  button-secondary:
    backgroundColor: "transparent"
    border: "1px solid {colors.border-strong}"
    textColor: "{colors.surface-100}"
    rounded: "{rounded.md}"
    height: 32px
    padding: "0 12px"

  input:
    backgroundColor: "{colors.surface-900}"
    border: "1px solid {colors.border-strong}"
    rounded: "{rounded.md}"
    height: 32px

  badge:
    rounded: "{rounded.sm}"
    typography: "{typography.label}"
    padding: "3px 8px"
---

# Omnidex Design System

## Status

**Version 2 replaces version 1 wholesale.** v1 and `global.css` were two
different design systems checked into the same repo — different color model
(hex vs OKLCH), different color values, different token architecture, and a
radius ladder where every rung disagreed (`rounded-md` meant 6px to the doc and
10px to the compiler). Every review argument that reached for "the spec" was
unresolvable because there were two.

This version is derived from the R1/R2/R3 teardown mockups and reconciled
against the shipped OKLCH ramp. Where the two disagreed, the mockups won.

Three rules from v1 are **deliberately overruled** here, because the mockups
that are now the spec break them on purpose:

| v1 rule | v2 | Why |
|---|---|---|
| Body text is 18px; 16px is too comfortable | **15px** | v1 contradicted itself — its own prose already documented the shipped 9–11/12/14/15/18 scale. 18px on a 2,560px three-pane layout costs a table column. |
| Labels track at 0.02–0.04em | **0.14–0.16em on mono uppercase micro-labels only** | Proportional labels still track at 0.02–0.04em. Wide tracking is what makes an 11px uppercase mono label legible as a *label* rather than as text. |
| Secondary accent is cyan #06b6d4 for data values | **A per-ecosystem hue channel** | The cyan reservation went unimplemented for three versions because "data values" was never a real category. "Which DCC is this?" is. |

## Overview

Omnidex is a local asset manager for 3D artists, animators and game developers.
The audience is power users who manage thousands of asset packs across several
drives and DCCs, and who need to find, evaluate, match and organise them fast.

The tone is dense, confident, precise. Every pixel either carries information or
creates structure. The aesthetic reference is DaVinci Resolve or the Unreal
Editor, not Vercel or Linear.

**Omnidex is a manager, not a viewer.** Any surface that can only display is
unfinished. If a screen shows you a number you care about, that number is a
control.

## Color

The surface ramp runs `surface-950` (page) → `surface-925` (panels: sidebar,
header, toolbar, footer) → `surface-900` (inputs, table headers) →
`surface-850` (status bar) → `surface-800` (elevated: selected rows, active nav,
floating chrome). Adjacent layers must stay **at least 5 OKLCH lightness points
apart** wherever they meet. A card at `surface-900/40` over `surface-950` is
about 2 points and reads as a rectangle of nothing — do not do it. Cards are
opaque.

The orange accent is reserved. It marks active state, the single primary CTA in
a region, the focus ring, and selection. It never fills a toggle, never marks
inactive chrome, and never appears twice in one control cluster competing with
itself. When a panel needs seven switches and one primary action, the switches
are neutral and the action is orange.

Ecosystem hues are the second axis and the only place color encodes data. They
appear as an 8×8px `rounded.xs` mark before the label, never as a text color or
a fill. One hue per DCC, assigned on first scan. Categories stay neutral — the
question "which DCC" must be answerable at a glance from across the room, and
"which kind" must not compete with it.

Borders are opacity-modified surface values, never hardcoded.

## Typography

Archivo, a licensed grotesque with tight metrics (capHeight 686/1000).
JetBrains Mono for **every numeric value** — size, count, price, rating,
duration, percentage, version, path — and for every uppercase micro-label. A
number in the proportional face is a bug.

Sizes are applied through Capsize `cap-*` classes generated by
`scripts/generate-capsize.mjs` from live font metrics (output:
`renderer-react/src/styles/capsize.generated.css`; run `pnpm capsize`). A
`cap-N` class **replaces** the Tailwind `text-*` utility: it sets font-size and
a leading whose intrinsic whitespace above cap-height and below the baseline is
trimmed via `::before`/`::after`. Classes are px-suffixed (`cap-9 … cap-40`) to
avoid colliding with Tailwind's t-shirt sizes. Never pair `cap-*` with
`leading-*` — the cap class owns the line-height the trim is computed against —
and never pad a text container to fix perceived alignment.

For multi-line prose (asset descriptions, notes, privacy copy) use the
`cap-N-prose` variants, which keep the trim at a ~1.6 leading.

Heading and title tracking is slightly negative (-0.01em to -0.02em).
Proportional labels track 0.02–0.04em. Mono uppercase micro-labels track
0.14–0.16em. Body tracks at 0.

## Layout

Three panes: sidebar (260px) → content (flex 1) → inspector (420px, resizable
360–560). Panels are fixed-width, not percentage-based.

Vertical chrome is fixed and does not flex: title bar 22px, nav 44px, toolbar
44px, filter chip row 40px, status bar 28px. Table header 34px, table row 44px,
sidebar row 30px.

The base grid unit is 8px; all spacing is a multiple of 4px, preferring 8px.
Card grids use 8px gaps — 12px and up reads as accidental whitespace.

The status bar is **mandatory on every route**. It is the app's only
always-visible statement of truth: total count, filtered count, selection count,
the unmatched backlog, and index freshness. Any count that appears anywhere else
must agree with it or be labelled as measuring something different.

## Elevation

Depth comes from background steps, never box-shadow on content. Shadows are
reserved for genuinely floating surfaces: dropdowns, modals, tooltips, the bulk
action bar.

## Shapes

`rounded.md` (4px) is the structural default — cards, buttons, inputs, table
rows, panels, nav items. `rounded.sm` (3px) for badges and status pills.
`rounded.xs` (2px) for ecosystem marks and progress bars. `rounded.lg` (6px) is
for floating surfaces only.

Nothing in this app is rounder than 6px. A radius above 8px on a structural
element is the single loudest signal that a UI was assembled from a component
library rather than designed.

## Components

**Asset card (grid view).** Opaque `surface-900`, 1px border, `rounded.md`, no
shadow. 16:9 thumbnail well. **The card must degrade.** When there is no
thumbnail — which is the majority case — the well does not render a grey
gradient and an icon. It collapses, and the reclaimed height is spent on what is
actually known: full name on two lines, ecosystem mark + label, pack kind, size
on disk, engine range, source folder. A card that shows only the filename you
already knew is worse than a table row.

**Asset table (default view for unmatched-heavy libraries).** Columns: select,
name, kind, ecosystem (mark + label), engine, size (right-aligned mono), source,
added, match status. 44px rows, 34px header at `surface-900` with a
`border-strong` rule. Sortable by any column. Group-by is a first-class control
beside sort, not a hidden preference.

**Selection is plural.** Click selects, shift-click extends a range, ctrl/cmd-
click toggles, ctrl/cmd-A selects the filtered set, Esc clears. Every mutation
that acts on assets takes an array. Single selection is a special case of
multi-selection, never the model.

**Bulk action bar.** Floating, centered, 64px above the bottom edge,
`surface-800`, `rounded.lg`, shadow, fly-in on first selection (gated on
`prefers-reduced-motion`). Shows the selection count, then: Favorite, Tag, New
collection, Re-match, Move, and a danger-tinted Remove behind a divider. Ends
with an `esc to clear` hint.

**Status bar.** 28px, `surface-850`, mono 12px. Left to right: library totals ·
filtered/selected · the unmatched backlog in `warning-300` · index freshness
with a state dot. Never truncate it into ambiguity.

**Facets.** Multi-select, not a radio group. Counts update against the current
query. Every active constraint appears as a removable chip above the content
with a Clear all, so the query is legible without looking at the sidebar.
Navigation lists never truncate silently — show the top N with a `+M more`
disclosure that expands in place.

**Inspector.** Tabbed: Details / Description / Technical. Details is the default
and is always short. Actions pin to a footer that never scrolls away. Metadata
rows are a two-column grid with the value left-aligned at a fixed gutter —
never `justify-between`, which flings the label and value to opposite edges of a
resizable panel. Provenance is not optional: source location, full path with a
copy affordance, and a duplicate count when the pack appears in more than one
source.

**Unknown is not empty.** A field that was never looked up renders as pending
with the verb attached, not as an em-dash. Five dashes in a column train the
user to read the panel as empty. One line — "Not matched to a marketplace
listing · Match now" — is the whole fix.

## Do's and Don'ts

**Do:**
- Show exact counts everywhere — `2,799`, never `2.8K`
- Use monospace for every numeric value
- Make the number a control when the number is a problem
- Route every taxonomy label through one formatter — no raw enum keys, no
  `capitalize` leaving underscores in
- Pair color with an icon, border, or weight change; never color alone
- Give every action visible feedback in the surface that started it

**Don't:**
- Add box-shadow to content cards
- Exceed 6px radius anywhere
- Use any accent but orange for a primary action
- Put a gradient on UI chrome
- Truncate a list without saying so
- Ship a tab, route, or dialog that contains no verb
- Put sprint or milestone vocabulary in user copy
- Resolve a layout collision by closing the surface the user was working in
