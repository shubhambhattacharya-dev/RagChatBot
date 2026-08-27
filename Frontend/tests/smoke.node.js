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
