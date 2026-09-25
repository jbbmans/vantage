export function drawMark(doc: PDFKit.PDFDocument, x: number, y: number, size: number) {
  const s = size / 120;
  const path = (points: string, color: string) => {
    const translated = points.replace(/([ML])\s*([0-9.]+)\s+([0-9.]+)/g, (_m, cmd, px, py) => `${cmd} ${x + Number(px) * s} ${y + Number(py) * s}`);
    doc.path(translated).fill(color);
  };

  doc.save();
  path('M 7 34 L 35 34 L 60 77 L 85 34 L 113 34 L 60 118 L 7 34 Z', '#0B2D5B');
  path('M 60 2 L 90 32 L 74 48 L 60 34 L 46 48 L 30 32 L 60 2 Z', '#14B8A6');
  path('M 60 33 L 82 58 L 60 90 L 38 58 L 60 33 Z', '#FFFFFF');
  path('M 60 43 L 72 58 L 60 78 L 48 58 L 60 43 Z', '#2563EB');
  doc.restore();
}
