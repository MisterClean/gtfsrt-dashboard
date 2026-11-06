---
name: Transit Notebook
description: A warm, ruled reporting system that leads with the finding and traces every number back to its method.
colors:
  copper: "#ac4d2b"
  copper-hover: "#8b391b"
  copper-pale: "#f2e1d5"
  on-copper: "#fff"
  copper-dark: "#e0855f"
  copper-hover-dark: "#eb9d7c"
  copper-pale-dark: "#4a2c1f"
  on-copper-dark: "#1a120e"
  blue: "#1e6fa8"
  orange: "#c8541a"
  purple: "#8350ad"
  green: "#23845a"
  gray-series: "#8b8c82"
  blue-dark: "#3d8fd0"
  orange-dark: "#e0702c"
  purple-dark: "#a06fd0"
  green-dark: "#2fa374"
  gray-series-dark: "#8e8d85"
  focus: "#1f678d"
  danger: "#a3342d"
  danger-pale: "#f7e4e0"
  caution-pale: "#f6eedb"
  caution-ink: "#6f5213"
  focus-dark: "#6aa8f0"
  danger-dark: "#e8776c"
  danger-pale-dark: "#3d2320"
  caution-pale-dark: "#38301c"
  caution-ink-dark: "#e5ca8c"
  c0: "#9f2a22"
  c1: "#df4a3f"
  c2: "#f19c82"
  c3: "#a8a59c"
  c4: "#8db8ee"
  c5: "#3a86e0"
  c6: "#164f98"
  c0-dark: "#ff8a75"
  c1-dark: "#e8604f"
  c2-dark: "#bf6a52"
  c3-dark: "#6c6a64"
  c4-dark: "#3c6ea8"
  c5-dark: "#4c92e6"
  c6-dark: "#93c5f8"
  paper: "#fbfaf7"
  surface: "#f2f0ea"
  surface-2: "#e8e6de"
  ink: "#242b28"
  muted: "#5d5f56"
  faint: "#6f7068"
  rule: "#dcded5"
  rule-strong: "#bfc4b8"
  paper-dark: "#171715"
  surface-dark: "#20201d"
  surface-2-dark: "#2b2b27"
  ink-dark: "#f0efec"
  muted-dark: "#bdbcb1"
  faint-dark: "#94928a"
  rule-dark: "#33332f"
  rule-strong-dark: "#4c4b46"
typography:
  display:
    fontFamily: '"Big Shoulders Display", "Arial Narrow", sans-serif'
    fontSize: "34px"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "0.002em"
  headline:
    fontFamily: '"Big Shoulders Display", "Arial Narrow", sans-serif'
    fontSize: "25px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "0.004em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.008em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  note:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "12px"
    fontWeight: 600
  figure:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "27px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  table:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "13px"
    fontWeight: 400
  axis:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "11px"
  code:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: "12px"
    lineHeight: 1.6
rounded:
  cell: "2px"
  segment: "3px"
  control: "4px"
  segment-group: "5px"
  tooltip: "5px"
  popover: "6px"
  marker: "50%"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "24": "24px"
  gutter: "28px"
  "36": "36px"
  rail: "196px"
components:
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 14px"
    height: "36px"
  button-hover:
    backgroundColor: "{colors.surface}"
  button-primary:
    backgroundColor: "{colors.copper}"
    textColor: "{colors.on-copper}"
    rounded: "{rounded.control}"
    padding: "6px 14px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.copper-hover}"
  button-small:
    rounded: "{rounded.control}"
    padding: "3px 10px"
    height: "28px"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "36px"
  segment:
    textColor: "{colors.muted}"
    rounded: "{rounded.segment}"
    padding: "2px 10px"
    height: "28px"
  segment-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  nav-item:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "4px 8px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  figure:
    textColor: "{colors.ink}"
    typography: "{typography.figure}"
    padding: "12px 16px 13px"
  table-cell:
    typography: "{typography.table}"
    padding: "7px 10px"
  route-badge:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.segment}"
    padding: "0 6px"
    height: "21px"
  rank-marker:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.marker}"
    size: "20px"
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.tooltip}"
    padding: "8px 10px"
---

# Design System: Transit Notebook

Source of truth: `src/styles/app.css` holds the tokens and shared classes; components scope anything local. `-dark` keys in the frontmatter are the values of the same CSS variable under `:root[data-theme="dark"]` (for example `paper-dark` is `--paper` in dark), so components always read the bare variable and never branch on theme.

## Overview

**Creative North Star: "The Transit Notebook"**

A planner's working notebook: warm paper, charcoal ink, fine rules, and condensed uppercase headings. Each report leads with a finding in plain language, then a ruled strip of figures, then the map or chart that explains it, then a table with the evidence. Density is high and the surface stays flat, so the data is the loudest thing on the page.

Color carries meaning. Copper is the one interface accent, the speed classes run warm to cool, and midday blue stands against rush orange. Dark is a chosen theme for working late or presenting, not an inversion: the speed classes are re-tuned so that the slowest streets are the brightest warm marks on dark paper. There is no decorative imagery.

**Key Characteristics:**

- Warm paper and charcoal ink in two tuned themes, following the system setting unless the visitor chooses.
- Big Shoulders Display for headings; the system stack for everything read or compared.
- Ruled figure strips and ruled lists instead of cards.
- One absolute speed scale across every map and heatmap.
- Every figure links to the definition behind it.

## Colors

A low-saturation warm neutral base, with one interface accent and separate palettes for chart series and speed.

### Primary

- **Copper** (`copper`): primary action, text links, the active rail icon, the analysis progress line, and cached-day dots in the date picker.
- **Deep Copper** (`copper-hover`): hover on those actions.
- **Pale Copper** (`copper-pale`): text selection only.
- **On Copper** (`on-copper`): label on a primary button. It turns near-black in dark, where copper is lighter.

### Secondary

Chart series, validated together in both themes. Hold the meanings so a color reads the same across reports.

- **Midday Blue** (`blue`): midday, on-time, medians and observed counts.
- **Rush Orange** (`orange`): peak, bunching, close-spaced stops, and the time cursor. Peak hours (7–9 AM, 4–6 PM) are a band of this color at 7% opacity.
- **Purple** (`purple`): early departures and service after a gap.
- **Green** (`green`): the 9 AM–4 PM band in delay profiles, and the "Analyzed on this device" dot.
- **Series Gray** (`gray-series`): scheduled values and reference series.

Status colors:

- **Focus Blue** (`focus`): keyboard focus only.
- **Danger** (`danger`, `danger-pale`): failed analysis and stall messages, with error banners on the pale fill.
- **Caution** (`caution-ink`, `caution-pale`): data-quality notes about the selected days.

### Tertiary

**Speed classes** (`c0` to `c6`): the warm-to-gray-to-cool ramp, slow to fast. `c3` is the neutral middle. Read them through `src/lib/speed-scale.ts`, never by hand.

- Bus breaks are 5, 8, 10, 13, 16 and 20 mph. Rail and ferry use 10, 15, 20, 28, 36 and 45 mph. km/h labels round to the nearest 5.
- The map's "Against midday" measure reuses the same seven colors with ratio breaks (0.7, 0.8, 0.9, 1.1, 1.2, 1.35) and its own legend.
- Canvas and map layers read the computed variables at draw time, and maps rebuild when the theme changes.

### Neutral

- **Paper** (`paper`): the page, fields, and the opaque backing of sticky table cells.
- **Surface** (`surface`, `surface-2`): hover, the active rail item, code blocks, and neutral banners; `surface-2` marks the selected list row and hovered calendar day.
- **Ink** (`ink`): text, chart lines, and inverted fills such as selected segments, route badges, and tooltips.
- **Muted** (`muted`): labels, notes, axis text.
- **Faint** (`faint`): hovered control borders and the chart crosshair.
- **Rule** (`rule`, `rule-strong`): dividers and grid lines; `rule-strong` draws control borders, axes, and streets with no measurement.

The basemap has its own quiet palette for each theme in `src/map/style.ts`, held below the data on purpose.

**The One Accent Rule.** Copper means "act here" or "you are here". It never encodes data; data color comes from the series and speed tokens.

**The Same Scale Rule.** Speed classes are absolute, so a color means the same speed on every map, heatmap, and agency. Never rescale them to the data on screen.

## Typography

**Display Font:** Big Shoulders Display, self-hosted at weight 800 only (`public/fonts`), with Arial Narrow and sans-serif fallbacks.

**Body Font:** the system stack in the frontmatter.

**Mono Font:** the system monospace stack, for SQL and code.

**Character:** Tall condensed headings give the notebook its voice; a familiar system face carries the reading and the comparing.

### Hierarchy

- **Display** (`display`, uppercase, balanced): page `h1`, 28px at 860px and below. The map page uses 30px; the start screen uses 44px, or 34px when narrow.
- **Headline** (`headline`, uppercase, balanced): section `h2`.
- **Title** (`title`): `h3`, in the system face.
- **Lead** (18px, line-height 1.35, ink): the Overview's one-sentence finding. Other reports use a lede (15px, muted, capped at 72ch).
- **Body** (`body`): the page base, and computed findings.
- **Note and fine print** (`note`, capped at 86ch, and 12px): methods caveats, sublabels, scope lines. Both muted.
- **Figure** (`figure`): values in the figure strip, 22px at 860px and below; the unit sits beside it (13px, muted). Side-panel figures use 26px.
- **Label** (`label`): figure names and field labels (11.5–12px), muted. Sentence case, no tracking.
- **Table** (`table`): body cells with tabular figures; headers are 11.5px, weight 600, muted.
- **Axis** (`axis`): all chart text, with tabular figures. It keeps its size at every width.

**The Heading Face Rule.** Display type is for headings and the brand mark (21px). The map's hour readout (27px) is the one exception: it reads as the title of the map. Figures, tables, controls, and `h3` stay in the system face.

## Layout

The shell is a two-column grid: a 196px report rail beside the page, under a sticky 56px top bar with agency, days, mode, and analysis status. Pages cap at 1480px with a 28px gutter.

Sections stack with a 36px gap (22px on Overview) and are separated by a fine rule plus 28px of padding. Report bodies pair a flexible main column with a fixed side column: 300px findings on Overview, 280px on the map, 360px ranked list on hotspots, 320px on route detail. Maps size to the viewport with `calc(100dvh - …)` and a 280px floor, so the map and its time control are both visible without scrolling.

### Narrow screens

- **860px and below:** one column. The rail becomes a horizontally scrolling text row that sticks to the top, without icons or the preferences block; the top bar stops sticking and wraps with selectors on their own line, hiding the download estimate. The gutter drops to 16px, and figure strips become two columns with no divider on the left column.
- **1100px / 1000px and below:** paired report columns collapse (1100px for Overview, hotspots, and route detail; 1000px for map, reliability, and stops), and sticky side columns become static.
- **Tables** never reflow. They scroll inside their own region, with cell padding reduced to 6px.
- **560px and below:** the date picker stacks presets above the calendar.
- **480px and below:** map attribution starts collapsed so it can't cover the scale bar.

## Elevation & Depth

The system is flat. Rules and tonal fills establish hierarchy, and only things that float above the page have a shadow.

### Shadow Vocabulary

- **Pop** (`--shadow-pop`, tuned per theme): the tooltip and the date picker panel only.

The table's right-edge scroll shadow is a scrolling cue, not elevation. Its first layer scrolls with the table and covers the shadow at the far end, so it disappears once no columns remain. Sticky cells use inset hairlines, not drop shadows.

**The Ruled Surface Rule.** Group with a rule, not a box. If something needs a shadow, it should be floating over the page.

## Shapes

Corners are small and consistent: 4px for controls and map frames, nested 5px and 3px for segmented groups, 2px for legend swatches. Circles are reserved for markers and status dots. Icons are inline SVG strokes on a 20-unit view box at 1.5 weight, inheriting text color. Chart marks are square-edged, and grid lines use crisp edges.

## Components

### Buttons

Plain and compact. Default is paper with a `rule-strong` border and a surface hover; primary is copper; quiet is borderless and muted; small is 28px. The text link is copper with an underline on hover, and it's the action inside findings. Transitions run 120–150ms ease-out; disabled is 55% opacity; every control takes the 3px focus ring, offset 2px.

### Inputs / Fields

Native selects, search, and checkboxes in a paper fill with a `rule-strong` border that strengthens on hover. Fields without visible labels carry a screen-reader label.

### Segmented control

An outlined group of plain buttons; the selected one fills with ink and paper text, carried by `aria-pressed`. Used for mode, units, theme, map period, and measure. It wraps rather than overflowing.

### Navigation

Rail rows with an 18px icon and a 13.5px label. Active is a surface fill, ink text at weight 650, and a copper icon. The foot of the rail holds units, theme, and the on-device statement.

### Date picker

A trigger button opening a floating panel of presets beside a calendar. Selected days are ink-filled, weekends are faint, and a small copper dot marks days already analyzed.

### Ruled figure strip

A definition list between two rules, with hairline dividers between auto-fit columns (150px minimum). Each figure is name, value with unit, then one line of context. No card, no fill. Figures belong here rather than in tiles, and a page may stack two strips.

### Term

The link from a figure or chart name to its method. It inherits the surrounding text with a dotted `rule-strong` underline, turns copper on hover, and has the tooltip "How this is calculated". Selecting it opens that topic on Data & methods, scrolled into view with focus on its summary. It's a real button, so it works by keyboard and touch. Wrap every computed figure's name in one, and add a topic to `MethodTopic` when a new definition needs its own section.

### Data table

Sortable, with CSV export and optional search, always inside its own scroll region.

- **Sticky first column and header:** the row's name stays put while the rest scrolls, on opaque paper with an inset hairline.
- **Scroll shadow:** the right-edge cue described under Elevation & Depth.
- **Row limit:** long tables pass `limit={25}` with a text link reading "Show all N" (then "Show first 25"). Once expanded they scroll inside a capped height, typically 72vh.
- **Cells:** numbers are right-aligned and tabular, and text columns opt into left alignment. Cells either clip to one line with the full text in a hint, or wrap. Missing values show an em dash and sort last.
- **Rows:** a surface fill on hover; clickable rows open the route or outline the stretch on the map.

### Speed map

MapLibre lines over the quiet basemap, with labels drawn above the data. Layers from the bottom:

- **Network base:** all streets in a thin `rule-strong` line, so an unmeasured street reads as "no data" rather than a gap.
- **Hover and ranked casing:** a wider ink line beneath the data.
- **Speed lines:** colored by class, offset by direction as you zoom in.
- **Slow-street emphasis:** the same lines redrawn wider and on top wherever speed falls below the third break (10 mph for bus, 20 for rail and ferry; 90% of midday in "Against midday"). Slow streets are what the map is for. This layer is a paint change only, so moving through the hours stays smooth.
- **Highlight:** ink over a paper casing, for a chosen stretch.

Map controls are restyled onto paper with rule borders. If WebGL or the tiles fail, the page says so in plain text and keeps working.

### Numbered hotspot markers

Numbered circles (20px, ink fill, paper border, 11px tabular numerals) at the middle of the top 10 stretches. Each stretch also has an ink casing. Numbers match the ranked list beside the map under any sort. A marker hovers to copper and selecting it selects that row. The map frames the ranked stretches rather than the whole network.

### Time control

The network's own speed curve is the slider: an ink line (2.5px) on a tight y-axis, because a wider axis would flatten the rush hour. Peak bands sit behind it, and an orange cursor and dot mark the hour. Drag along the line, or use arrow keys, through a transparent native range input laid over the plot; focus rings the whole track. Play steps an hour every 650ms. Above the plot sit the Play button, the hour readout, and the speed for that hour. It appears on Overview and on the map's hour-by-hour period, and hour labels thin out below 460px.

### String line and other canvas charts

Observed trips are ink, scheduled trips are `rule-strong`, and bunched stretches are thick orange. Charts read tokens at draw time, carry a legend of keys and swatches, and report exact values through the shared ink tooltip.

### Banners

Flat, 4px fills with no icon or border: neutral, caution, and error. Copy says what happened and what remains usable.

### Route badge

A compact label in the agency's published route colors. It falls back to ink and paper when the published pair is missing or unreadable.

## Do's and Don'ts

### Do:

- **Do** lead a report with its finding, then figures, then the evidence.
- **Do** add new colors as CSS variables with values for both themes, and read them with `var()` or from computed style in canvas and map code.
- **Do** use the shared speed scale for any speed shown as color, with `SpeedLegend` beside it.
- **Do** wrap every computed figure's name in `Term`.
- **Do** keep tables in `DataTable`, with `limit={25}` for anything long.
- **Do** say what isn't known: gray for unmeasured streets, a dash for missing values, a plain sentence when a map can't draw.
- **Do** check every change at 390px and in both themes.

### Don't:

- **Don't** put figures in cards or tiles; use the ruled strip.
- **Don't** set figures, table values, or controls in the display face.
- **Don't** use copper to encode data, or reassign a series color's meaning in one chart.
- **Don't** scale whole charts or tables down to fit a narrow screen; contain the scroll and keep the axis text at 11px.
- **Don't** add shadows to anything resting on the page.
- **Don't** add decorative imagery, or apply Trusted Health or Hex branding to this personal project.
