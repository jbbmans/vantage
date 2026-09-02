import assert from 'node:assert/strict';
import { attachmentDisposition, cleanFilename, inspectAttachment } from '../server/attachments.js';

const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv'];
const inspect = (body, filename, contentType) => inspectAttachment({
  body, filename, contentType, allowedTypes, maxBytes: 1024 * 1024,
});

assert.equal(cleanFilename('../../counseling\r\n.pdf'), 'counseling.pdf');
assert.equal(inspect(Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'), 'record.pdf', 'application/pdf').ok, true);
assert.equal(inspect(Buffer.from('not a pdf'), 'record.pdf', 'application/pdf').ok, false);
assert.equal(inspect(Buffer.from('%PDF-1.7\n'), 'record.pdf', 'application/pdf').ok, false);
assert.equal(inspect(Buffer.from('%PDF-1.7\n%%EOF'), 'record.pdf.exe', 'application/pdf').ok, false);
assert.equal(inspect(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image.jpg', 'image/jpeg').ok, false);
assert.equal(inspect(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]), 'image.jpg', 'image/jpeg').ok, true);
assert.equal(inspect(Buffer.from([0, 1, 2]), 'record.txt', 'text/plain').ok, false);
assert.equal(inspect(Buffer.from('safe text'), 'record.txt', 'text/plain').ok, true);
assert.match(attachmentDisposition('résumé.pdf'), /^attachment;/);
assert.ok(!attachmentDisposition('bad\r\nname.pdf').includes('\r'));

console.log('  ok    attachment type, name, and disposition checks');
