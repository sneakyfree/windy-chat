#!/usr/bin/env node
/**
 * Windy Chat — Test Runner
 *
 * Runs all test files sequentially in isolated child processes.
 * Avoids Node 22 test runner IPC deserialization bugs that occur
 * when running multiple test files via `node --test *.test.js`.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const testFiles = [
  ...fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(f => f.endsWith('.test.js'))
    .map(f => `tests/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'tests', 'unit'))
    .filter(f => f.endsWith('.js'))
    .map(f => `tests/unit/${f}`),
];

let totalTests = 0;
let totalPass = 0;
let totalFail = 0;
const failures = [];

for (const file of testFiles) {
  process.stdout.write(`  ${file} ... `);
  try {
    const output = execSync(`node --test ${file}`, {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    }).toString();

    const tests = parseInt((output.match(/# tests (\d+)/) || [])[1] || '0');
    const pass = parseInt((output.match(/# pass (\d+)/) || [])[1] || '0');
    const fail = parseInt((output.match(/# fail (\d+)/) || [])[1] || '0');

    totalTests += tests;
    totalPass += pass;
    totalFail += fail;

    if (fail > 0) {
      console.log(`${pass}/${tests} (${fail} FAILED)`);
      failures.push({ file, output });
    } else {
      console.log(`${pass}/${tests} OK`);
    }
  } catch (err) {
    const output = (err.stdout || '').toString() + (err.stderr || '').toString();
    const tests = parseInt((output.match(/# tests (\d+)/) || [])[1] || '0');
    const pass = parseInt((output.match(/# pass (\d+)/) || [])[1] || '0');
    const fail = parseInt((output.match(/# fail (\d+)/) || [])[1] || tests);

    totalTests += tests || 1;
    totalPass += pass;
    totalFail += fail || 1;

    console.log(`FAILED (${pass}/${tests || '?'})`);
    failures.push({ file, output: output.slice(-500) });
  }
}

console.log(`\n  Total: ${totalPass}/${totalTests} passed, ${totalFail} failed\n`);

if (failures.length > 0) {
  console.log('Failures:');
  for (const { file } of failures) {
    console.log(`  - ${file}`);
  }
  process.exit(1);
}
