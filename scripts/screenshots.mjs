// Captures the main screens with headless Chrome. Needs the dev server on :4300.
// Usage: node --experimental-websocket scripts/screenshots.mjs path/to/repertoire.pgn
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:4300/';
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const OUT = join(ROOT, 'screenshots');
const PGN = readFileSync(process.argv[2] ?? join(ROOT, 'test-sicilian-black.pgn'), 'utf8');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

async function session(width, height, mobile, suffix) {
  const profile = join(process.env.TEMP, `ot-shots-${suffix}`);
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--lang=nl-NL', '--hide-scrollbars', 'about:blank']);
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
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const js = async (body) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const shot = async (name) => {
    await sleep(600);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}-${suffix}.png`), Buffer.from(data, 'base64'));
    console.log('saved', `${name}-${suffix}`);
  };
  const click = (text, selector = 'button, label') =>
    js(`const el = [...document.querySelectorAll('${selector}')].find(e => e.offsetParent !== null && e.innerText.trim().includes(${JSON.stringify(text)})); if (!el) throw new Error('no ' + ${JSON.stringify(text)}); el.click();`);
  const trainer = `ng.getComponent(document.querySelector('app-train-view')).trainer`;
  const playLine = (mistakes) =>
    js(`const t = ${trainer}; let wrong = ${mistakes};
      for (let i = 0; i < 400 && t.item() && !t.done(); i++) {
        const a = t.attempt;
        if (a && a.isPlayerTurn) {
          if (wrong > 0 && a.correct >= 2) { t.move({ from: 'a1', to: 'a2' }); wrong--; await new Promise(r => setTimeout(r, 30)); }
          t.move({ from: a.expected.from, to: a.expected.to });
        }
        await new Promise(r => setTimeout(r, 40));
      }`);

  await send('Page.enable');
  // Chess.com rejects the HeadlessChrome user agent.
  await send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send('Page.navigate', { url: APP });
  await sleep(2500);
  await shot('01-welkom');

  await click('PGN importeren');
  await js(`const ta = document.querySelector('app-import-dialog textarea'); ta.value = ${JSON.stringify(PGN)}; ta.dispatchEvent(new Event('input', { bubbles: true }));`);
  await sleep(400);
  await shot('02-importeren');
  await click('Inlezen');
  await sleep(1500);
  await js(`ng.getComponent(document.querySelector('app-root')).store.updateSettings({ replyDelayMs: 150 });`);
  await sleep(800);
  await shot('03-trainen-aan-zet');

  for (let i = 0; i < 14; i++) {
    await playLine(i % 3 === 1 ? 1 : 0);
    await js(`const v = ng.getComponent(document.querySelector('app-train-view')); if (v.trainer.done()) v.next();`);
    await sleep(300);
  }
  await js(`const t = ${trainer}; for (let i = 0; i < 80 && !(t.attempt?.isPlayerTurn && t.attempt.correct >= 3); i++) { const a = t.attempt; if (a?.isPlayerTurn) t.move({ from: a.expected.from, to: a.expected.to }); await new Promise(r => setTimeout(r, 200)); }`);
  await shot('04-trainen-commentaar');
  await js(`${trainer}.move({ from: 'a1', to: 'a2' });`);
  await shot('05-trainen-fout');
  await js(`const t = ${trainer}; const e = t.attempt.expected; t.move({ from: e.from, to: e.to }); await new Promise(r => setTimeout(r, 600)); t.hint();`);
  await shot('06-trainen-hint');
  await js(`const t = ${trainer}; t.hint(); t.togglePeek();`);
  await shot('07-trainen-spieken');
  await playLine(0);
  await sleep(200);
  await shot('08-lijn-voltooid');

  await click('Kaart', 'nav button');
  await sleep(1200);
  await shot('09-kaart');

  await click('Repertoire', 'nav button');
  await sleep(1200);
  await shot('10-repertoire');

  await click('Statistiek', 'nav button');
  await sleep(1200);
  await shot('11-statistiek');

  await click('Verkennen', 'nav button');
  await sleep(1200);
  await js(`const d = () => document.querySelector('app-player-dialog');
    [...document.querySelectorAll('.player-chip')].find((b) => b.innerText.includes('Speler')).click();
    await new Promise((r) => setTimeout(r, 300));
    const dialog = ng.getComponent(d());
    dialog.platform.set('chesscom'); dialog.username.set('Hikaru'); dialog.max.set(100); dialog.months.set(3);
    await dialog.load();
    const v = ng.getComponent(document.querySelector('app-explorer-view'));
    v.reset(); v.play('e4'); v.play('c5');`);
  await sleep(3500);
  await shot('13-verkennen-speler');

  await js(`document.querySelector(${JSON.stringify(mobile ? '.mobile-header .icon-btn' : '.rail .rail-item.small')}).click();`);
  await sleep(600);
  await shot('12-instellingen');

  ws.close();
  chrome.kill();
  await sleep(500);
}

await session(1440, 900, false, 'desktop');
await session(390, 844, true, 'mobiel');
