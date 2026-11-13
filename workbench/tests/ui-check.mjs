import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const tools = path.resolve('workbench/.tools/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(tools).href);

const url = process.argv[2];
const marker = process.argv[3] ?? 'HARNESS_MOCK_OK';
const screenshot = process.argv[4] ?? 'workbench/.logs/harness.png';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const outside = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  const parsed = new URL(request.url());
  if (['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    outside.push(`${parsed.origin}${parsed.pathname}`);
  }
});

async function dismissDialogs() {
  for (const name of [/^Continue$/, /^继续$/, /^Got it$/, /^知道了$/]) {
    const button = page.getByRole('button', { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }
}

let result = { passed: false };
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const editor = page.locator('[contenteditable=true]').first();
  for (let attempt = 0; attempt < 40; attempt++) {
    await dismissDialogs();
    if (await editor.isVisible().catch(() => false)) {
      const inert = await editor.evaluate(element => element.inert || element.closest('[inert]') !== null).catch(() => true);
      if (!inert) break;
    }
    await page.waitForTimeout(500);
  }
  await dismissDialogs();
  const nonce = `${marker}_${Date.now().toString(36)}`;
  const sentText = `请回复 ${nonce}`;
  await editor.click({ timeout: 15000 });
  await editor.type(sentText);
  await page.keyboard.press('Enter');

  let reply = null;
  let userSeen = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    const state = await page.evaluate(({ nonce, sentText }) => {
      const items = [...document.querySelectorAll('[data-chat-flow-kind]')];
      let userIndex = -1;
      let replyText = null;
      items.forEach((node, index) => {
        const text = node.innerText.trim();
        const kind = node.getAttribute('data-chat-flow-kind');
        if (kind === 'user' && text.includes(sentText)) userIndex = index;
        if (kind === 'assistant-step' && index > userIndex && userIndex >= 0 && text.includes(nonce)) replyText = text;
      });
      return { userSeen: userIndex >= 0, reply: replyText };
    }, { nonce, sentText });
    userSeen = state.userSeen;
    reply = state.reply;
    if (reply) break;
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: screenshot, fullPage: true });
  const body = await page.evaluate(() => document.body.innerText);
  const composer = await page.evaluate(() => document.querySelector('[data-composer-input=true]')?.innerText ?? '');
  writeFileSync('workbench/.logs/transcript.txt', body);
  result = { passed: Boolean(reply), nonce, userMessageRendered: userSeen, reply, composerAfterSend: composer, errors, externalRequests: outside, screenshot };
} catch (error) {
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
  result = { passed: false, error: error.message, errors, externalRequests: outside, screenshot };
} finally {
  writeFileSync('workbench/.logs/ui-result.json', JSON.stringify(result, null, 2));
  await browser.close();
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}