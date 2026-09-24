# Vantage films

The product films: a 90-second hero film for the public page, and six narrated chapters for the field
guide. They are made in code, from the real application, and published with one command:

```sh
npm run film                     # from the repository root: every film, end to end
npm run film -- hero queue       # just these
npm run film -- --draft          # render to film/out only; publish nothing
npm run film -- --reuse-shots    # keep the captured footage; skip the browser
```

`npm --prefix film install` once first. A full run takes about half an hour on four cores.

## What happens

| Step | Tool | What it does |
|---|---|---|
| 1. Script | `src/script.ts` | Every line of narration, every scene, and where the music lifts or lands. The one place to change the words. |
| 2. Voice | `tools/voice.mjs` | Each line through ElevenLabs (Brian, `eleven_multilingual_v2`), with the neighbouring lines as context so the delivery runs on. Cached in `assets/vo/` by a hash of the text and voice settings, and committed: a line is paid for once, and only a changed line is voiced again. |
| 3. Timeline | `tools/timeline.mjs` | Scene and word timings from the recorded voice, and WebVTT captions from the same words. Before a line is voiced it is timed from an estimate and marked, so the cut can be worked on. |
| 4. Capture | `tools/shots.mjs`, `tools/capture.mjs` | The real application in the synthetic demo, driven by Playwright at 2× (2880×1620 frames). Not a screen recording: the recorder acts, lets the page settle, and stamps each frame with the second it belongs to, so the action plays at exactly the written pace. Moves are timed from the narration's words. The pointer, the camera and the dissolves are drawn from the event log, so they are perfectly smooth. |
| 5. Picture | `src/` (Remotion) | The hero is motion design around real stills; the chapters are the captured footage in a glass plate with the camera pushing in on what the voice is talking about. |
| 6. Score | `tools/score.mjs` | An original score and sound design, synthesised: pads, a felt piano, arpeggios, sub, a kick, impacts, risers, whooshes and the interface's clicks and keystrokes, arranged on the same timeline. The music ducks under the voice; the mix is normalised to −14 LUFS, −1.5 dBTP. |
| 7. Render and publish | `tools/render.mjs` | H.264 1080p30 with AAC, bitrate-capped, fast-start; a poster frame; the captions. Published to `public/videos/films/` and listed in `src/config/films.generated.json`, which `src/config/videos.ts` reads. |

**A film is published only when every line of its narration is a recorded voice.** Until then it
renders as a draft in `film/out/`.

## Requirements

- **`ELEVENLABS_API_KEY`**, for step 2. In a Claude Code cloud environment, add it under the
  environment's settings (environment variables); a new session picks it up. Never paste it into a
  chat or commit it. Without it, the cached voice is used, and lines not yet voiced stay estimated.
- **Chromium's headless shell** for Remotion (`REMOTION_BROWSER`, default
  `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`), and Playwright's
  Chromium for the capture.
- **The synthetic demo** on `VANTAGE_DEMO_URL` (default `http://localhost:8798`). `render.mjs` starts
  it, and builds the application first if `dist/` is missing.

## Changing a film

- **Words:** edit `src/script.ts`. The next run voices only what changed, re-times every scene from
  the new recording, re-captures the footage to that timing, and re-scores.
- **What happens on screen:** `tools/shots.mjs`. `at(scene, 'word')` is when the narrator says that
  word, so moves stay in sync with any recording.
- **Look:** `src/hero/` and `src/chapters/`. `npm --prefix film run studio` opens Remotion Studio.

## Honesty rules

Every claim in a script is true of the product as it ships, and every figure on screen is from the
synthetic demo, which each film says on screen. Nothing is edited into the footage that the
application did not do.

## Licences

- **Remotion** is free for individuals and companies of up to three people; larger organisations need
  a company licence (remotion.dev/license).
- **ElevenLabs** voice output may be used commercially on a paid plan; check the account's plan
  before publishing.
- **Fonts:** Geist, Inter and JetBrains Mono, under the SIL Open Font License (see `public/fonts/`).
- **Music and sound** are synthesised by `tools/score.mjs`; nothing is sampled.
