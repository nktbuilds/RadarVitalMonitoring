// Runs every *.mjs test in this folder and reports pass/fail.
// Usage: node test/run-all.mjs   (from the project root)
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs')
  .sort();

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' });
  const ok = res.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}\n`);
}

console.log(`${files.length - failed}/${files.length} test files passed`);
process.exit(failed === 0 ? 0 : 1);
