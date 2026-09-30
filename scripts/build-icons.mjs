// Renders the app icons (the knight's-L logo mark on the accent green) with headless Chrome.
// Usage: node --experimental-websocket scripts/build-icons.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const OUT = join(ROOT, 'public', 'icons');
const cells = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => `<rect x="${col * 11}" y="${row * 11}" width="8" height="8" rx="1.5" fill="#fff" fill-opacity="${col === 0 || (row === 0 && col === 1) ? 1 : 0.22}"/>`)).join('');
const MARK = `<svg viewBox="0 0 30 30" width="100%" height="100%">${cells}</svg>`;
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ICONS = [
  ...[72, 96, 128, 144, 152, 192, 384, 512].map((size) => ({ file: `icon-${size}x${size}.png`, size, radius: 0.22, glyph: 0.62 })),
  ...[192, 512].map((size) => ({ file: `maskable-${size}x${size}.png`, size, radius: 0, glyph: 0.46 })),
  { file: 'apple-touch-icon.png', size: 180, radius: 0, glyph: 0.56 },
  { file: 'favicon-32x32.png', size: 32, radius: 0.2, glyph: 0.72 },
];

mkdirSync(OUT, { recursive: true });
const profile = join(process.env.TEMP, 'ot-icons-profile');
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', 'about:blank']);

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const n = ++id;
  pending.set(n, resolve);
  ws.send(JSON.stringify({ id: n, method, params }));
});

await send('Page.enable');
for (const icon of ICONS) {
  const html = `<!doctype html><style>
    html, body { margin: 0; background: transparent; }
    div { width: ${icon.size}px; height: ${icon.size}px; background: #2f7d4e; border-radius: ${icon.radius * icon.size}px;
          display: flex; align-items: center; justify-content: center; }
    span { width: ${Math.round(icon.glyph * icon.size * 0.9)}px; height: ${Math.round(icon.glyph * icon.size * 0.9)}px; display: block; }
  </style><div><span>${MARK}</span></div>`;
  await send('Emulation.setDeviceMetricsOverride', { width: icon.size, height: icon.size, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const page = join(profile, 'icon.html');
  writeFileSync(page, html);
  await send('Page.navigate', { url: pathToFileURL(page).href });
  await sleep(700);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, icon.file), Buffer.from(data, 'base64'));
  console.log('saved', icon.file);
}
ws.close();
chrome.kill();
