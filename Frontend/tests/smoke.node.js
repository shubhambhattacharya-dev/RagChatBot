import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('frontend contains the required API resilience controls', () => {
  assert.match(app, /AbortController/);
  assert.match(app, /fetchWithTimeout/);
  assert.match(app, /activeRequestController/);
});

test('frontend uses server-side conversation history', () => {
  assert.match(app, /loadRemoteHistory/);
  assert.match(app, /\/conversations/);
});

test('upload and chat controls have accessible affordances', () => {
  assert.match(html, /role="button" tabindex="0" aria-label="Upload documents"/);
  assert.match(html, /for="chatInput"/);
  assert.match(html, /aria-label="Stop response"/);
});

test('sign-in gate and user session controls are present', () => {
  assert.match(html, /id="googleSignInBtn"/);
  assert.match(html, /id="loginScreen"/);
  assert.match(app, /bootstrapAuth/);
  assert.match(app, /\/auth\/me/);
  assert.match(app, /\/auth\/logout/);
  assert.match(html, /id="logoutBtn"/);
});

test('conversations can be deleted individually', () => {
  assert.match(app, /conv-delete-btn/);
  assert.match(app, /deleteConversation/);
  assert.match(app, /\/conversations\/\$\{encodeURIComponent\(conv\.id\)\}/);
});

test('failed uploads cannot create invalid document scopes', () => {
  assert.match(app, /UUID_PATTERN/);
  assert.match(app, /upload failed: \$\{error\.message\}/);
  assert.doesNotMatch(app, /id: `doc-\$\{Date\.now\(\)\}/);
});
