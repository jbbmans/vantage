/** Capture/score outputs are generated during rendering, not checked into source. These are their build contracts;
 * they provide types before capture, and do not provide files or bypass the renderer's missing-asset failures. */
declare module '*generated/stills.json' {
  const stills: Record<string, [number, number]>;
  export default stills;
}
declare module '*generated/media.json' {
  const media: { mixes: Record<string, { file: string }> };
  export default media;
}
declare module '*generated/takes.json' {
  const takes: Record<string, unknown>;
  export default takes;
}
