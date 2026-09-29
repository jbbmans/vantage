# Vantage films

A one-minute ad, an 80-second tour for the public page, and thirteen field-guide chapters. There is no
narration: each film says what it has to say in plain text on screen, over its own music. They are made in
code, from the real application, and published with one command:

```sh
npm run film                     # from the repository root: every film, end to end
npm run film -- ad quick-log     # just these
npm run film -- --draft          # render to film/out only; publish nothing
npm run film -- --reuse-shots    # keep the captured footage; skip the browser
npm run film -- --capture-only   # capture footage and stills, then stop
```

`npm --prefix film install` once first. A full run takes about forty minutes on four cores.

## What happens

| Step | Tool | What it does |
|---|---|---|
| 1. Script | `src/script.ts` | Every film's on-screen text, one card at a time, and its music: key, tempo, chord progression, groove and lead instrument. The one place to change the words. |
| 2. Timeline | `tools/timeline.mjs` | Each card gets the time it takes to read, rounded up to the next half bar of its film's tempo, so every change of card lands on the beat. A scene's `min` gives slow actions room. |
| 3. Capture | `tools/shots.mjs`, `tools/capture.mjs` | The real application in the synthetic demo, driven by Playwright at 2× (2880×1620 frames). Not a screen recording: the recorder acts, lets the page settle, and stamps each frame with the second it belongs to, so the action plays at exactly the written pace. Moves are timed from the cards. The pointer, the camera and the dissolves are drawn from the event log, so they are perfectly smooth. |
| 4. Picture | `src/` (Remotion) | Chapters: a title card, then each card above a large application window with the camera pushing in on what the card is about. The ad and the tour (`src/story/`): designed scenes built from the product's own figures, and the application in a tilted window. |
| 5. Score | `tools/score.mjs` | An original track per film, synthesised: pads, bass, drums, and a piano, bell, electric piano or plucked lead, arranged on the same timeline, with the hits and sound effects on the moments in `src/moments.ts` and the interface's own clicks and keystrokes. Normalised to −14 LUFS (ad and tour) or −16 LUFS (chapters), −1.5 dBTP. |
| 6. Render and publish | `tools/render.mjs` | H.264 1080p30 with AAC, bitrate-capped, fast-start, and a poster frame. Published to `public/videos/films/` and listed in `src/config/films.generated.json`, which `src/config/videos.ts` reads. |

## Requirements

- **Chromium's headless shell** for Remotion (`REMOTION_BROWSER`, default
  `/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`), and Playwright's
  Chromium for the capture.
- **The synthetic demo** on `VANTAGE_DEMO_URL` (default `http://localhost:8798`). `render.mjs` starts
  it, and builds the application first if `dist/` is missing.
- **A fresh accounts-mode instance** on `VANTAGE_FILM_INSTANCE_URL` (default `http://localhost:8799`), for
  the films the demo cannot show: first launch, the sign-in email, and administration (`setup`,
  `governance`, `first-week`). `render.mjs` starts `tools/instance.ts` with an empty database and captures
  `setup` first; nothing else may be listening on that port.

## Changing a film

- **Words:** edit `src/script.ts`. The next run re-times every scene, re-captures the footage to that
  timing, and re-scores.
- **What happens on screen:** `tools/shots.mjs`. `c.card(i)` is when card `i` of a scene appears, and
  `c.dur` is how long the scene lasts.
- **Music:** the `music` entry of each film in `src/script.ts`.
- **Look:** `src/chapters/` and `src/story/`. `npm --prefix film run studio` opens Remotion Studio.

## Honesty rules

Every claim on screen is true of the product as it ships, and every figure on screen is invented: the
synthetic demo, or names and units marked synthetic on the fresh instance. Each film says so on screen.
Nothing is edited into the footage that the application did not do.

## Licences

- **Remotion** is free for individuals and companies of up to three people; larger organisations need
  a company licence (remotion.dev/license).
- **Fonts:** Geist, Inter and JetBrains Mono, under the SIL Open Font License (see `public/fonts/`).
- **Music and sound** are synthesised by `tools/score.mjs`; nothing is sampled.
