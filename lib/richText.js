// Lightweight markdown-style formatting for the two free-text Purchase
// Settings fields (default_po_terms, delivery_guidelines) that support
// formatting (2026-10-09) - NOT a contenteditable/HTML editor, deliberately:
// browser-generated contenteditable HTML is inconsistent across browsers and
// hard to parse reliably, whereas a small fixed token vocabulary (applied by
// the Purchase Settings toolbar buttons wrapping the textarea's own
// selection) is trivial to parse the same way every time. Storage stays a
// plain string, so a value saved before this feature existed (no markup
// tokens present) renders identically to before - no migration needed.
//
// Syntax: **bold**, *italic*, ++underline++, a line starting with "- " is a
// bullet-list item, a line starting with "<N>. " is a numbered-list item.
// Contiguous list-marker lines group into one <ul>/<ol>; anything else is
// its own paragraph/line, same as a plain-text block always was.

function escHtml(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Flat (non-nested) inline tokenizer - bold/underline checked before the
// single-star italic token so "**bold**" isn't mis-split into italic runs.
const INLINE_RE = /\*\*([^*]+?)\*\*|\+\+([^+]+?)\+\+|\*([^*]+?)\*/g;

function parseInlineSegments(line) {
  const segments = [];
  let lastIndex = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(line))) {
    if (m.index > lastIndex) segments.push({ text: line.slice(lastIndex, m.index) });
    if (m[1] !== undefined) segments.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) segments.push({ text: m[2], underline: true });
    else if (m[3] !== undefined) segments.push({ text: m[3], italic: true });
    lastIndex = INLINE_RE.lastIndex;
  }
  if (lastIndex < line.length) segments.push({ text: line.slice(lastIndex) });
  if (segments.length === 0) segments.push({ text: '' });
  return segments;
}

function parseBlocks(raw) {
  const lines = String(raw || '').split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const bulletMatch = /^-\s+(.*)$/.exec(line);
    const numberedMatch = /^\d+\.\s+(.*)$/.exec(line);
    if (bulletMatch) {
      if (!current || current.type !== 'ul') { current = { type: 'ul', items: [] }; blocks.push(current); }
      current.items.push(bulletMatch[1]);
    } else if (numberedMatch) {
      if (!current || current.type !== 'ol') { current = { type: 'ol', items: [] }; blocks.push(current); }
      current.items.push(numberedMatch[1]);
    } else {
      current = { type: 'p', text: line };
      blocks.push(current);
    }
  }
  return blocks;
}

function inlineToHtml(line) {
  return parseInlineSegments(line).map(seg => {
    let t = escHtml(seg.text);
    if (seg.bold) t = `<b>${t}</b>`;
    if (seg.italic) t = `<i>${t}</i>`;
    if (seg.underline) t = `<u>${t}</u>`;
    return t;
  }).join('');
}

// For lib/poPdf.js - returns real HTML, safe to embed unescaped (all literal
// text content is escHtml()'d above; only the fixed b/i/u/ul/ol/li tags this
// module itself emits are left unescaped).
function richTextToHtml(raw) {
  return parseBlocks(raw).map(b => {
    if (b.type === 'ul') return `<ul>${b.items.map(i => `<li>${inlineToHtml(i)}</li>`).join('')}</ul>`;
    if (b.type === 'ol') return `<ol>${b.items.map(i => `<li>${inlineToHtml(i)}</li>`).join('')}</ol>`;
    return `<div>${inlineToHtml(b.text)}</div>`;
  }).join('');
}

const ORDERED_LIST_NUMBERING_REFERENCE = 'rich-text-ordered-list';

// For lib/poDocx.js - takes the caller's own `Paragraph`/`TextRun` classes
// (and `UnderlineType`) rather than importing `docx` here, so this module
// has no dependency on that package and stays usable from lib/poPdf.js too.
function richTextToDocxParagraphs(raw, { Paragraph, TextRun, UnderlineType }) {
  const segmentsToRuns = (line) => parseInlineSegments(line).map(s => new TextRun({
    text: s.text,
    bold: !!s.bold,
    italics: !!s.italic,
    underline: s.underline ? { type: UnderlineType.SINGLE } : undefined,
  }));
  const paragraphs = [];
  parseBlocks(raw).forEach(b => {
    if (b.type === 'ul') {
      b.items.forEach(item => paragraphs.push(new Paragraph({ bullet: { level: 0 }, children: segmentsToRuns(item) })));
    } else if (b.type === 'ol') {
      b.items.forEach(item => paragraphs.push(new Paragraph({ numbering: { reference: ORDERED_LIST_NUMBERING_REFERENCE, level: 0 }, children: segmentsToRuns(item) })));
    } else {
      paragraphs.push(new Paragraph({ children: segmentsToRuns(b.text) }));
    }
  });
  return paragraphs;
}

module.exports = { richTextToHtml, richTextToDocxParagraphs, ORDERED_LIST_NUMBERING_REFERENCE };
