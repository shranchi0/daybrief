# daybrief design system & editorial rules

Source of truth for the M2 dashboard build. Designs live in Paper:
**app.paper.design/file/01KZA2WAPKGTWE5100E3BM9BD8** — artboards: Today, Brief · Formal, Company · E2B, States.
Export exact values with Paper's `get_jsx`/`get_computed_styles`; never build from screenshots.

## North star

The product answers five questions: what meetings matter today · what is this company · why am I
meeting them · what should I know · what should I ask. Every default-screen element serves one of
those. Research mechanics (verification, confidence, source counts, timestamps, generation) stay
hidden unless something went wrong, is uncertain, or the user asks. The result should feel like a
sharp chief of staff prepared the agenda — not a research agent showing its work.

## Tokens

Colors (semantic roles — the page must read in grayscale):
| Role | Value |
|---|---|
| Ground (fog) | `#F2F4F6` |
| Surface (paper) | `#FFFFFF` |
| Primary text (ink) | `#151C26` |
| Secondary text (muted) | `#5C6673` |
| Tertiary/peripheral (faint) | `#8B94A1` |
| Hairline (line) | `#E3E7EC` |
| Accent (navy) — actions, links, selection, focus ONLY | `#16456B` (wash `#E9EFF5`) |
| Signal (buoy red) — reserved: needs intervention or changed interpretation; always with text | `#B5402C` (wash `#F8ECE9`) |
| Next-meeting tint | `#F5F8FA` |

Type — ONE typeface: **Schibsted Grotesk** (Google Fonts). Mono is retired from product UI
(domains, costs, counts are sans); use mono only for genuinely code-like content.
| Role | Spec |
|---|---|
| Page title | 20–26px / 600 / −0.02em |
| Section heading | 15px / 600 / sentence case (no caps, no tracking) |
| Body / brief prose | 14–15px / 400 / lh 20–23px |
| Row title | 15px / 600 |
| UI label / metadata | 13px / 400–500 / muted (never below 12px; core UI ≥14px) |
| Interactive text | 13–14px / 500 / navy |

Spacing 4px scale (heading→content 8; related ¶ 8–12; between sections 28–32; major page
division 40–48). Radius: 6px controls, 8–10px surfaces. Control heights 28/36/44. Icons 16/20.
Shadows only for true elevation (menus, modals, drag). No card soup: dense lists are rows on one
surface with hairline dividers; the brief is a document directly on the page, no outer card.

## Day view (agenda, not mini-briefs)

- Header is one line: greeting 20/600 + date muted + "N briefs ready". No timestamps — freshness
  surfaces only as exceptions ("Updated before the latest funding announcement").
- Row anatomy: time lane (52px, right-aligned) · primary column · compact action area. Whole row
  clickable; no persistent chevrons (hover-reveal only); subtle hover background.
- **Row content depends on meeting type**:
  - First meeting: what the company does · who the founder is · how the meeting came together
  - Follow-up: attendees · last met · what changed/open
  - Portfolio: purpose · latest material development · issues needing attention
  - Internal: title only (one compact line)
  - Unresolved: who · "Company not identified" · **Identify company** action
- Next meeting: expanded (~104–120px), `#F5F8FA` tint, small "Next" label, contextual primary
  action. Join call is temporal: brief → (≤15–30 min before) Join call → (after) Notes / Draft
  follow-up. Later external rows 72–88px, internal 40–48px.
- Warnings are specific and quiet: "Roles unverified" inline in signal color — never generic
  badges. Skipped/personal events collapse to "N other calendar events" (expand on demand).

## Brief page (executive brief + progressive disclosure)

Header: company name + verified glyph (successful identity resolution is silent — details behind
the glyph) + domain + one meta line ("First meeting with X · Thu, 9:00–9:30 am") + ⋯ overflow.
No confidence line, no verification sentence, no primary AI button.

First screenful must fully prepare the meeting: summary ¶ (16/24) · relationship ¶ ·
**"Questions for the meeting"** (3–5). Then a hairline, then **Background** (Founder, Product,
Market, Funding) adding only NEW depth — never restating the summary. No "What it is" / "How we
got introduced" sections (relationship history is a link).

- No source counts or confidence labels anywhere. Confidence is claim-level, in prose:
  "The company says…", "Hiring materials suggest…", "…could not be verified", "No public evidence
  was found for…". Separate fact / inference / question linguistically.
- Funding is prose unless multiple rounds justify a table.
- No sidebar. Footer: "Updated today · N sources" → opens the research drawer (timestamps, source
  list with human names — "Company website", "LinkedIn" — citations, identity resolution, prior
  versions, corrections, refresh / deeper research). Overflow ⋯: refresh research, run deeper
  research, view citations, company timeline, correct company, report inaccuracy, copy, export.
- Full-width banners are reserved for warnings that change interpretation (e.g. two companies with
  the same name — with "This is the right company / Switch to …" resolution actions).

## Exception states (see States artboard)

Researching (with ETA) · research failed (+ Retry) · ambiguous identity (the one allowed banner) ·
stale brief (thin line + Refresh) · stealth/no-public-info (honest brief leaning on intro email +
deck) · post-meeting (row becomes Add notes / Draft follow-up) · empty day (quiet, with "brief a
company now"). Success stays quiet; exceptions get explicit.

## Motion (build phase)

Crisp-dashboard register: 150–250ms, `cubic-bezier(0.23, 1, 0.32, 1)` ease-out; press feedback
`scale(0.97)`; ⌘K palette and keyboard actions never animate; the one delight spend is a 40ms
stagger on the morning Today reveal; hover gated by `(hover: hover) and (pointer: fine)`;
`prefers-reduced-motion` variants ship with every animation.
