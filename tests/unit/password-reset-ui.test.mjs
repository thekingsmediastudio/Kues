import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const loginPage = fs.readFileSync(path.join(here, '../../apps/web/public/login.html'), 'utf8');

test('login page opens a separate code-based password recovery form with no reset-link path', () => {
  assert.match(loginPage, /id="passwordResetPanel"/);
  assert.match(loginPage, /id="resetStartForm"/);
  assert.match(loginPage, /id="resetCodeForm"/);
  assert.match(loginPage, /id="resetCode"[^>]*pattern="\[0-9\]\{6\}"/);
  assert.match(loginPage, /id="resetNewPassword"[^>]*autocomplete="new-password"/);
  assert.match(loginPage, /openPasswordReset\(emailInput\.value\)/);
  assert.match(loginPage, /\/api\/auth\/password\/reset\/start/);
  assert.match(loginPage, /\/api\/auth\/password\/reset\/verify/);
  assert.doesNotMatch(loginPage, /password setup link|password reset link|reset link/i);
});
