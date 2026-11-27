/** The Pages workflow deploys only from the default branch itself: a tag or another ref named like it never passes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'pages.yml');
const FULL_REF = "if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";

test('both jobs compare the full ref with the default branch, not only its name', () => {
  const conditions = readFileSync(WORKFLOW, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('if:'));
  assert.equal(conditions.length, 2);
  for (const condition of conditions) assert.equal(condition, FULL_REF);
});
