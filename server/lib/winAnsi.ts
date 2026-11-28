/**
 * What the standard PDF fonts draw (ADR-0020): WinAnsi, which is Latin-1 and the punctuation Windows adds to it. Any
 * other character prints as '?', so a text that must read the same in every file is held to this set.
 */
export const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–\u2014˜™š›œžŸ');

/** Whether the standard PDF fonts draw a character as itself; a line break is drawn as one. */
export const pdfDraws = (ch: string) => ch === '\n' || /^[\x20-\x7e\xa0-\xff]$/u.test(ch) || WIN_ANSI_EXTRA.has(ch);
