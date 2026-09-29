/**
 * When things happen inside the ad's and the tour's designed scenes, in seconds from the start of the scene.
 * The picture draws them and the score plays them from these same numbers, so a stamp lands on its sound.
 */
export const MOMENTS = {
  /** The count rolling up to 30. */
  counter: { at: 0.35, dur: 0.9 },
  /** The funding card arriving, and the "caught" stamp landing on it. */
  gap: { card: 0.15, stamp: 0.58 },
  /** Six months passing: one month per beat of this many. */
  months: { at: 0.4, step: 0.32, count: 6 },
  /** The three places the work ends up, one after another. */
  scatter: { first: 0.5, step: 0.8 },
  /** The mark lands on the scene's first frame. */
  logo: { at: 0 },
  /** History entries arriving, and the seal. */
  history: { first: 0.3, step: 0.36, seal: 0.72 },
  /** Report text typing, and its citations landing. */
  report: { type: 0.3, cite: 0.62 },
} as const;
