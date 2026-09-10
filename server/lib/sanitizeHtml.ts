/**
 * Turns an email's HTML into something safe to render.
 *
 * Email HTML is written by whoever sent it, which for an inbox connected to a real mailbox means
 * anyone on the internet. This works from an allowlist: a tag not named here does not survive, and
 * an attribute not named here does not survive. Deny-lists get out of date; allowlists fail closed.
 *
 * Remote images are removed rather than rewritten. A tracking pixel in a message body would tell
 * the sender exactly when a Marine opened their mail, from which network. The reader is told an
 * image was blocked instead.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'a', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
]);

/** Everything inside these is content, not markup, and is dropped whole. */
const VOID_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'title', 'head', 'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea']);

const SELF_CLOSING = new Set(['br', 'hr', 'col']);

const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
};

const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;

export interface SanitizeResult {
  html: string;
  /** True when the original carried an image loaded from somewhere else. Shown to the reader. */
  blockedRemoteImages: boolean;
  /** True when something was dropped that could have run: a script, a handler, a javascript: URL. */
  blockedActiveContent: boolean;
}

const escapeText = (text: string) => text.replace(/&(?!(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseAttributes(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw))) out.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
  return out;
}

export function sanitizeEmailHtml(input: string, limits: { maxBytes?: number } = {}): SanitizeResult {
  const maxBytes = limits.maxBytes ?? 512 * 1024;
  const source = String(input || '').slice(0, maxBytes);
  let out = '';
  let blockedRemoteImages = false;
  let blockedActiveContent = false;
  const open: string[] = [];

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) { out += escapeText(source.slice(i)); break; }
    out += escapeText(source.slice(i, lt));

    // A comment can hide a conditional block that some clients execute, so it never survives.
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const gt = source.indexOf('>', lt);
    if (gt === -1) { out += escapeText(source.slice(lt)); break; }
    const inner = source.slice(lt + 1, gt);
    const closing = inner.startsWith('/');
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(inner);
    if (!nameMatch) { i = gt + 1; continue; }
    const tag = nameMatch[1].toLowerCase();

    if (VOID_CONTENT_TAGS.has(tag)) {
      if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'form') blockedActiveContent = true;
      if (closing) { i = gt + 1; continue; }
      // Skip the element and everything it contains.
      const close = source.toLowerCase().indexOf(`</${tag}`, gt);
      i = close === -1 ? source.length : (source.indexOf('>', close) + 1 || source.length);
      continue;
    }

    if (tag === 'img') {
      if (!closing) {
        const attrs = parseAttributes(inner.slice(nameMatch[0].length));
        const src = attrs.find(([k]) => k === 'src')?.[1] || '';
        // A data: image is inert bytes already in the message; anything fetched is a beacon.
        if (/^data:image\//i.test(src)) {
          const alt = attrs.find(([k]) => k === 'alt')?.[1] || '';
          out += `<img src="${escapeText(src)}" alt="${escapeText(alt)}">`;
        } else {
          blockedRemoteImages = true;
          out += '<span class="blocked-image">[image blocked]</span>';
        }
      }
      i = gt + 1;
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown markup is dropped, but its text stays: an email should still read.
      i = gt + 1;
      continue;
    }

    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at !== -1) { for (let k = open.length - 1; k >= at; k -= 1) out += `</${open[k]}>`; open.length = at; }
      i = gt + 1;
      continue;
    }

    const attrs = parseAttributes(inner.slice(nameMatch[0].length));
    let rendered = `<${tag}`;
    for (const [key, value] of attrs) {
      if (key.startsWith('on')) { blockedActiveContent = true; continue; }
      if (key === 'style' || key === 'srcset' || key === 'background') continue;
      if (!ALLOWED_ATTRIBUTES[tag]?.has(key)) continue;
      if (key === 'href') {
        if (!SAFE_SCHEME.test(value.trim())) { blockedActiveContent = true; continue; }
        // A link out of an email opens in a new context and never carries the referrer back.
        rendered += ` href="${escapeText(value.trim())}" rel="noopener noreferrer nofollow" target="_blank"`;
        continue;
      }
      rendered += ` ${key}="${escapeText(value)}"`;
    }
    if (SELF_CLOSING.has(tag)) { out += `${rendered}>`; i = gt + 1; continue; }
    rendered += '>';
    out += rendered;
    open.push(tag);
    i = gt + 1;
  }

  while (open.length) out += `</${open.pop()}>`;
  return { html: out, blockedRemoteImages, blockedActiveContent };
}

/** A readable plain-text rendering, for search and for a preview line. */
export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    // A block close is a paragraph break; a line break inside one is a single newline.
    .replace(/<\/(p|div|h[1-6]|blockquote|table)>/gi, '\n\n')
    .replace(/<\/(tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
