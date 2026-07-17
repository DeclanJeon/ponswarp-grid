# UI/UX Redesign 2026 — PonsWarp Grid Web

Status: Implemented in `apps/demo`  
Date: 2026-07-17

## 1. Product truth

Grid is **piece-based P2P file transfer**: sender keeps the file, receiver pulls pieces, resume + SHA-256 verify. UI must sell **direct, private, resumable** — not cloud drive storage.

## 2. Design references (award / product 2025–2026 language)

| Reference language | Takeaway applied |
|---|---|
| Linear / Raycast / Vercel product sites | Near-black canvas, one accent, dense-but-calm type, glass panels |
| Awwwards Product Honors pattern | Hero clarity + bento action cards, not decorative overload |
| Apple Continuity / AirDrop mental model | Device-to-device metaphor without toy illustrations |
| Stripe Dashboard motion | Soft elevation, 160–220ms transitions, reduced-motion respect |

## 3. Principles

1. **One job per viewport**: send or receive first; QA under details.
2. **Trust before chrome**: no-server / verify / online status as chips, not wall of text.
3. **Touch-first**: 44px+ targets, full-width CTAs on ≤680px.
4. **Accessible**: focus rings, `aria-label`s preserved, contrast on glass.
5. **Performance**: CSS-only motion, no heavy 3D; external stylesheet (no 500-line inline).

## 4. Visual system

- **Canvas**: `#07080c` with soft mesh orbs (violet + cyan, low opacity)
- **Accent**: electric mint `#5ef0c0` (mesh / verified)
- **Secondary**: soft violet `#8b7cff` (brand mark)
- **Type**: Instrument Sans (display) + DM Sans (UI) via Google Fonts
- **Radius**: 20–28px cards; pills 999px
- **Layout**: max 1120px content; bento 1→2 columns

## 5. Surfaces

| Surface | Behavior |
|---|---|
| Topbar | Logo + wordmark + How it works |
| Hero | One line value prop + mesh node motif |
| Send card | Dropzone + create link + QR result |
| Receive card | Code input + progress + download |
| Trust row | 4 compact guarantee chips |
| QA panel | Collapsed developer tools |

## 6. Responsive breakpoints

- ≥900px: 2-col bento  
- ≤899px: stacked cards, simplified hero motif  
- ≤480px: tighter padding, full-width buttons  

## 7. Non-goals

- No redesign of engine APIs  
- No marketing multi-page site  
- No light theme v1 (dark-first; tokens allow later light)
