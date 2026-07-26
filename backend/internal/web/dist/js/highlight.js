// highlight.js — a deliberately small, dependency-free syntax highlighter.
// It is not trying to be exhaustive; it recognizes comments, strings,
// numbers, common keywords, and function-call-looking identifiers, which
// covers the vast majority of code snippets found in RSS article bodies
// well enough to look intentional rather than plain.

const KEYWORDS = new Set([
  "function", "return", "if", "else", "for", "while", "do", "switch", "case",
  "break", "continue", "class", "extends", "new", "const", "let", "var",
  "import", "export", "from", "default", "async", "await", "try", "catch",
  "finally", "throw", "typeof", "instanceof", "in", "of", "yield", "static",
  "public", "private", "protected", "interface", "implements", "enum",
  "struct", "func", "package", "def", "fn", "impl", "trait", "match", "pub",
  "mod", "use", "mut", "self", "None", "True", "False", "null", "true",
  "false", "undefined", "void", "this", "super",
]);

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Tokenizes a single line of code and returns HTML with <span class="tok-*">
 * wrappers, matching the Catppuccin theme classes defined in
 * css/code-theme.css.
 */
function highlightLine(line) {
  let out = "";
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    // Line comment (// or #)
    if (ch === "/" && line[i + 1] === "/") {
      out += `<span class="tok-comment">${escapeHTML(line.slice(i))}</span>`;
      break;
    }
    if (ch === "#") {
      out += `<span class="tok-comment">${escapeHTML(line.slice(i))}</span>`;
      break;
    }

    // String literals
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n && line[j] !== quote) {
        if (line[j] === "\\") j++;
        j++;
      }
      j = Math.min(j + 1, n);
      out += `<span class="tok-string">${escapeHTML(line.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.xXa-fA-F]/.test(line[j])) j++;
      out += `<span class="tok-number">${escapeHTML(line.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // Identifiers (keywords / function calls)
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (KEYWORDS.has(word)) {
        out += `<span class="tok-keyword">${escapeHTML(word)}</span>`;
      } else if (line[j] === "(") {
        out += `<span class="tok-function">${escapeHTML(word)}</span>`;
      } else {
        out += escapeHTML(word);
      }
      i = j;
      continue;
    }

    out += escapeHTML(ch);
    i++;
  }

  return out;
}

/**
 * Highlights every <pre><code> block inside root in place. Adds the
 * "code-block" class used by css/code-theme.css.
 */
export function highlightCodeBlocks(root) {
  const blocks = root.querySelectorAll("pre code");
  blocks.forEach((codeEl) => {
    const pre = codeEl.closest("pre");
    if (pre) pre.classList.add("code-block");

    const raw = codeEl.textContent || "";
    const lines = raw.split("\n");
    codeEl.innerHTML = lines.map(highlightLine).join("\n");
  });
}
