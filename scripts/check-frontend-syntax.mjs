// Extracts inline (non-src) <script> blocks from the app HTML and syntax-checks
// each with the V8 parser via node's vm. Fails (non-zero exit) on a parse error.
// This is a cheap guard against shipping a broken single-file frontend; it does
// NOT execute the code, only parses it.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const HTML = "MyPersonas.Online_v0/index.html";
const html = readFileSync(HTML, "utf8");

// Match <script> ... </script> where the open tag has no src attribute.
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m;
let idx = 0;
let failures = 0;
let checked = 0;

while ((m = re.exec(html)) !== null) {
  const code = m[1];
  idx += 1;
  // Skip JSON-LD / data blocks (type="application/ld+json" etc.) — not JS.
  const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
  if (/type\s*=\s*["'](?!text\/javascript|module|application\/javascript)/i.test(openTag)) {
    continue;
  }
  if (!code.trim()) continue;
  checked += 1;
  try {
    // new vm.Script parses (compiles) without running.
    new vm.Script(code, { filename: `${HTML}#script${idx}` });
  } catch (err) {
    failures += 1;
    console.error(`Syntax error in ${HTML} script block #${idx}:`);
    console.error(`  ${err.message}`);
  }
}

if (checked === 0) {
  console.error(`No inline scripts found in ${HTML} — check the extractor.`);
  process.exit(2);
}
console.log(`Checked ${checked} inline script block(s) in ${HTML}.`);
process.exit(failures > 0 ? 1 : 0);
