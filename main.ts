// The harness runs `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json, answers each one alone with run() from solve.js, and
// writes /output/answers.json: a JSON array of the answers, one per case and
// in the cases' order. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it.
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];

// Stream the answers out case by case instead of holding the whole 7 MB
// JSON text at once: the bytes are exactly JSON.stringify's for the array
// (a JSON array is its items joined by "," inside brackets), written piece
// by piece, each case's answer string freed after it is written.
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
try {
  writeSync(fd, '[');
  for (let i = 0; i < cases.length; i++) {
    if (i > 0) writeSync(fd, ',');
    writeSync(fd, JSON.stringify(run(cases[i]!.input)));
  }
  writeSync(fd, ']');
} finally {
  closeSync(fd);
}
