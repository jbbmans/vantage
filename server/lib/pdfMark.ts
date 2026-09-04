/** The Vantage mark drawn with PDF primitives, so reports carry the brand without embedding an image. Mirrors public/mark.svg. */
export function drawMark(doc: PDFKit.PDFDocument, x: number, y: number, size: number) {
  const s = size / 64;
  doc.save();
  doc.roundedRect(x + 2 * s, y + 2 * s, 60 * s, 60 * s, 15 * s).fill('#0f172a');
  doc.lineCap('round').lineWidth(7.5 * s);
  doc.moveTo(x + 16 * s, y + 21 * s).lineTo(x + 31.5 * s, y + 48 * s).stroke('#c4262e');
  doc.moveTo(x + 31.5 * s, y + 48 * s).lineTo(x + 50 * s, y + 14 * s).stroke('#d4a63a');
  doc.circle(x + 50 * s, y + 14 * s, 4.6 * s).fill('#f6e7b0');
  doc.circle(x + 50 * s, y + 14 * s, 2.2 * s).fill('#0b1220');
  doc.restore();
}
