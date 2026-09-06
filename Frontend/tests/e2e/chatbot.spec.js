import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let server;
let baseURL;
const deletedConversations = new Set();

const sampleConversation = {
  id: '1f0e6d2a-9c4b-4a3e-8b7d-2f5a9c8d1e2f',
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
  messages: [
    { role: 'user', content: 'Delete me please', sources: null, documentId: null },
    { role: 'assistant', content: 'Sure, this conversation can be deleted.', sources: [], documentId: null },
  ],
};

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/health') return response.end(JSON.stringify({ status: 'ok' }));
    if (url.pathname === '/auth/me') {
      return response.end(JSON.stringify({ id: 'user-1', email: 'test@example.com', name: 'Test User', picture: null }));
    }
    if (url.pathname === '/documents') return response.end(JSON.stringify([]));
    if (url.pathname === '/conversations') {
      return response.end(JSON.stringify(deletedConversations.size > 0 ? [] : [sampleConversation]));
    }
    if (url.pathname.startsWith('/conversations/') && request.method === 'DELETE') {
      deletedConversations.add(url.pathname.split('/')[2]);
      return response.end(JSON.stringify({ message: 'Conversation deleted' }));
    }
    if (url.pathname === '/upload' && request.method === 'POST') {
      return response.end(JSON.stringify({ documentId: '00000000-0000-4000-8000-000000000001', status: 'QUEUED' }));
    }
    if (url.pathname.startsWith('/document/')) {
      return response.end(JSON.stringify({ id: url.pathname.split('/').pop(), filename: 'test.txt', status: 'READY' }));
    }
    if (url.pathname === '/chat') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write('data: {"type":"status","message":"Searching"}\n\n');
      response.write('data: {"type":"token","content":"Answer from the document."}\n\n');
      response.write('data: {"type":"sources","documents":["test.txt"]}\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = path.join(root, file);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
      response.writeHead(404).end();
      return;
    }
    const type = filePath.endsWith('.html') ? 'text/html' : filePath.endsWith('.css') ? 'text/css' : 'text/javascript';
    response.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filePath).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('loads the app, sends a streamed question, and renders the answer', async ({ page }) => {
  await page.addInitScript((api) => { window.RAG_API_BASE = api; }, baseURL);
  await page.route('**/chat?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"status","message":"Searching"}\n\ndata: {"type":"token","content":"Answer from the document."}\n\ndata: {"type":"sources","documents":["test.txt"]}\n\ndata: [DONE]\n\n',
    });
  });
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { name: 'RAG ChatBot Intelligence' })).toBeVisible();
  await page.getByLabel('Ask a question about your documents').fill('What is in this document?');
  await page.getByRole('button', { name: 'Send query' }).click();
  await expect(page.locator('.message-content').last()).toContainText('Answer from the document.');
  await expect(page.locator('.source-chip')).toContainText('test.txt');
});

test('propagates an SSE error to the visible error message', async ({ page }) => {
  await page.addInitScript((api) => { window.RAG_API_BASE = api; }, baseURL);
  await page.route('**/chat?*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"error","message":"provider failed"}\n\n' });
  });
  await page.goto(baseURL);
  await page.getByLabel('Ask a question about your documents').fill('Trigger failure');
  await page.getByRole('button', { name: 'Send query' }).click();
  await expect(page.locator('.message-error')).toContainText('provider failed');
});

test('deletes a conversation from the sidebar after confirmation', async ({ page }) => {
  await page.addInitScript((api) => { window.RAG_API_BASE = api; }, baseURL);
  await page.goto(baseURL);

  const item = page.locator('.conversation-item', { hasText: 'Delete me please' });
  await expect(item).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await item.hover();
  await item.getByLabel('Delete conversation').click();

  await expect(item).toHaveCount(0);
  await expect(page.getByText('Conversation deleted')).toBeVisible();
});
