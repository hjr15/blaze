# Blaze — brand

Source assets in this folder:
- `logo-primary.png` — primary logo (mark + "Blaze" wordmark).
- `brand-sheet.png` — the full kit (lockups, palette, type, app icon, traits).

## The mark

A comet/meteor with a warm flame trail; embedded in the comet head is a white
**ticket card** — a checkmark in a circle plus two lines. The logo *is* a task/issue
card moving fast, which ties the name (a blaze — a fast-moving trail marker) directly
to the product (a fast, agent-driven issue board).

## Lockups

| Lockup | Use |
|---|---|
| Primary (mark + wordmark + tagline) | README header, docs, marketing |
| Icon only (the comet/ticket mark) | web-app header, favicon source, compact contexts |
| Dark background (light wordmark + glow on Deep Charcoal) | dark mode, dark slides |
| App icon (rounded square) | favicon / installed-app icon |

## Tagline & positioning

- **Tagline:** Agentic AI for App Development
- **Positioning:** Blaze is an agentic AI that tracks, prioritizes, and resolves app
  development issues — so your team can ship with confidence.

> Scope note: v1 Blaze keeps the *board* (reconcile + groomer); it does not write
> code (worker loops are deferred — see `docs/design.md` → Non-goals). README/app copy
> should read "resolves" as *triage → prioritize → drive to resolution via the board*,
> not autonomous code fixes, so the copy matches what ships.

## Palette

| CSS token | Name | Hex |
|---|---|---|
| `--blaze-red` | Blaze Red | `#FF3B1F` |
| `--blaze-orange` | Blaze Orange | `#FF7A00` |
| `--blaze-amber` | Blaze Amber | `#FFC107` |
| `--charcoal` | Deep Charcoal | `#0F172A` |
| `--neutral` | Light Neutral | `#F6F7F9` |

## Typography

- **Heading:** bold, modern, confident (geometric/grotesque sans).
- **Body:** clean, readable, professional.

No exact webfonts are specified in the kit. To stay zero-dependency, the web app
defaults to a system stack that matches the vibe:
- Heading: `"Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif` (heavy weight).
- Body: same family, regular weight.

(The wordmark in the logo is a raster asset, so the live font only governs UI chrome.
A self-hosted webfont — e.g. a geometric sans — can be added later without changing
this design.)

## Brand traits

Fast · Focused · Intelligent · Clear.

## How the brand maps into Blaze

**Web app (`serve.mjs` inline CSS tokens):**
- Page background = Light Neutral `#F6F7F9`; primary text + column headers = Deep
  Charcoal `#0F172A`.
- Primary accent / active controls / the "● live" indicator = Blaze Orange `#FF7A00`,
  pulsing toward Blaze Red `#FF3B1F`.
- Header = the icon-only mark + "Blaze" wordmark + the tagline as a subtitle. A dark
  variant (Deep Charcoal bg, light wordmark) is available for a future dark mode.

**Priority heat ramp (kanban cards are colour-coded by priority):**
| Priority | Colour |
|---|---|
| urgent | Blaze Red `#FF3B1F` |
| high | Blaze Orange `#FF7A00` |
| medium | Blaze Amber `#FFC107` |
| low / none | Deep Charcoal tints / Light Neutral |

The palette doubles as the priority ramp — no extra colours needed.

**README:** primary logo at the top, the palette swatches, the tagline.

**Favicon / app icon:** exported from the app-icon lockup in `brand-sheet.png`.
