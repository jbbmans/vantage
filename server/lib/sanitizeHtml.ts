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
  blockedRemoteImages: boolean;
  blockedActiveContent: boolean;
}

const escapeText = (text: string) => text.replace(/&(?!(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value: string) => escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
  // How many of each tag are open, so a closing tag with nothing to close costs nothing, and the lowercase copy
  // the void-content search reads: made once, not once per tag (which made a long message quadratic).
  const depth = new Map<string, number>();
  const lower = source.toLowerCase();

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) { out += escapeText(source.slice(i)); break; }
    out += escapeText(source.slice(i, lt));

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
      const close = lower.indexOf(`</${tag}`, gt);
      i = close === -1 ? source.length : (source.indexOf('>', close) + 1 || source.length);
      continue;
    }

    if (tag === 'img') {
      if (!closing) {
        const attrs = parseAttributes(inner.slice(nameMatch[0].length));
        const src = attrs.find(([k]) => k === 'src')?.[1] || '';
        if (/^data:image\//i.test(src)) {
          const alt = attrs.find(([k]) => k === 'alt')?.[1] || '';
          out += `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`;
        } else {
          blockedRemoteImages = true;
          out += '<span class="blocked-image">[image blocked]</span>';
        }
      }
      i = gt + 1;
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      i = gt + 1;
      continue;
    }

    if (closing) {
      const at = depth.get(tag) ? open.lastIndexOf(tag) : -1;
      if (at !== -1) {
        for (let k = open.length - 1; k >= at; k -= 1) { out += `</${open[k]}>`; depth.set(open[k], (depth.get(open[k]) || 1) - 1); }
        open.length = at;
      }
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
        rendered += ` href="${escapeAttr(value.trim())}" rel="noopener noreferrer nofollow" target="_blank"`;
        continue;
      }
      rendered += ` ${key}="${escapeAttr(value)}"`;
    }
    if (SELF_CLOSING.has(tag)) { out += `${rendered}>`; i = gt + 1; continue; }
    // Past any depth a real message reaches, further nesting is dropped rather than tracked.
    if (open.length >= MAX_DEPTH) { i = gt + 1; continue; }
    rendered += '>';
    out += rendered;
    open.push(tag);
    depth.set(tag, (depth.get(tag) || 0) + 1);
    i = gt + 1;
  }

  while (open.length) out += `</${open.pop()}>`;
  return { html: out, blockedRemoteImages, blockedActiveContent };
}

const MAX_DEPTH = 256;
const BREAK_AFTER = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table']);

/**
 * A readable plain-text rendering, for search and for a preview line. One pass forward: the patterns this replaces
 * searched to the end of the text from every unclosed "<script" or "<", which made a crafted message quadratic.
 */
export function htmlToText(html: string, limits: { maxBytes?: number } = {}): string {
  const source = String(html || '').slice(0, limits.maxBytes ?? 512 * 1024);
  const lower = source.toLowerCase();
  let out = '';
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) { out += source.slice(i); break; }
    out += source.slice(i, lt);
    const gt = source.indexOf('>', lt + 1);
    if (gt === -1) { out += source.slice(lt); break; }
    const name = /^(\/?)\s*([a-z][a-z0-9]*)/.exec(lower.slice(lt + 1, Math.min(gt, lt + 40)));
    const tag = name?.[2] || '';
    const closing = name?.[1] === '/';
    i = gt + 1;
    if (!closing && (tag === 'script' || tag === 'style')) {
      const close = lower.indexOf(`</${tag}>`, gt);
      if (close !== -1) i = close + tag.length + 3;
      out += ' ';
    } else if (tag === 'br' && !closing) out += '\n';
    else if (closing && BREAK_AFTER.has(tag)) out += '\n\n';
    else if (closing && (tag === 'tr' || tag === 'li')) out += '\n';
    else out += ' ';
  }
  return out
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
