// Fails the build if any file Chrome will load as text contains something Chrome rejects as
// "not UTF-8". A plain UTF-8 decode is NOT enough: Chrome also refuses Unicode noncharacters
// (U+FFFE, U+FFFF, U+FDD0..U+FDEF and the same in every plane) and lone surrogates. That is how
// v8's first build failed to load: "Could not load file 'content-scripts/content.js' ... It isn't
// UTF-8 encoded", with a file that decoded cleanly; a raw U+FFFF had been typed into store.ts as a
// range bound and was copied into the bundle. Runs automatically after `npm run build`.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.output/chrome-mv3';
if (!existsSync(root)) {
  console.error(`check-build-output: ${root} does not exist - build first.`);
  process.exit(1);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const TEXT = /\.(js|mjs|cjs|json|html|css|svg|txt)$/i;
const problems = [];
let scanned = 0;

for (const file of walk(root)) {
  if (!TEXT.test(file)) continue;
  scanned++;
  const bytes = readFileSync(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    problems.push(`${file}: not valid UTF-8 (${error.message})`);
    continue;
  }
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp > 0xffff) i++;
    const surrogate = cp >= 0xd800 && cp <= 0xdfff;
    const nonCharacter = (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe;
    if (surrogate || nonCharacter) {
      const context = JSON.stringify(text.slice(Math.max(0, i - 30), i + 30));
      problems.push(`${file}: U+${cp.toString(16).toUpperCase().padStart(4, '0')} at ${i}, near ${context}`);
      break; // one report per file is enough
    }
  }
}

if (problems.length > 0) {
  console.error('check-build-output: Chrome would refuse this build ("isn\'t UTF-8 encoded"):');
  for (const p of problems) console.error('  ' + p);
  console.error('Write such characters as String.fromCharCode(...) of a runtime value, or avoid them.');
  process.exit(1);
}
console.log(`check-build-output: ${scanned} files, no characters Chrome rejects.`);
