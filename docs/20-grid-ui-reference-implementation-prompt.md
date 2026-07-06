# Grid UI Reference Implementation Prompt

Status: Active implementation prompt
Last updated: 2026-07-06

## Approved visual reference

Use this image as the visual source of truth:

```text
artifacts/grid-public-ui-concept.webp
```

## Task prompt

Implement the PonsWarp Grid public web UI so it visually reproduces `artifacts/grid-public-ui-concept.webp` at a 1672×941 / 16:9 desktop viewport while preserving existing send/receive behavior.

### Visual requirements

- Dark navy-to-blue gradient full-screen background.
- Top navigation with PonsWarp Grid brand on the left and a small “How it works” pill on the right.
- Centered hero:
  - `Send files directly`
  - `Direct device-to-device. Fast, private, simple.`
- Abstract sender laptop and receiver phone silhouettes behind the cards.
- Glowing transfer beam/particle trail across the hero center.
- Floating file capsule centered on the beam:
  - file icon
  - `Report.pdf`
  - `2.4 GB`
  - small shield badge
- Two large glassmorphism cards side-by-side:
  - left card: `Send file`
  - right card: `Receive file`
- Send card:
  - circular upward-arrow icon
  - subtitle `Share any file directly to another device.`
  - dashed rounded drop zone
  - upload cloud icon
  - text `Drag & drop your file here`, `or`, and primary `Choose file` button
- Receive card:
  - circular downward-arrow icon
  - subtitle `Enter the link or code from the sender.`
  - input placeholder `Paste link or code`
  - arrow submit button on the right
  - divider with `or`
  - QR scan row
- Bottom trust strip with four items:
  - `No server upload` / `Files stay between devices`
  - `Verified` / `End-to-end verified link`
  - `Private link` / `Only the right device can receive`
  - `Sender online` / `Transfer happens in real time`

### Interaction requirements

- Keep the existing file input behavior.
- Keep existing share link creation.
- Keep existing receive input resolution.
- Keep existing receive/download states.
- Keep developer and QA controls accessible, but not visible in the default public view. Put them behind an explicit low-contrast disclosure below the main product UI.
- Do not expose WebRTC, ICE, TURN, peer ID, session ID, piece count, hash details, or transport logs in the default public UI.

### Implementation constraints

- Use the existing React/Vite app in `apps/demo/src/main.tsx`.
- Do not add dependencies.
- Prefer repo-local CSS/classes or inline styles consistent with the current file.
- Preserve test IDs used by existing tests:
  - `share-result`
  - `receive-ready`
  - `signaled-receive-status`
- Ensure responsive fallback: cards stack on narrow screens.

### QA requirements

- Capture a screenshot of the implemented `/` page at 1672×941.
- Compare against `artifacts/grid-public-ui-concept.webp` using Visual Verdict.
- Pass threshold: score ≥ 90.
- If score < 90, fix concrete layout/color/spacing/copy mismatches and rerun screenshot QA.
- Run targeted tests and build before final handoff.
