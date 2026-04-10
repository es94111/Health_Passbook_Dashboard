# Design System — 健康存摺儀表板

## Product Context
- **What this is:** Personal health data dashboard visualizing Taiwan NHI (健康存摺) JSON exports
- **Who it's for:** The owner — a developer reviewing their own 3+ years of medical history
- **Space/industry:** Personal health data / medical records visualization
- **Project type:** Data-dense personal dashboard (web app)

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian
- **Decoration level:** Minimal (typography and color carry all the weight — no gradients, no blobs, no icons in colored circles)
- **Mood:** The records are the content. Design gets out of the way. Not "wellness app." Not "hospital system." A personal data terminal built with craft.
- **Default mode:** Dark mode is the primary experience — designed for evening review after work. Light mode is a secondary toggle.

## Typography
- **Numbers & UI labels:** Plus Jakarta Sans — excellent tabular numeral rendering, clean for data-heavy layouts. Use for stat values, dates, section headings, button labels.
- **Chinese body text:** Noto Sans TC — no better alternative for Traditional Chinese. Use for diagnoses, drug names, visit details, form labels.
- **Numeric precision values:** Geist Mono — for specific lab values, reference ranges, codes, and timestamps where monospace alignment matters.
- **Loading (Google Fonts):**
  ```html
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
  ```
- **Scale:**
  - xs: 10px / 11px
  - sm: 12px / 13px (table cells, badges, captions)
  - base: 14px (body, form inputs)
  - md: 15px / 16px (card titles)
  - lg: 18px (section headings)
  - xl: 24px (page headings)
  - stat: 28px–32px (summary stat values, font-feature-settings: 'tnum')

## Color

### Light Mode
```css
--bg:           #fafafa;   /* warm white — not clinical pure white */
--surface:      #ffffff;   /* cards */
--surface-2:    #f3f4f6;   /* input backgrounds, muted zones */
--border:       #e5e7eb;
--text:         #111827;
--muted:        #6b7280;
--teal:         #0f766e;   /* primary accent */
--teal-hover:   #115e59;
--teal-light:   #e6f4f1;   /* teal backgrounds (active tab, badges) */
--amber:        #d97706;   /* secondary accent — notable/watch values */
--amber-light:  #fef3c7;
--error:        #dc2626;
--error-light:  #fee2e2;
--success:      #059669;
--success-light:#d1fae5;
--info:         #2563eb;
--info-light:   #dbeafe;
```

### Dark Mode (default)
```css
--bg:           #0f172a;   /* slate-900 */
--surface:      #1e293b;   /* slate-800 */
--surface-2:    #334155;   /* slate-700 */
--border:       #334155;
--text:         #f1f5f9;   /* slate-100 */
--muted:        #94a3b8;   /* slate-400 */
--teal:         #14b8a6;   /* teal-500 — lighter for dark bg */
--teal-hover:   #5eead4;
--teal-light:   #134e4a;
--amber:        #f59e0b;   /* amber-500 */
--amber-light:  #451a03;
--error:        #f87171;   /* red-400 */
--error-light:  #450a0a;
--success:      #34d399;   /* emerald-400 */
--success-light:#052e16;
--info:         #60a5fa;   /* blue-400 */
--info-light:   #1e3a5f;
```

### Semantic usage
- **Teal:** Primary actions, active states, links, accent highlights
- **Amber:** Out-of-range lab values (borderline), notable patterns, "watch" status — calmer than red, still communicates "pay attention"
- **Error/Red:** Definitively out-of-range values, destructive actions, system errors
- **Success/Green:** Normal values, successful operations
- **Info/Blue:** Informational states, secondary data

## Spacing
- **Base unit:** 8px
- **Density:** Comfortable (not compressed, not airy — this is data-dense content)
- **Scale:** 2px / 4px / 8px / 12px / 16px / 20px / 24px / 32px / 48px / 64px
- **Component padding:** Cards 20px; Stat cards 16px; Table cells 10px
- **Section gaps:** 16px (within section) / 56px (between sections)

## Layout
- **Approach:** Grid-disciplined — strict card-based sections, consistent gutters
- **Max content width:** 1100px, centered
- **Grid:** 12-column, 16px gutters
- **Cards:** border-radius 10px–12px, 1px border, subtle shadow
- **Tabs:** rounded 6px, no underline — active state uses teal-light background
- **Border radius scale:**
  - sm: 4px (badges, small pills)
  - md: 6px–8px (buttons, inputs)
  - lg: 10px–12px (cards)
  - full: 999px (status badges, circular elements)

## Motion
- **Approach:** Minimal-functional — only transitions that aid comprehension
- **Easing:** enter: ease-out; exit: ease-in; move: ease-in-out
- **Duration:**
  - micro: 50–100ms (button press, toggle)
  - short: 150–200ms (tab switch, hover state)
  - medium: 250–350ms (panel open, color theme switch)
- **Avoid:** Scroll-driven animations, entrance choreography, decorative motion

## Dark Mode Implementation
- Use `data-theme="dark"` on `<html>` as default
- Implement via CSS custom properties on `[data-theme="dark"]`
- Toggle button in app header
- Persist choice in `localStorage`
- Do NOT rely on `prefers-color-scheme` as sole mechanism — explicit toggle takes precedence

## Tailwind Mapping (existing codebase)
The existing codebase uses Tailwind. Custom properties should be applied via a Tailwind theme extension or via direct CSS. Key mappings:
- `teal-700` → `#0f766e` ✓ already correct for light mode
- `gray-100/200/400/500/700/800` → remain valid for light mode surfaces
- Dark mode requires CSS custom properties or Tailwind dark: variants

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-10 | Plus Jakarta Sans for numbers/labels | Latin-optimized tabular numerals render better for lab values and stats than Noto Sans TC alone |
| 2026-04-10 | Amber as "notable value" secondary accent | More informative than red-for-everything; distinguishes "watch this" from "this is wrong" |
| 2026-04-10 | Dark mode as primary experience | Personal tool used evenings; designed for the actual usage pattern |
| 2026-04-10 | Teal (#0f766e / #14b8a6) as primary accent | Already established in 12+ components; not worth breaking |
| 2026-04-10 | Noto Sans TC for all Chinese text | No better alternative for Traditional Chinese |
| 2026-04-10 | Geist Mono for lab values and timestamps | Monospace alignment matters for numeric precision reading |
| 2026-04-10 | Minimal decoration | Data is the content; design stays out of the way |
