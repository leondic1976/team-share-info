// Scans the program's user-visible sources for emoji / pictographs.
// Usage: node scripts/check-emoji.mjs [--all]
//   default: prints file:line for every Extended_Pictographic character (there must be none)
//   --all:   also prints the icon-like symbols (arrows, bullets, check marks) for manual review
// The same logic is run by tests/shared/no-emoji.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCAN_DIRS = ['src', 'plugins', 'resources/ledger', 'resources/meal', 'site', 'docs/manual'];
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.html', '.json', '.md', '.svg', '.txt']);
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git']);
// The one file where emoji belong: the messenger's emoticon set (user decision 2026-11-25, 지시 62).
export const EMOJI_FILES = ['src/renderer/features/chat/emoticons.ts'];

// Emoji proper. The copyright, registered and trademark signs are Extended_Pictographic too,
// but they are plain typography.
const NOT_TYPO = '(?![\\u00a9\\u00ae\\u2122])';
export const EMOJI_RE = new RegExp(`${NOT_TYPO}\\p{Extended_Pictographic}`, 'u');
const EMOJI_RE_G = new RegExp(
  `${NOT_TYPO}\\p{Extended_Pictographic}(?:\\ufe0f|\\u200d\\p{Extended_Pictographic})*`,
  'gu',
);
// Symbols this codebase has used as icons (arrows, geometric shapes, stars, check marks, dingbat
// crosses, warning sign). Only reported with --all: each one is judged by hand.
const SYMBOL_RE_G = /[\u2190-\u21ff\u25a0-\u25ff\u2605\u2606\u2713-\u2718\u2b00-\u2bff\u26a0]/gu;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

/** @returns {{file: string, line: number, chars: string[], text: string}[]} */
export function scanEmoji({ root = ROOT, dirs = SCAN_DIRS, symbols = false } = {}) {
  const hits = [];
  for (const d of dirs) {
    let files;
    try {
      files = walk(join(root, d), []);
    } catch {
      continue;
    }
    for (const f of files) {
      if (EMOJI_FILES.includes(relative(root, f).split('\\').join('/'))) continue;
      const lines = readFileSync(f, 'utf8').split(/\r?\n/);
      lines.forEach((text, i) => {
        const chars = [...(text.match(EMOJI_RE_G) ?? []), ...(symbols ? (text.match(SYMBOL_RE_G) ?? []) : [])];
        if (chars.length > 0) {
          hits.push({ file: relative(root, f).split('\\').join('/'), line: i + 1, chars, text: text.trim() });
        }
      });
    }
  }
  return hits;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const all = process.argv.includes('--all');
  const hits = scanEmoji({ symbols: all });
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.chars.join(' ')}  | ${h.text.slice(0, 140)}`);
  console.log(`${hits.length} line(s)`);
  process.exit(hits.length > 0 && !all ? 1 : 0);
}
