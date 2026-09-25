import { continueRender, delayRender, staticFile } from 'remotion';

let started = false;
export function loadFonts() {
  if (started || typeof document === 'undefined') return;
  started = true;
  const handle = delayRender('fonts');
  const faces = [
    new FontFace('Geist', `url(${staticFile('fonts/geist-normal.woff2')}) format('woff2')`, { weight: '100 900' }),
    new FontFace('Inter', `url(${staticFile('fonts/inter-normal.woff2')}) format('woff2')`, { weight: '100 900' }),
    new FontFace('JetBrains Mono', `url(${staticFile('fonts/jetbrains-normal.woff2')}) format('woff2')`, { weight: '100 800' }),
  ];
  Promise.all(faces.map((f) => f.load().then((loaded) => document.fonts.add(loaded))))
    .then(() => continueRender(handle))
    .catch((e) => { console.error(e); continueRender(handle); });
}
