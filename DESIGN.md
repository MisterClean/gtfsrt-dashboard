---
name: Transit Notebook
description: A warm, restrained visual system for inspecting public transit archive observations.
colors:
  copper: "#ac4d2b"
  copper-hover: "#8b391b"
  copper-pale: "#f2e1d5"
  blue: "#2d6884"
  green: "#386b53"
  focus: "#1f678d"
  danger: "#a3342d"
  paper: "#fbfaf7"
  surface: "#f2f0ea"
  ink: "#242b28"
  muted: "#62645b"
  rule: "#dcded5"
  white: "#fff"
  control-border: "#bfc4b8"
  control-border-hover: "#888f81"
  route-green: "#477052"
  route-plum: "#8e6679"
  route-ochre: "#97742c"
  route-violet: "#726fa0"
  route-grey-green: "#596859"
  heat-empty: "#e9ebe3"
  heat-low: "#ead3c2"
  heat-mid: "#dca17e"
  heat-high: "#bd6e48"
  heat-peak: "#91411f"
typography:
  display:
    fontFamily: '"Big Shoulders Display", "Arial Narrow", sans-serif'
    fontSize: "44px"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.01em"
  headline:
    fontFamily: '"Big Shoulders Display", "Arial Narrow", sans-serif'
    fontSize: "30px"
    lineHeight: 1.15
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "19px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "12px"
    fontWeight: 650
  control:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "14px"
    fontWeight: 650
  metric:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "34px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  axis:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "11px"
  code:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: "12px"
    lineHeight: 1.7
rounded:
  control: "4px"
  panel: "8px"
  segment-group: "5px"
  segment: "3px"
  cell: "2px"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "18": "18px"
  "20": "20px"
  "24": "24px"
  "32": "32px"
  "36": "36px"
components:
  button-primary:
    backgroundColor: "{colors.copper}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 17px"
  button-primary-hover:
    backgroundColor: "{colors.copper-hover}"
  button-cancel:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 17px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 17px"
  button-text:
    textColor: "{colors.copper}"
    padding: "7px 0"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "44px"
  navigation:
    textColor: "{colors.muted}"
    padding: "12px 0"
  segment:
    textColor: "{colors.muted}"
    rounded: "{rounded.segment}"
    padding: "6px 12px"
  segment-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  selection-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "18px 20px 12px"
  metric-strip:
    textColor: "{colors.ink}"
    padding: "16px 0"
  route-row:
    textColor: "{colors.ink}"
    padding: "12px 0"
---

# Design System: Transit Notebook

## Overview

**Creative North Star: "The Transit Notebook"**

A warm, restrained transit notebook pairs paper surfaces and charcoal ink with compact quantitative views. Copper identifies the main action and selected views; typography and fine rules organize the information. The supplied CTA Bus Speed Scorecard establishes this personal project's visual family.

Condensed display headings give the notebook its identity. Familiar system text, native fields, tabular figures, and direct explanations carry the working interface. Flat surfaces leave charts, route comparisons, raw observations, and provenance easy to inspect. The implementation is code-led and ships no decorative raster imagery.

**Key Characteristics:**

- Warm paper and charcoal ink, with copper actions and blue secondary data.
- Self-hosted condensed display headings above quiet system text.
- Flat ruled sections, compact native controls, and aligned numerical comparisons.
- Readable chart axes, contained horizontal scrolling, and inspectable source evidence.

## Colors

The palette is warm and low in saturation; functional accents stand apart from the paper and muted rules.

### Primary

- **Copper** (`copper`): the load action, active navigation, text actions, and activity bars.
- **Deep Copper** (`copper-hover`): the hover state of primary and text actions.
- **Pale Copper** (`copper-pale`): browser text selection.

### Secondary

- **Data Blue** (`blue`): secondary data and the interactive hourly-bar highlight.
- **Archive Green** (`green`): local-processing status and hours with archived records.
- **Focus Blue** (`focus`): keyboard outlines and chart focus feedback.
- **Danger Red** (`danger`): the cancel-load action; error surfaces retain their contextual warm red treatment.
- **Route Green, Plum, Ochre, Violet, and Grey Green** (`route-*`): the additional categorical series used with copper and blue in route swatches and position points.
- **Heat Empty through Heat Peak** (`heat-*`): the implemented five-step archive-observation heatmap. These are data values, not surface elevations.

### Neutral

- **Warm Paper** (`paper`): the page and native field backgrounds.
- **Soft Surface** (`surface`): selection panels, bar tracks, detail strips, and row hover states.
- **Charcoal Ink** (`ink`): primary text and the selected chart-measure segment.
- **Muted Ink** (`muted`): explanatory text, labels, axes, and inactive navigation.
- **Fine Rule** (`rule`): section, metric, table, and grid separation.
- **White** (`white`): text on filled action buttons.
- **Control Border** and **Control Border Hover** (`control-border`, `control-border-hover`): native field boundaries and their hover feedback.

**The Functional Accent Rule.** Copper marks actions, selection, and primary observations; green and blue retain their distinct status and data roles.

## Typography

**Display Font:** Big Shoulders Display, with Arial Narrow and sans-serif fallbacks. The project serves its own normal-style face at weight (800).

**Body Font:** the system stack recorded in the frontmatter, ending in Arial and sans-serif.

**Label/Mono Font:** labels share the system stack. SQL uses the recorded system monospace stack.

**Character:** Tall, condensed headings provide identity without changing the familiar reading texture of forms, tables, and methods. Numerical comparisons use tabular figures.

### Hierarchy

- **Display:** the uppercase page heading uses the `display` role; its size drops to (38px) at the narrow breakpoint.
- **Headline:** report headings use the `headline` role and the served display face; the narrow report heading is (28px). The empty-state heading is a contextual larger variant (36px).
- **Title:** section headings use the `title` role, dropping to (18px) on narrow screens. Method subheadings use system text (14px, weight 650, line-height 1.5).
- **Body:** the `body` role establishes the page base. Explanatory interface copy commonly uses (12–13px); the introductory and method text measure is capped at (72–75ch).
- **Label and control:** the `label` and `control` roles keep native fields and actions compact. Field values use (14px, weight 450); compact filters use (12px).
- **Metric:** the `metric` role uses tabular figures. Values are (36px) at the medium layout and (32px) at the narrow layout; metric labels are contextual uppercase data labels.
- **Axis:** the `axis` role stays at its recorded readable size while the plot scrolls. It is not reduced with the viewport.
- **Code:** the `code` role provides scrollable SQL with a narrow-screen size of (11px).

**The Heading Face Rule.** Reserve Big Shoulders Display for headings; controls, metric values, tables, and prose use the system stack.

## Layout

The workspace is centered with a maximum width of (1280px), including horizontal padding (32px). The identity bar has its own maximum width (1344px). Fine horizontal rules organize full-width working sections; the default composition is not a grid of elevated cards.

Selection controls use a four-column grid: a flexible agency field, two bounded date fields, and an action. At (1050px) and below the action moves to a separate row. At (540px) and below the agency spans both columns, dates remain side by side, and the action fills the row. Workspace side padding becomes (24px) at (760px), then (18px) at (540px).

The summary uses four equal columns with internal dividers. At (760px) and below it becomes two columns and two rows. The overview's route and explanation columns use a (1.4fr / 1fr) relationship and collapse into one column at the same breakpoint. Provenance also changes from two columns to one there. Supporting copy wraps, including long historical schedule identifiers.

Hourly charts, route heatmaps, and position plots retain an intrinsic width of (1120px) inside their own scroll regions. Horizontal-scroll instructions appear below (1183px); focusable regions, chart focus feedback, and exact hourly values keep the data inspectable. The coverage grid retains a minimum width of (715px), and the route table retains a minimum width of (660px).

Spacing is compact and contextual, using the repeated frontmatter steps rather than imposing a fixed ratio. Common controls use gaps (8–16px); section content separates by (20–36px). The overview's two-column separation is wider (48px) before responsive reductions.

## Elevation & Depth

The shipped system uses no box shadows. Warm tonal surfaces, fine rules, and selected-state fills establish hierarchy. A keyboard focus ring is a state indicator, not elevation: it uses the focus color, an outline (3px), and an offset (4px).

**The Ruled Surface Rule.** Keep data sections flat and separate them with fine rules; use a toned panel for grouped controls or contextual information.

## Shapes

Controls and contextual panels have gently rounded corners. The larger selection panel uses the `panel` radius; fields, filled buttons, position plots, and warning panels use the `control` radius. The chart-measure group and its individual segments use their own small nested radii. Heatmap and coverage marks remain small, rectilinear cells; status dots are circular.

Icons are inline SVG strokes, inheriting the surrounding text color. The standard icon uses a square view box (20 × 20), stroke width (1.5), and round line caps and joins. Text actions use smaller icons (16px), external links (13px), and table sorting (14px).

## Components

### Buttons

Compact and direct. Primary, cancel, and secondary actions share a minimum height (44px), the control radius, and a system-text semibold label. Primary uses copper with white text; cancel uses danger red, with its contextual deeper hover color. Secondary uses paper with a thin muted border and a surface-colored hover.

Text actions have no filled container; copper text gains a visible underline and deeper copper on hover. Buttons transition background and text color over (150ms, ease-out). Pressing an enabled button applies a brightness factor (.93). Disabled native controls use opacity (.55). All interactive controls retain the shared keyboard focus ring. Reduced-motion preferences remove animations and transitions.

### Cards / Containers

The selection panel is a tonal grouping, not a raised card. Its padding follows the frontmatter, becoming (18px) at the medium breakpoint and (16px) at the narrow breakpoint. Warnings, empty inline messages, and position details use contextual surface fills; ordinary report sections remain on paper.

### Inputs / Fields

Use native selects, date inputs, and search fields. Fields have a paper fill, the control radius, and a thin control border. Hover strengthens the border; focus uses the shared outline. A visible text label precedes every field. Compact report filters are (34px) high, and route search is (36px) high.

### Navigation

Views use a horizontal row of plain text buttons over one fine rule. The active view has copper text, a copper bottom border (2px), and semibold weight. Hover darkens text. On narrow screens the four view labels remain visible with smaller gaps; the auxiliary archive label is hidden.

### Chart Measure Segments

An outlined group encloses compact plain segments. The selected segment uses charcoal ink with paper text; inactive segments use muted text and a soft hover surface. The implementation carries selection through `aria-pressed`.

### Quantitative Views

The summary strip uses definition-list labels, tabular values, and internal dividers. Route comparisons are ruled interactive rows containing an identifier, an abbreviated name, a copper bar on a soft track, and a right-aligned count. Tables right-align quantitative route columns, preserve sortable headers, and use a quiet row-hover surface. Route selection reuses the local loaded report.

Charts keep axis labels at the `axis` role, preserve their intrinsic dimensions, and expose values through titles, focus feedback, or the hourly table. Position points and route swatches share the categorical colors. Coverage cells distinguish records present from no records; captions explain that archive coverage is not service completeness.

### Sources and Methods

Provenance uses plain definition lists, wrapping values, and quiet explanatory prose. Long schedule digests wrap within the method text. SQL is disclosed with native details elements and an independently scrollable monospace block; its contextual green-tinted surface does not become a general panel color.

## Do's and Don'ts

### Do:

- **Do** use the self-hosted display face for headings and the system stack for working text.
- **Do** preserve copper actions, distinct data and status colors, and tabular numerical alignment.
- **Do** keep report sections flat, with fine rules and restrained tonal groupings.
- **Do** retain readable chart axes, contained scrolling, visible narrow-screen instructions, and inspectable values.
- **Do** let long provenance and schedule identifiers wrap within their text columns.
- **Do** preserve visible keyboard focus, native field behavior, and reduced-motion support.

### Don't:

- **Don't** apply Trusted Health branding to this personal transit project.
- **Don't** shrink whole quantitative plots to fit a narrow viewport and make their axes unreadable.
- **Don't** replace the inline SVG controls with text glyph icons.
- **Don't** add decorative imagery or raised card treatments to the confirmed notebook world.
- **Don't** style archive observation counts as inferred service, speed, ridership, or on-time performance.
