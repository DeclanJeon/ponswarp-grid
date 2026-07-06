# Design

## Source of truth

- Status: Draft
- Last refreshed: 2026-07-06
- Primary product surfaces:
  - Public web app at `https://grid.ponslink.com/`
  - Two public user actions only: **Send file** and **Receive file**
  - Operator/QA controls must not be visible in the default public interface
- Evidence reviewed:
  - `apps/demo/src/main.tsx` — current React demo UI, share/get states, QR/link flow, progress, hidden developer controls
  - `apps/demo/src/web-product.ts` — share-code/link helpers
  - `docs/15-grid-user-guide.md` — current user-facing sender/receiver/CLI guidance
  - `docs/18-external-network-qa-playbook.md` — external network QA and readiness blockers
  - Existing visual evidence under `artifacts/*.png` — current demos show functional but engineering-heavy QA/product states

## Brand

- Personality:
  - Calm, direct, secure, modern, non-technical.
  - The product should feel like AirDrop for links: simple enough for a non-technical user, trustworthy enough for private files.
- Trust signals:
  - “No server upload” explained in plain language.
  - “Keep this tab open” shown only when relevant.
  - Transfer verification shown as a friendly state, not as cryptographic jargon.
  - Clear sender/receiver device presence.
- Avoid:
  - Exposing WebRTC, ICE, TURN, pieces, hashes, sessions, peer IDs, provider counts, coordinator status, or QA controls in the primary UI.
  - Debug logs, implementation labels, and protocol names in public copy.
  - “Blockchain / cyber / hacker” visual clichés.
  - Dense dashboards.

## Product goals

- Goals:
  - Let a user send a file in one obvious flow.
  - Let a receiver paste/open a link and receive a file in one obvious flow.
  - Make direct device-to-device transfer understandable without technical setup.
  - Preserve safety: sender knows the tab must stay open; receiver knows what file is incoming.
- Non-goals:
  - Public UI is not a diagnostics console.
  - Public UI is not a network matrix/QA surface.
  - Public UI is not a CLI education page, except as a contextual large-file fallback.
- Success signals:
  - First-time user can identify “Send” vs “Receive” within 3 seconds.
  - Sender can create a link/QR without seeing protocol controls.
  - Receiver can confirm file name/size and progress without reading docs.
  - Error states say what to do next.

## Personas and jobs

- Primary personas:
  - Casual sender: wants to quickly send one file to another person/device.
  - Casual receiver: has a link/code and wants the file safely.
  - Power user: may need CLI for very large or unreliable transfers, but this path is secondary.
- User jobs:
  - “Send this file to someone nearby or remote without uploading it to a storage service.”
  - “Receive this file from a link and know when it is safe to save.”
  - “Recover from a weak network without understanding WebRTC.”
- Key contexts of use:
  - Desktop-to-phone.
  - Phone-to-desktop.
  - Different Wi-Fi/LTE networks.
  - Office/firewall networks where fallback may be needed.

## Information architecture

- Primary navigation:
  - No top-level navigation needed for MVP.
  - Landing page contains two large action cards: **Send file** and **Receive file**.
- Core routes/screens:
  - `/` — default two-action landing.
  - `#/get/<code>` — receive flow prefilled from link.
  - Future optional: `/help` or modal help, not a visible nav requirement.
- Content hierarchy:
  1. Product promise: “Send files directly.”
  2. Two action cards: Send / Receive.
  3. Inline transfer state.
  4. Small trust strip: no upload, encrypted connection, verified download, sender stays online.
  5. Contextual fallback only when needed: “For very large files, use CLI.”

## Design principles

- Principle 1: Two doors only.
  - Users see **Send file** and **Receive file**. Everything else is progressive disclosure or hidden.
- Principle 2: Technical truth, human words.
  - “Direct device transfer” instead of “WebRTC peer connection.”
  - “Verified” instead of “SHA-256 piece hash verified.”
- Principle 3: Motion clarifies state.
  - Use motion to show connection, progress, and completion. Do not use ambient motion that competes with the task.
- Principle 4: Default to reassurance, not telemetry.
  - Show file name, size, online status, expiry, progress, and completion. Hide logs and network internals.
- Tradeoffs:
  - Simplicity wins over showing capability. Advanced details belong in developer/QA mode, not public mode.
  - Large-file caveats should appear only when the selected file size or failed browser capability makes them relevant.

## Visual language

- Color:
  - Base: deep navy / slate for trust and contrast.
  - Accent: electric blue for primary action and active transfer.
  - Secondary accent: mint/cyan glow for connection success.
  - Warning: warm amber for “sender must stay online” or “network fallback.”
  - Error: red only for actionable failure states.
- Typography:
  - Modern sans-serif, high x-height, friendly but not playful.
  - Large hero headline, short supporting copy.
  - Button labels use verbs: “Choose file”, “Create link”, “Find file”, “Save file”.
- Spacing/layout rhythm:
  - Generous whitespace.
  - Two-card desktop layout; single-column mobile layout.
  - Each action card has one primary button at a time.
- Shape/radius/elevation:
  - Soft large-radius cards, subtle glass/elevation.
  - Drop zones feel tactile and safe.
  - Progress surface is a rounded capsule or timeline, not a terminal log.
- Motion:
  - Background: subtle motion-graphic field of particles/threads implying device-to-device transfer.
  - Send state: file tile lifts into a glowing link/QR capsule.
  - Receive state: code resolves into file preview, then progress ring/bar fills.
  - Completion: calm checkmark and save affordance.
  - Respect `prefers-reduced-motion` by freezing decorative animation and keeping essential progress changes.
- Imagery/iconography:
  - Abstract connected devices, soft beams, file capsule, QR/link token.
  - Avoid literal server racks as the primary image because the value proposition is not server upload.

## Components

- Existing components to reuse:
  - Current `WebShareState` and `WebGetState` state model in `apps/demo/src/main.tsx`.
  - Existing QR generation and receive link parsing.
  - Existing progress, completion, and download URL behavior.
- New/changed components:
  - `ActionChoiceHero`: hero plus two user-only actions.
  - `SendCard`: file drop/choose, selected file summary, create link, share result.
  - `ReceiveCard`: paste code/link, file confirmation, progress, save.
  - `TrustStrip`: no upload, verified transfer, private link, sender online.
  - `TransferStatus`: user-friendly states mapped from internal states.
  - `AdvancedDiagnosticsDisclosure`: hidden behind explicit “Advanced details” only outside public default.
- Variants and states:
  - Send: idle, file selected, creating link, sharing, error.
  - Receive: idle, resolving, ready, downloading, complete, error.
  - Network: connecting, slow network, sender offline, relay fallback, verified.
- Token/component ownership:
  - Keep styling repo-local until a reusable design system is justified.
  - Do not introduce a component library dependency just for the MVP interface.

## Accessibility

- Target standard:
  - WCAG 2.2 AA for public flows.
- Keyboard/focus behavior:
  - File choose/dropzone is keyboard reachable.
  - Buttons have visible focus rings.
  - Paste code input is first focus target on receive links.
  - QR is supplementary; link/code text remains selectable/copyable.
- Contrast/readability:
  - Body text minimum 16px.
  - Do not rely on blue glow alone for state.
- Screen-reader semantics:
  - Send and Receive are separate labelled regions.
  - Progress uses semantic `<progress>` plus text equivalent.
  - Completion and error states use `role="status"` / `role="alert"`.
- Reduced motion and sensory considerations:
  - Decorative motion disabled under reduced motion.
  - Essential progress updates remain visible as static value changes.

## Responsive behavior

- Supported breakpoints/devices:
  - Mobile 360px+.
  - Tablet.
  - Desktop.
- Layout adaptations:
  - Desktop: two cards side by side with hero/trust strip.
  - Mobile: Send and Receive stack; receive-link route scrolls directly to Receive.
  - QR share result stacks below copyable link on narrow screens.
- Touch/hover differences:
  - Dropzone supports click/tap; drag-and-drop is enhancement only.
  - Copy/share buttons use large touch targets.

## Interaction states

- Loading:
  - “Creating secure link…” for sender.
  - “Looking for sender…” for receiver.
- Empty:
  - Send card: “Choose a file to create a private link.”
  - Receive card: “Paste a PonsWarp link or code.”
- Error:
  - Missing code: “Paste the full link or code.”
  - Sender offline: “Ask the sender to reopen the share tab.”
  - Network blocked: “This network is blocking direct transfer. Try another network or use the CLI.”
  - Expired/revoked: “This link is no longer active. Ask for a new one.”
- Success:
  - Sender: “Link ready. Keep this tab open.”
  - Receiver: “Verified. Save file.”
- Disabled:
  - Buttons explain why when disabled: no file selected, resolving, or transfer in progress.
- Offline/slow network:
  - Show “Still trying…” and do not expose retries unless expanded.
  - Offer CLI fallback for very large files or repeated stalls.

## Content voice

- Tone:
  - Plain, reassuring, concise.
- Terminology:
  - Use: send, receive, link, code, file, device, verified, direct transfer.
  - Avoid in public UI: WebRTC, ICE, TURN, peer, candidate, manifest, piece, hash, coordinator.
- Microcopy rules:
  - Every message should answer one of: what happened, why it matters, what to do next.
  - Prefer “Keep this tab open” over “Maintain provider availability.”
  - Prefer “No server upload” over “metadata-only coordinator.”

## Implementation constraints

- Framework/styling system:
  - React/Vite demo app currently uses inline styles in `apps/demo/src/main.tsx`.
  - Future implementation may extract components and CSS variables, but should avoid dependency churn.
- Design-token constraints:
  - Use CSS variables if the visual redesign is implemented.
  - Keep motion and color tokens centralized.
- Performance constraints:
  - Decorative animation must be CSS/SVG/canvas-light; no large animation bundle for first load.
  - File transfer UI must not allocate large file buffers for visual effects.
- Compatibility constraints:
  - Browser transfer depends on secure context for WebCrypto.
  - Large-file browser limitations must trigger user-friendly CLI fallback.
- Test/screenshot expectations:
  - Unit/UI tests should cover send/receive states, error copy, and hidden developer controls.
  - Visual evidence should include desktop and mobile states: idle, link ready, receiving, complete.

## Concept UI prompt

Use this prompt for the first visual reference image:

> Design a premium motion-graphics web landing interface for PonsWarp Grid, a direct device-to-device file transfer web app. The interface must show only two primary user actions: “Send file” and “Receive file”. The visual style is calm, futuristic, trustworthy, and extremely approachable for non-technical users. Create a spacious desktop web screen with a deep navy-to-soft-blue gradient background, subtle animated-looking particle trails connecting two abstract devices, glassmorphism cards with large rounded corners, a tactile file drop area, a paste-code receive field, a QR/link preview, friendly transfer progress, and a compact trust strip reading “No server upload”, “Verified transfer”, “Private link”, “Keep sender online”. Hide all developer, WebRTC, ICE, TURN, peer, session, and debug controls. Use clear readable typography, large buttons, accessible contrast, and a refined motion-graphic SaaS aesthetic. The UI should feel as simple as AirDrop plus a private link. Render as a polished product design mockup, 16:9, sharp, legible, correctly spelled short UI text.

## Open questions

- [ ] Should the public brand name be “PonsWarp”, “PonsWarp Grid”, or a shorter transfer-specific name?
- [ ] Should CLI fallback be shown only after file-size/network conditions, or as a small persistent link?
- [ ] Should mobile sender/receiver flows use native share-sheet integration in the first public redesign?
- [ ] What exact file-size threshold should trigger “Use CLI for best reliability” copy?
