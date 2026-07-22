/*
 * md-lite — a tiny, dependency-free Markdown → HTML renderer (self-hosted).
 *
 * Why this exists: Pulse's living-doc pages (the sales Product Overview and the
 * client API guide) used to pull `marked` from cdn.jsdelivr.net. When that CDN
 * was blocked or unreachable the pages died with "Couldn't load the overview"
 * (issue #42). This self-hosted renderer removes the external dependency so the
 * pages render regardless of outbound network access.
 *
 * It intentionally supports only the GFM subset those docs use: ATX headings,
 * paragraphs, bold/italic/inline-code/links/images, blockquotes (nestable),
 * unordered + ordered lists (nestable), GFM pipe tables, fenced code blocks and
 * horizontal rules. It exposes a `marked`-compatible surface — `marked.parse()`
 * and `marked.setOptions()` — so pages that used marked keep working with a
 * one-line `<script src>` change.
 *
 * If you ever need fuller CommonMark/GFM fidelity, swap this for a self-hosted
 * (bundled — NOT a CDN <script>) build of a real library. Do not reintroduce a
 * CDN dependency: that is exactly the reliability bug this file fixes.
 */
(function (global) {
  'use strict';

  var options = { gfm: true, breaks: false };
  var NUL = String.fromCharCode(0); // placeholder sentinel — never appears in doc text

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Inline spans ───────────────────────────────────────────────────────────
  // Code spans are pulled out first (their contents must not be treated as
  // markup), then everything is HTML-escaped, then the inline constructs are
  // re-applied and the code spans restored.
  function inline(text) {
    var codes = [];
    text = String(text).replace(/(`+)([\s\S]+?)\1/g, function (_m, _ticks, code) {
      codes.push('<code>' + esc(code.replace(/^ | $/g, '')) + '</code>');
      return NUL + (codes.length - 1) + NUL;
    });

    text = esc(text);

    // images ![alt](url "title")  — before links (same shape, leading !)
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^)]*)&quot;)?\)/g,
      function (_m, alt, url, title) {
        return '<img src="' + url + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : '') + '>';
      });

    // links [text](url "title")
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^)]*)&quot;)?\)/g,
      function (_m, label, url, title) {
        return '<a href="' + url + '"' + (title ? ' title="' + title + '"' : '') + '>' + label + '</a>';
      });

    // bold first (so ** isn't consumed by the single-* italic rule), then italic
    text = text.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1<em>$2</em>');

    text = text.replace(new RegExp(NUL + '(\\d+)' + NUL, 'g'), function (_m, n) { return codes[+n]; });

    if (options.breaks) text = text.replace(/\n/g, '<br>\n');
    return text;
  }

  // ── Block-level patterns ─────────────────────────────────────────────────────
  var HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
  var HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
  var FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^`]*)$/;
  var ITEM = /^([ \t]*)([-*+]|\d+[.)])[ \t]+(.*)$/;
  var QUOTE = /^ {0,3}>[ \t]?(.*)$/;

  function isBlank(l) { return /^[ \t]*$/.test(l); }
  function indentOf(l) { return l.match(/^[ \t]*/)[0].length; }
  function isBlockStart(l) {
    return HR.test(l) || HEADING.test(l) || FENCE.test(l) || ITEM.test(l) || QUOTE.test(l);
  }

  function isTableSep(l) {
    return /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)+\|?[ \t]*$/.test(l);
  }
  function splitRow(row) {
    row = row.replace(/^[ \t]*\|/, '').replace(/\|[ \t]*$/, '');
    var cells = [], cur = '';
    for (var i = 0; i < row.length; i++) {
      if (row[i] === '\\' && row[i + 1] === '|') { cur += '|'; i++; }
      else if (row[i] === '|') { cells.push(cur); cur = ''; }
      else cur += row[i];
    }
    cells.push(cur);
    return cells.map(function (c) { return c.trim(); });
  }

  // Strip the common leading indentation off a block so a nested construct can be
  // re-parsed as if it started at column 0.
  function dedent(s) {
    var ls = s.split('\n'), min = Infinity;
    ls.forEach(function (l) { if (/\S/.test(l)) { min = Math.min(min, indentOf(l)); } });
    if (!isFinite(min) || min === 0) return s;
    return ls.map(function (l) { return l.slice(min); }).join('\n');
  }

  // Render one list item: its leading text stays inline (tight lists); any nested
  // block (sub-list, extra paragraph) below it is re-parsed.
  function renderItem(content) {
    var ls = content.split('\n');
    var k = 0, lead = [];
    while (k < ls.length && !isBlank(ls[k]) && !isBlockStart(ls[k])) { lead.push(ls[k]); k++; }
    var head = inline(lead.join('\n').trim());
    var rest = ls.slice(k).join('\n');
    return /\S/.test(rest) ? head + parse(dedent(rest)) : head;
  }

  function parseList(lines, start, baseIndent) {
    var first = ITEM.exec(lines[start]);
    var ordered = /\d/.test(first[2]);
    var startNum = ordered ? parseInt(first[2], 10) : 1;
    var items = [];
    var i = start;
    while (i < lines.length) {
      var m = ITEM.exec(lines[i]);
      if (!(m && m[1].length === baseIndent && (/\d/.test(m[2]) === ordered))) break;
      var content = [m[3]];
      i++;
      while (i < lines.length) {
        if (isBlank(lines[i])) {
          // a blank line only stays in the item if more-indented content follows
          if (i + 1 < lines.length && /\S/.test(lines[i + 1]) && indentOf(lines[i + 1]) > baseIndent) {
            content.push(''); i++; continue;
          }
          break;
        }
        var im = ITEM.exec(lines[i]);
        if (im && im[1].length === baseIndent) break;    // sibling item
        if (indentOf(lines[i]) > baseIndent) { content.push(lines[i].slice(baseIndent)); i++; continue; }
        break;                                            // dedented, non-item → list ends
      }
      items.push(content.join('\n'));
    }
    var tag = ordered ? 'ol' : 'ul';
    var attr = ordered && startNum !== 1 ? ' start="' + startNum + '"' : '';
    var html = '<' + tag + attr + '>' +
      items.map(function (c) { return '<li>' + renderItem(c) + '</li>'; }).join('') +
      '</' + tag + '>';
    return { html: html, next: i };
  }

  function parse(md) {
    var lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) { i++; continue; }

      var f = FENCE.exec(line);
      if (f) {
        var marker = f[2].charAt(0), len = f[2].length, lang = (f[3] || '').trim();
        var close = new RegExp('^[ \\t]*\\' + marker + '{' + len + ',}[ \\t]*$');
        var buf = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // consume closing fence
        out.push('<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' +
          esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      var h = HEADING.exec(line);
      if (h) { var lvl = h[1].length; out.push('<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>'); i++; continue; }

      if (HR.test(line)) { out.push('<hr>'); i++; continue; }

      if (QUOTE.test(line)) {
        var qb = [];
        while (i < lines.length && QUOTE.test(lines[i])) { qb.push(QUOTE.exec(lines[i])[1]); i++; }
        out.push('<blockquote>' + parse(qb.join('\n')) + '</blockquote>');
        continue;
      }

      // GFM pipe table: a row with a pipe, immediately followed by a separator row
      if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var header = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (s) {
          var l = s.charAt(0) === ':', r = s.charAt(s.length - 1) === ':';
          return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
        });
        i += 2;
        var rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') !== -1) { rows.push(splitRow(lines[i])); i++; }
        var cell = function (tag, txt, k) {
          return '<' + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(txt) + '</' + tag + '>';
        };
        var thead = '<tr>' + header.map(function (c, k) { return cell('th', c, k); }).join('') + '</tr>';
        var tbody = rows.map(function (r) {
          return '<tr>' + header.map(function (_c, k) { return cell('td', r[k] || '', k); }).join('') + '</tr>';
        }).join('');
        out.push('<table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>');
        continue;
      }

      if (ITEM.test(line)) {
        var res = parseList(lines, i, ITEM.exec(line)[1].length);
        out.push(res.html); i = res.next; continue;
      }

      // paragraph — consume until a blank line or the start of another block
      var pbuf = [line]; i++;
      while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) { pbuf.push(lines[i]); i++; }
      out.push('<p>' + inline(pbuf.join('\n').replace(/[ \t]+\n/g, '\n').trim()) + '</p>');
    }
    return out.join('\n');
  }

  var marked = {
    parse: parse,
    setOptions: function (o) {
      if (o) for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) options[k] = o[k]; }
      return marked;
    },
    options: options,
  };

  global.marked = marked;
  if (typeof module !== 'undefined' && module.exports) module.exports = marked;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
