// A fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written from scratch from the kit's README and the reference's behaviour:
// same front matter, template dialect, Markdown subset, slug rule and report,
// byte for byte. Speed comes from bulk string work instead of per-character
// calls, one-pass scanners instead of regexes on hot paths, a template
// interpreter that renders into one shared output array, and no token objects.

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = Object.hasOwn;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(d) {
  return `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
}

// ------------------------------------------------------------------ escaping

const ESC_TEST = /[&<>"']/;

/** `s` with & < > " ' escaped; the input itself when it holds none of them. */
function escStr(s) {
  if (!ESC_TEST.test(s)) return s;
  let out = '';
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (run < i) out += s.slice(run, i);
    out += rep;
    run = i + 1;
  }
  if (run < s.length) out += s.slice(run);
  return out;
}

// ---------------------------------------------------------------------- slugs

function finishSlug(out) {
  out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** The slow slug path: NFKD, combining marks dropped, code point by code point. */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return finishSlug(out);
}

/** The slug of `text`; an ASCII fast path, the full rule past any non-ASCII. */
function slugify(text) {
  let out = '';
  let gap = false;
  let i = 0;
  const n = text.length;
  for (; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) return slugifySlow(text);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  return finishSlug(out);
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// --------------------------------------------------------------- front matter

const FM_KEY_SET = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A line of only spaces and tabs (or empty). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with trailing spaces and tabs dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A string value: quoted (only \" and \\ escapes) or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERR };
      let y = 0;
      let m = 0;
      let d = 0;
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: DATE_ERR };
        if (i < 4) y = y * 10 + (c - 48);
        else if (i < 7) m = m * 10 + (c - 48);
        else d = d * 10 + (c - 48);
      }
      if (y < 1970 || y > 2099 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return { error: DATE_ERR };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let k = 0; k < parts.length; k++) {
        const t = parts[k].trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[k] = t;
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      const n = raw.length;
      if (n === 0 || n > 64) return { error: 'key "slug": not a slug' };
      let prevDash = false;
      for (let i = 0; i < n; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (i === 0 || prevDash || i === n - 1) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text !== '---' && text.slice(0, 4) !== '---\n') return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  // Find the closing --- line first: a source with no close is refused for
  // that alone, whatever its lines hold.
  let closeStart = -1;
  let bodyStart = -1;
  let pos = 4;
  while (true) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
  }
  const data = {};
  let lineStart = 4;
  let lineNo = 2;
  while (lineStart < closeStart) {
    const nl = text.indexOf('\n', lineStart);
    const end = nl === -1 ? closeStart : Math.min(nl, closeStart);
    const line = text.slice(lineStart, end);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      let i = 0;
      const L = line.length;
      while (i < L) {
        const c = line.charCodeAt(i);
        if ((c >= 97 && c <= 122) || c === 95) i++;
        else break;
      }
      if (i === 0 || i >= L || line.charCodeAt(i) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, i);
      let raw;
      if (i + 1 === L) raw = '';
      else if (line.charCodeAt(i + 1) === 32) {
        raw = line.slice(i + 2);
        let e = raw.length;
        while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
        raw = raw.slice(0, e);
      } else return { error: `line ${lineNo} is not "key: value"` };
      if (!FM_KEY_SET.has(key)) return { error: `unknown key "${key}"` };
      if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    lineStart = nl === -1 ? closeStart : nl + 1;
    lineNo++;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------------- Markdown

/** The characters a backslash escapes, as a code table. */
const ESCAPABLE_CODE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE_CODE[ch.charCodeAt(0)] = 1;

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. A match is escaped exactly when the run of backslashes
 * immediately before it, as scanned from `from`, is odd: backslashes pair
 * up from the left, and a lone one escapes the next character.
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let cnt = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      cnt++;
      k--;
    }
    if (cnt % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/**
 * The first single * from `from` (one whose run is not **), outside an
 * escape, or -1. A run of stars is walked two at a time, so the third star
 * of *** counts as single, as the reference's scan does.
 */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let cnt = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      cnt++;
      k--;
    }
    if (cnt % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

const WS_TEST = /\s/;
const SCHEME_TEST = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The characters inline rendering must stop at, scanned by the regex engine. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link target's href, in the build's context `ctx` (source `srcPath`, dir `dir`). */
function resolveLink(ctx, dir, target) {
  if (SCHEME_TEST.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null && ctx.bySource.has(path)) return ctx.bySource.get(path).url + frag;
  if (path !== null && ctx.staticPaths.has(path)) return `${ctx.base}/${path}${frag}`;
  ctx.broken.add(`broken-link ${ctx.srcPath} -> ${target}`);
  return target;
}

/** `s` rendered inline; links resolve through `resolveLink(ctx, dir, target)`.
 * The regex engine jumps from one special character to the next, so plain
 * runs are sliced whole; `SPECIAL_RE` is shared, and every branch that
 * recurses resets its lastIndex after the recursion returns. */
function inline(s, ctx, dir) {
  const n = s.length;
  if (n === 0) return '';
  const out = [];
  let run = 0;
  SPECIAL_RE.lastIndex = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (run < i) out.push(s.slice(run, i));
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out.push(ENT[c]);
      run = i + 1;
    } else if (c === '\\') {
      if (i + 1 < n && s.charCodeAt(i + 1) < 128 && ESCAPABLE_CODE[s.charCodeAt(i + 1)] === 1) {
        out.push(s.charCodeAt(i + 1) === 62 ? '&gt;' : s[i + 1]);
        run = i + 2;
        SPECIAL_RE.lastIndex = i + 2;
      } else {
        out.push('\\');
        run = i + 1;
      }
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push('<code>', escStr(s.slice(i + 1, j)), '</code>');
        run = j + 1;
        SPECIAL_RE.lastIndex = j + 1;
      } else {
        out.push('`');
        run = i + 1;
      }
    } else if (c === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push('<strong>', inline(s.slice(i + 2, j), ctx, dir), '</strong>');
          run = j + 2;
          SPECIAL_RE.lastIndex = j + 2;
        } else {
          out.push('**');
          run = i + 2;
          SPECIAL_RE.lastIndex = i + 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out.push('<em>', inline(s.slice(i + 1, j), ctx, dir), '</em>');
          run = j + 1;
          SPECIAL_RE.lastIndex = j + 1;
        } else {
          out.push('*');
          run = i + 1;
        }
      }
    } else {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_TEST.test(target)) {
        out.push('<a href="', escStr(resolveLink(ctx, dir, target)), '">', inline(s.slice(i + 1, k), ctx, dir), '</a>');
        run = mm + 1;
        SPECIAL_RE.lastIndex = mm + 1;
      } else {
        out.push('[');
        run = i + 1;
      }
    }
  }
  if (run < n) out.push(s.slice(run));
  return out.length === 1 ? out[0] : out.join('');
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i !== n) return null;
  return line.slice(3, langEnd);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let k = 0;
  while (k < 6 && line.charCodeAt(k) === 35) k++;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  let a = k;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: k, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(1);
  const c2 = line.charCodeAt(2);
  if (!((c0 === 45 && c1 === 45 && c2 === 45) || (c0 === 42 && c1 === 42 && c2 === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2) return false;
  if (i >= line.length) return false;
  return !WS_TEST.test(line[i]);
}

/** An ordered list marker's number and item text, or null. */
function orderedOf(line) {
  const c0 = line.charCodeAt(0);
  if (c0 < 48 || c0 > 57) return null;
  let j = 1;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: +line.slice(0, j), text: line.slice(j + 2) };
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, ctx, dir) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const code = body.length === 0 ? '' : `${escStr(body.join('\n'))}\n`;
        blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${code}</code></pre>`);
        blocks.push('\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inline(h.text, ctx, dir);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        blocks.push('\n');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>');
        blocks.push('\n');
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), ctx, dir)}</p>\n</blockquote>`);
      blocks.push('\n');
      continue;
    }
    const isBullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
    const ord = !isBullet ? orderedOf(line) : null;
    if (isBullet || ord !== null) {
      const ordered = ord !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        let m = null;
        if (ordered) {
          const o = orderedOf(l);
          if (o !== null) m = o.text;
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) m = l.slice(2);
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && ord.num !== 1 ? `<ol start="${ord.num}">` : `<${tag}>`;
      let inner = '';
      for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), ctx, dir)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      blocks.push('\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), ctx, dir);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
    blocks.push('\n');
  }
  return { html: blocks.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------------ templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function isSpacesOnly(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesOnly(src, lineStart, open) && isSpacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include.
//   text:    [0, text]
//   var/raw: [1|2, path]
//   if:      [3, path, not, then, else|null]
//   for:     [4, name, path, body]
//   include: [5, name]

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push([0, tok.text]);
    else if (tok.t === 'var' || tok.t === 'raw') body.push([tok.t === 'var' ? 1 : 2, tok.path]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [4, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push({ kind: 'for', node });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [3, pathOf(name, m[2]), m[1] !== undefined, [], null];
        body.push(node);
        stack.push({ kind: 'if', node });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.node[4] = [];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.node[3] : parent.node[4] ?? parent.node[3];
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push([5, m[1]]);
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.v, path[0])) s = s.p;
  if (s === null) return undefined;
  let v = s.v[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out`, in `scope` ({ v, p }); `ctx` holds the parsed templates. */
function renderOps(ops, scope, ctx, depth, out) {
  for (let n = 0; n < ops.length; n++) {
    const op = ops[n];
    const k = op[0];
    if (k === 0) out.push(op[1]);
    else if (k === 1) out.push(escStr(textOf(lookup(scope, op[1]))));
    else if (k === 2) out.push(textOf(lookup(scope, op[1])));
    else if (k === 3) {
      const v = truthy(lookup(scope, op[1]));
      const branch = v !== op[2] ? op[3] : op[4];
      if (branch !== null) renderOps(branch, scope, ctx, depth, out);
    } else if (k === 4) {
      const xs = lookup(scope, op[2]);
      if (!Array.isArray(xs)) continue;
      const vars = {};
      const loop = { index: 0, first: false, last: false, length: xs.length };
      const frame = { v: vars, p: scope };
      for (let j = 0; j < xs.length; j++) {
        vars[op[1]] = xs[j];
        vars.loop = loop;
        loop.index = j + 1;
        loop.first = j === 0;
        loop.last = j === xs.length - 1;
        renderOps(op[3], frame, ctx, depth, out);
      }
    } else {
      const name = op[1];
      const t = ctx.templates.get(name);
      if (t === undefined || depth >= 8) continue;
      if (ctx.staticSet.has(name)) {
        // A template that reads only site, tags and recent renders the same
        // at the same depth for every page of the case: render once, reuse.
        const key = `${name}|${depth + 1}`;
        let s = ctx.staticCache.get(key);
        if (s === undefined) {
          const tmp = [];
          renderOps(t, scope, ctx, depth + 1, tmp);
          s = tmp.join('');
          ctx.staticCache.set(key, s);
        }
        out.push(s);
      } else if (ctx.singleMap.has(name)) {
        // A template that reads only site, tags, recent and one more value
        // renders the same for the same value of that name.
        const key = `${name}|${depth + 1}`;
        let byVal = ctx.singleCache.get(key);
        if (byVal === undefined) {
          byVal = new Map();
          ctx.singleCache.set(key, byVal);
        }
        const v = lookup(scope, [ctx.singleMap.get(name)]);
        let s = byVal.get(v);
        if (s === undefined) {
          const tmp = [];
          renderOps(t, scope, ctx, depth + 1, tmp);
          s = tmp.join('');
          byVal.set(v, s);
        }
        out.push(s);
      } else renderOps(t, scope, ctx, depth + 1, out);
    }
  }
}

/**
 * The templates whose render depends only on site, tags and recent (and the
 * include depth), and the templates that depend on those plus one more value:
 * their free names, through includes and past the names their own fors bind,
 * are among those three, or those three plus a single name. The first kind
 * renders identically for every page of a case; the second renders
 * identically for every render with the same value for that name (a card, for
 * one post, is the same on the index page and on the tag pages). Empty when
 * some for anywhere binds one of the three, since a caller's loop could then
 * shadow the root value.
 */
function analyzeStatic(templates) {
  const allBound = new Set();
  const collectBound = (ops) => {
    for (const op of ops) {
      if (op[0] === 4) {
        allBound.add(op[1]);
        collectBound(op[3]);
      } else if (op[0] === 3) {
        collectBound(op[3]);
        if (op[4] !== null) collectBound(op[4]);
      }
    }
  };
  for (const nodes of templates.values()) collectBound(nodes);
  if (allBound.has('site') || allBound.has('tags') || allBound.has('recent')) return { staticSet: new Set(), singleMap: new Map() };
  const memo = new Map();
  const visiting = new Set();
  const freeOf = (name) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return null;
    const nodes = templates.get(name);
    if (nodes === undefined) return new Set();
    visiting.add(name);
    const free = new Set();
    let ok = true;
    const walk = (ops, bound) => {
      for (const op of ops) {
        const k = op[0];
        if (k === 1 || k === 2) {
          if (!bound.has(op[1][0])) free.add(op[1][0]);
        } else if (k === 3) {
          if (!bound.has(op[1][0])) free.add(op[1][0]);
          walk(op[3], bound);
          if (op[4] !== null) walk(op[4], bound);
        } else if (k === 4) {
          if (!bound.has(op[2][0])) free.add(op[2][0]);
          const b2 = new Set(bound);
          b2.add(op[1]);
          b2.add('loop');
          walk(op[3], b2);
        } else if (k === 5) {
          const sub = freeOf(op[1]);
          if (sub === null) ok = false;
          else for (const nm of sub) if (!bound.has(nm)) free.add(nm);
        }
      }
    };
    walk(nodes, new Set());
    visiting.delete(name);
    const res = ok ? free : null;
    memo.set(name, res);
    return res;
  };
  const staticSet = new Set();
  const singleMap = new Map();
  for (const name of templates.keys()) {
    const free = freeOf(name);
    if (free === null) continue;
    const extra = [];
    for (const nm of free) if (nm !== 'site' && nm !== 'tags' && nm !== 'recent') extra.push(nm);
    if (extra.length === 0) staticSet.add(name);
    // Only when the extra name is bound by a for somewhere: then its value
    // is a loop element, a stable object shared across renders (a post's
    // card on the index and tag pages). A root value such as page is built
    // fresh per render and would never hit the cache.
    else if (extra.length === 1 && allBound.has(extra[0])) singleMap.set(name, extra[0]);
  }
  return { staticSet, singleMap };
}

/** The template `name` rendered with `vars`, or null when it is missing. */
function renderTemplate(ctx, name, vars) {
  const nodes = ctx.templates.get(name);
  if (nodes === undefined) return null;
  const out = [];
  renderOps(nodes, { v: vars, p: null }, ctx, 0, out);
  return out.join('');
}

// ---------------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let sp;
    if (c < 33) sp = c === 32 || (c >= 9 && c <= 13);
    else if (c < 128) sp = false;
    else sp = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (sp) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  if (s.card !== undefined) return s.card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

/** A page as its layout reads it. */
function pageOf(s) {
  const c = cardOf(s);
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  while (base.charCodeAt(base.length - 1) === 47) base = base.slice(0, -1);
  const { staticSet, singleMap } = analyzeStatic(templates);
  const ctx = { templates, base, bySource: new Map(), staticPaths: new Set(), broken: new Set(), srcPath: '', staticSet, singleMap, staticCache: new Map(), singleCache: new Map() };

  // 1. Sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (let f = 0; f < files.length; f++) {
    const file = files[f];
    if (file.path.endsWith('.md')) {
      const c = file.content;
      sources.push({ path: file.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: file.path, content: file.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (let d = 0; d < RESERVED.length; d++) {
      const r = RESERVED[d];
      if (r !== 'posts' && s.path.startsWith(`${r}/`)) {
        own = r;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's output directory and url.
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    ctx.bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved.
  for (const f of statics) ctx.staticPaths.add(f.path);
  for (const s of kept) {
    ctx.srcPath = s.path;
    const md = renderMarkdown(s.body, ctx, dirOf(s.path));
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: the posts, newest first and then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const tags = s.data.tags ?? [];
    const out = [];
    for (const name of tags) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index pages and the tag pages.
  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => renderTemplate(ctx, name, { site, tags: allTags, recent, ...vars });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...ctx.broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
