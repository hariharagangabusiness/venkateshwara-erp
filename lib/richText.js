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
// Syntax: **bold**, *italic*, ++underline++, [color=NAME]...[/color] (NAME
// one of COLOR_HEX's keys), [size=NAME]...[/size] (NAME one of
// SIZE_PX/SIZE_HALFPT's keys) - all five nest/combine freely (e.g.
// "**[color=red]urgent[/color]**" is bold AND red), since the toolbar
// buttons just wrap whatever's currently selected, which may already carry
// other tokens. A line starting with "- " is a bullet-list item, a line
// starting with "<N>. " is a numbered-list item; contiguous list-marker
// lines group into one <ul>/<ol>, anything else is its own paragraph/line.

function escHtml(s) {
  return (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fixed palette (2026-10-09, color/size follow-up) - deliberately a small
// closed set rather than a free color picker/arbitrary point size, so the
// printed PO never ends up with an inconsistent, accidental-looking mix of
// colors/sizes. Hex values have no leading '#' (that's added only where
// CSS needs it - docx's TextRun `color` option takes a bare hex string).
const COLOR_HEX = { red: 'C0392B', blue: '2563EB', green: '15803D', orange: 'D97706' };
// CSS px (matches .terms's own 11px base font-size in lib/poPdf.js) and
// docx half-points (docx's TextRun `size` option is in half-points, so 9pt
// = 18) for the same three named sizes - 'normal' intentionally renders no
// override in either format, inheriting whatever the surrounding text uses.
const SIZE_PX = { small: 9, large: 13 };
const SIZE_HALFPT = { small: 16, large: 22 };

// Recursive-descent (not regex) inline parser - needed once tokens can
// nest/combine (a bold run can contain a colored run, a colored run can
// contain a bold+underlined run, etc.), which a single flat regex pass
// can't represent. `attrs` carries every ancestor wrapper's formatting down
// to each leaf plain-text segment it eventually flushes.
function parseInline(text, attrs) {
  attrs = attrs || {};
  const segments = [];
  let i = 0;
  const n = text.length;
  let buf = '';
  const flush = () => { if (buf) { segments.push(Object.assign({ text: buf }, attrs)); buf = ''; } };
  while (i < n) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end === -1) { buf += text[i]; i++; continue; }
      flush();
      segments.push(...parseInline(text.slice(i + 2, end), Object.assign({}, attrs, { bold: true })));
      i = end + 2;
    } else if (text.startsWith('++', i)) {
      const end = text.indexOf('++', i + 2);
      if (end === -1) { buf += text[i]; i++; continue; }
      flush();
      segments.push(...parseInline(text.slice(i + 2, end), Object.assign({}, attrs, { underline: true })));
      i = end + 2;
    } else if (text.startsWith('[color=', i)) {
      const close = text.indexOf(']', i);
      const endTag = close !== -1 ? text.indexOf('[/color]', close) : -1;
      if (close === -1 || endTag === -1) { buf += text[i]; i++; continue; }
      const colorName = text.slice(i + 7, close);
      flush();
      const nextAttrs = Object.assign({}, attrs);
      if (COLOR_HEX[colorName]) nextAttrs.color = colorName;
      segments.push(...parseInline(text.slice(close + 1, endTag), nextAttrs));
      i = endTag + '[/color]'.length;
    } else if (text.startsWith('[size=', i)) {
      const close = text.indexOf(']', i);
      const endTag = close !== -1 ? text.indexOf('[/size]', close) : -1;
      if (close === -1 || endTag === -1) { buf += text[i]; i++; continue; }
      const sizeName = text.slice(i + 6, close);
      flush();
      const nextAttrs = Object.assign({}, attrs);
      if (SIZE_PX[sizeName]) nextAttrs.size = sizeName;
      segments.push(...parseInline(text.slice(close + 1, endTag), nextAttrs));
      i = endTag + '[/size]'.length;
    } else if (text[i] === '*') {
      const end = text.indexOf('*', i + 1);
      if (end === -1) { buf += text[i]; i++; continue; }
      flush();
      segments.push(...parseInline(text.slice(i + 1, end), Object.assign({}, attrs, { italic: true })));
      i = end + 1;
    } else {
      buf += text[i]; i++;
    }
  }
  flush();
  if (segments.length === 0) segments.push(Object.assign({ text: '' }, attrs));
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
  return parseInline(line).map(seg => {
    let t = escHtml(seg.text);
    if (seg.bold) t = `<b>${t}</b>`;
    if (seg.italic) t = `<i>${t}</i>`;
    if (seg.underline) t = `<u>${t}</u>`;
    const styles = [];
    if (seg.color && COLOR_HEX[seg.color]) styles.push(`color:#${COLOR_HEX[seg.color]}`);
    if (seg.size && SIZE_PX[seg.size]) styles.push(`font-size:${SIZE_PX[seg.size]}px`);
    if (styles.length) t = `<span style="${styles.join(';')}">${t}</span>`;
    return t;
  }).join('');
}

// For lib/poPdf.js - returns real HTML, safe to embed unescaped (all literal
// text content is escHtml()'d above; only the fixed b/i/u/span/ul/ol/li
// tags this module itself emits are left unescaped).
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
  const segmentsToRuns = (line) => parseInline(line).map(s => new TextRun({
    text: s.text,
    bold: !!s.bold,
    italics: !!s.italic,
    underline: s.underline ? { type: UnderlineType.SINGLE } : undefined,
    color: s.color && COLOR_HEX[s.color] ? COLOR_HEX[s.color] : undefined,
    size: s.size && SIZE_HALFPT[s.size] ? SIZE_HALFPT[s.size] : undefined,
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

module.exports = { richTextToHtml, richTextToDocxParagraphs, ORDERED_LIST_NUMBERING_REFERENCE, COLOR_HEX, SIZE_PX };
