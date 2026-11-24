---
name: Venkateshwara Engineers ERP
description: A dense, flat, navy-and-paper working ledger for entering, approving and tracking numbers all day.
colors:
  ledger-navy: "#1e3a5f"
  ledger-navy-light: "#2c5282"
  ledger-amber: "#c9822a"
  paper: "#f4f6f8"
  sheet: "#ffffff"
  rule: "#dde3e8"
  ink: "#1a202c"
  pencil: "#6b7686"
  tick-green: "#2f855a"
  tick-green-deep: "#276749"
  stamp-red: "#c53030"
  stamp-red-deep: "#9b2c2c"
  caution-amber: "#b7791f"
  head-wash: "#f7f9fb"
  row-rule: "#edf1f4"
  row-hover: "#fafbfc"
  sidebar-text: "#e2e8f0"
  tint-pending: "#fef3cd"
  tint-success: "#dcf3e6"
  tint-danger: "#fde2e2"
  tint-info: "#dbeafe"
  ink-info: "#1d4ed8"
  tint-neutral: "#eeeeee"
  ink-neutral: "#666666"
typography:
  display:
    fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.25
  headline:
    fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.25
  title:
    fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.25
  subtitle:
    fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
  caption:
    fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  group-heading:
    fontFamily: "Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.05em"
rounded:
  sm: "5px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  pill: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ledger-navy}"
    textColor: "{colors.sheet}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.ledger-navy-light}"
  button-outline:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ledger-navy}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-success:
    backgroundColor: "{colors.tick-green}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-success-hover:
    backgroundColor: "{colors.tick-green-deep}"
  button-danger:
    backgroundColor: "{colors.stamp-red}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-danger-hover:
    backgroundColor: "{colors.stamp-red-deep}"
  button-small:
    typography: "{typography.caption}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  panel:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "18px"
  stat-card:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ledger-navy}"
    typography: "{typography.display}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "7px 9px"
  badge:
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  nav-item:
    backgroundColor: "{colors.ledger-navy}"
    textColor: "{colors.sidebar-text}"
    typography: "{typography.body}"
    padding: "9px 16px"
  table-head:
    backgroundColor: "{colors.head-wash}"
    textColor: "{colors.pencil}"
    typography: "{typography.label}"
    padding: "8px 10px"
  table-cell:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "8px 10px"
  modal:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.lg}"
    padding: "18px 20px"
    width: "560px"
---

# Design System: Venkateshwara Engineers ERP

## Overview

**Creative North Star: "The Shop-Floor Ledger"**

This is a working ledger, not a showcase. It is built for people who enter, check and approve numbers all day: purchase orders, sales orders, GRNs, invoices, service reports. Everything on screen is ink on cool paper. A fixed navy spine (the sidebar) holds navigation; the work happens on flat white sheets separated by hairline rules; one amber mark says "this is where you are" or "this needs you".

The density is deliberate. Type sits at 13px, table rows are 8px tall on each side, and a screen routinely carries a list, its filters and its row actions at once. Hierarchy comes from weight, a single navy accent for headings, and muted grey for secondary text, not from size jumps or decoration. Status is read from small tinted badges, the way a stamp on a paper form is read.

It is not a glossy consumer SaaS product: no big gradients (the login screen is the single exception), no oversized hero cards, no decorative illustration, no soft airy whitespace spent on content that should be scannable. Brand lives in the precision of the details: consistent radii, one type scale, aligned columns.

**Key Characteristics:**
- Flat surfaces separated by 1px hairlines; shadows only on hover and on overlays.
- One navy for structure and primary actions, one amber for the single "look here" mark.
- One Inter type scale (11 / 12 / 13 / 14 / 17 / 20px) shared by every screen.
- Status expressed as pale tint plus deep ink, never as a saturated fill.
- Tables and line-item grids with declared column tracks so columns line up row to row.
- Collapsed by default for grouped or repeating lists; edits happen in popups.

## Colors

A cool, desaturated palette: navy structure on blue-grey paper, with a warm amber and three signal colours used sparingly.

### Primary
- **Ledger Navy** (#1e3a5f): The sidebar background, primary buttons, panel headings, stat-card numbers, active tab and the login backdrop. The one colour that means "the system".
- **Ledger Navy Light** (#2c5282): Hover state of every navy surface, and the far end of the login gradient.

### Secondary
- **Ledger Amber** (#c9822a): The active-item marker (3px left bar on the selected nav item) and the nav count badge. Nothing else.

### Tertiary (signal colours)
- **Tick Green** (#2f855a): Approve / confirm actions and positive status text. Deepens to #276749 on hover.
- **Stamp Red** (#c53030): Reject / delete actions, error text, high-priority card edge. Deepens to #9b2c2c on hover.
- **Caution Amber** (#b7791f): Pending and warning text on a pale yellow tint. Distinct from Ledger Amber: this one is text on a tint, never a fill.

### Neutral
- **Paper** (#f4f6f8): Page background behind the sheets.
- **Sheet** (#ffffff): Panels, cards, modals, table surfaces, inputs.
- **Rule** (#dde3e8): Every border: panels, inputs, tabs, top bar, dividers.
- **Ink** (#1a202c): Body text.
- **Pencil** (#6b7686): Secondary text, table column headers, labels, hints.
- **Head Wash** (#f7f9fb): Table header and grid-header background.
- **Row Rule** (#edf1f4): The lighter divider between table rows and grid rows.
- **Row Hover** (#fafbfc): Table row hover.
- **Sidebar Text** (#e2e8f0): Nav item text on the navy sidebar.

### Status tints
Pairs of pale background plus deep text, used by `.badge.<Status>` and `.msg`: pending/yellow (#fef3cd on Caution Amber), success (#dcf3e6 on Tick Green), danger (#fde2e2 on Stamp Red), info/in-progress (#dbeafe on #1d4ed8), neutral/closed (#eeeeee on #666666), plus adjusted (#fde9cf on #92590b) and revoked (#ede9fe on #6d28d9) for the two rarer states.

### Named Rules
**The One Amber Rule.** Ledger Amber marks the current location and the unread count, and appears on nothing else. If a second thing on a screen is amber-filled, one of them is wrong.

**The Tint-Not-Fill Rule.** Status is a pale tint with deep text. A saturated fill is reserved for buttons, which are actions, not states.

**The Single Source Rule.** Colours come from the `:root` custom properties in `public/index.html`. A new hard-coded hex needs a reason; the existing inline status tints are the exception, not the pattern.

## Typography

**Display / Body Font:** Inter (with -apple-system, Segoe UI, Roboto, Arial fallbacks). Loaded from Google Fonts; if blocked, the stack falls through to the OS UI font so the app never looks broken.
**Label/Mono Font:** Inter for labels. Courier New for the `.mono` class (document numbers, codes).

**Character:** A tall-x-height, numeral-friendly sans set small and tight. It is chosen for dense data, where 1 vs l and 0 vs O must never be ambiguous.

### Hierarchy
- **Display** (700, 26px, 1.25): Stat-card figures only. The one oversized number on the dashboard.
- **Headline** (700, 20px, 1.25): The login title.
- **Title** (600, 17px, 1.25): The page title in the top bar.
- **Subtitle** (600, 14px, 1.25): Panel headings (Ledger Navy, with a bottom hairline), card titles, mono-sized emphasis.
- **Body** (400, 13px, 1.5): Table cells, form text, buttons, nav items. The app's default.
- **Label** (600, 12px, 1.5, Pencil): Table column headers, form labels (400), muted notes.
- **Caption** (400-600, 11px, 1.5): Badges, small buttons, hints, metadata.
- **Group heading** (10px, uppercase, 0.05em tracking): Sidebar group names only.

### Named Rules
**The One Scale Rule.** Font sizes come from `--fs-xs/sm/base/md/lg/xl`. A new magic pixel size means the scale is missing a step; add the step rather than the exception.

**The Bold-For-Rank Rule.** Rank is expressed by weight (400 / 600 / 700) and Ledger Navy, not by jumping sizes. Nothing in the app UI is larger than 20px except the stat figure.

## Layout

A persistent two-part shell: a 230px navy sidebar (scrolls on its own) and a main column made of a white top bar (12px / 24px padding, bottom hairline) and a scrolling content area with 24px padding. Content is a stack of panels with 20px between them.

Density is high and consistent. Spacing runs on a 4 / 8 / 12 / 16 / 24px rhythm: 8px between small items, 10px between form fields, 14-16px between cards, 18px inside a panel. Grids are `auto-fill` with a minimum track so they wrap by themselves: stat cards `minmax(180px, 1fr)` at 14px gap, form fields `minmax(180px, 1fr)` at 10px, charts `minmax(300px, 1fr)` at 16px, the access matrix `minmax(220px, 1fr)` at 14px. The To-Do board is a horizontally scrolling row of 290px columns.

Tables that hold inputs or buttons use declared tracks, not auto widths: line-item editors are a CSS grid (`gridLineTableHTML` / `.grid-line-table`) and multi-button action cells are `.row-actions` (auto-fill, 80px minimum), so columns line up down every row.

At 768px and below the sidebar becomes an off-canvas drawer (min(80vw, 280px)) behind a hamburger, content padding drops to 14px, form grids go to one column with 16px inputs (prevents iOS zoom), tables scroll horizontally inside themselves so the page never does, and every tap target grows to 38-48px.

### Named Rules
**The Declared-Tracks Rule.** If a column holds a live control, its width is declared once in a grid template and shared by header and rows. Never size one cell's input by hand.

**The Page-Never-Scrolls-Sideways Rule.** On phones the table scrolls, the page does not.

## Elevation & Depth

Flat by default. Depth is conveyed by a 1px Rule border on a white Sheet over Paper, not by shadow. Shadows appear only as a response (a hovered stat card) or as separation of a layer that floats over the page (modal, drawer, login box).

### Shadow Vocabulary
- **Card hover** (`box-shadow: 0 3px 12px rgba(0,0,0,.10)` with `translateY(-1px)` and a Ledger Navy border): Clickable stat cards on hover.
- **Modal** (`box-shadow: 0 8px 30px rgba(0,0,0,.25)` over a `rgba(0,0,0,.45)` backdrop): Popups for edit actions.
- **Drawer** (`box-shadow: 2px 0 12px rgba(0,0,0,.25)`): The mobile sidebar.
- **Login box** (`box-shadow: 0 10px 40px rgba(0,0,0,.25)`): The sign-in card over its navy gradient.

A faint company watermark (logo or name at ~3% opacity, fixed, pointer-events off) sits behind all content. It is branding, not depth.

### Named Rules
**The Flat-By-Default Rule.** A panel, table or form never has a resting shadow. If it needs separating, give it a border.

## Shapes

Gently rounded, never pill-shaped except for badges. Inputs 5px, buttons and small controls 6px, panels, cards, board columns and modals 8px, the login box 10px, badges 10px (full pill). Borders are always 1px Rule, solid. Two deliberate non-solid borders exist: dashed under an inline-editable cell and above the HOD tools block, signalling "editable / supplementary". A 3px solid left edge marks the active nav item (Ledger Amber) and a high-priority To-Do card (Stamp Red).

## Components

Plain, firm and legible. Controls look like what they are: a solid navy rectangle is a button, a bordered white box is a field.

### Buttons
- **Shape:** 6px corners; 8px / 16px padding at 13px / 600 weight, no uppercase.
- **Primary:** Ledger Navy fill, white text; hover shifts to Ledger Navy Light.
- **Success / Danger:** Tick Green and Stamp Red fills, each darkening on hover. Used for Approve and Reject / Delete.
- **Outline:** white fill, Ledger Navy text and 1px Ledger Navy border, for secondary actions (e.g. "Ask for More Info", "Details"). Grey and near-black outline variants mark FG Dispatch stages.
- **Small:** 4px / 10px padding at 11px, for row actions; always laid out in a `.row-actions` grid so labels wrap inside their cell instead of widening the column.
- **Mobile:** minimum height 44px (38px small).

### Cards / Containers
- **Panel:** white Sheet, 1px Rule border, 8px radius, 18px padding, 20px bottom margin; its `h3` is 14px / 600 Ledger Navy with a bottom hairline. Collapsible panels show a rotating chevron and hide their body when collapsed.
- **Stat card:** white, 8px radius, 16px padding; a 26px / 700 navy figure over a 12px Pencil label. The only card that lifts on hover.
- **Board column / To-Do card:** 290px column in the same border-and-radius language; cards are 6px radius with a 3px red left edge when high priority.

### Inputs / Fields
- **Style:** white fill, 1px Rule border, 5px radius, 7px / 9px padding, 13px Inter; labels sit above in 12px Pencil.
- **Focus:** inline-editable cells take a 1px Ledger Navy outline; standard inputs rely on the browser focus ring.
- **Error / Disabled:** messages use `.msg.err` (pale red tint, Stamp Red text) and `.msg.ok` (pale green tint, Tick Green text) in a 5px-radius strip above the form.

### Navigation
- **Sidebar:** Ledger Navy ground, white-ish text (#e2e8f0) at 13px, collapsible groups headed by 10px uppercase labels at 55% opacity, A to Z.
- **Item states:** hover adds a 8% white wash; active adds a 14% white wash, 600 weight and the 3px Ledger Amber left bar. Live count badges are amber pills with white 10px text.
- **Top bar:** white, 17px / 600 page title left, 12px Pencil user info and an outline logout button right.
- **Tabs:** 13px Pencil text; the active tab turns Ledger Navy, 600 weight, with a 2px navy underline on a Rule baseline.

### Tables
- **Header:** Head Wash ground, 12px / 600 Pencil, nowrap, 1px Rule underline; sortable headers show an arrow and turn navy on hover.
- **Rows:** 8px / 10px cell padding, Row Rule bottom border, Row Hover tint on hover. Footer rows are 600 weight on Paper.
- **Badges:** 11px / 600, 2px / 8px padding, full pill, status tint plus deep text.

### Modal
- 560px wide (wider on request, up to 1000px for large edit forms), white, 8px radius, 18px / 20px padding, over a dark backdrop. Edit actions are popups ending in a "Saved ✓" confirmation, not inline panels at the bottom of the page.

## Do's and Don'ts

### Do:
- **Do** take every colour, size and radius from the `:root` tokens and the type scale in `public/index.html`.
- **Do** separate surfaces with a 1px Rule border, and keep resting surfaces flat.
- **Do** show status as a pale tint with deep text (`.badge.<Status>`).
- **Do** put multi-button table cells in `.row-actions` and live-input tables in a declared grid so columns align.
- **Do** collapse grouped, repeating or secondary content by default behind an explicit expand control.
- **Do** verify padding and tap targets at 768px and below; the app is used on phones.

### Don't:
- **Don't** add a decorative gradient, hero card, illustration or large soft shadow to a working screen. The login backdrop is the only gradient.
- **Don't** use Ledger Amber for anything except the active-nav marker and count badge.
- **Don't** introduce a new font size or hand-picked pixel width for one cell; extend the scale or the grid template instead.
- **Don't** use a saturated fill to show status; fills are for buttons.
- **Don't** let the page scroll sideways on a phone; scroll the table.
- **Don't** treat the vendor quotation portal (`public/vendor.html`) as part of this system: it is a separate, external-facing page with its own lighter slate and green scheme (#1e293b / #16a34a, system-ui at 15px), and is not documented here.
