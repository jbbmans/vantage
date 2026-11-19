import { MARK_FILLS, MARK_PATHS } from '../../shared/brand.ts';

export function drawMark(doc: PDFKit.PDFDocument, x: number, y: number, size: number) {
  doc.save().translate(x, y).scale(size / 120);
  for (const part of Object.keys(MARK_PATHS) as Array<keyof typeof MARK_PATHS>) {
    doc.path(MARK_PATHS[part]).fill(MARK_FILLS.primary[part]);
  }
  doc.restore();
}
