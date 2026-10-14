'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { X509Certificate, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { WebSocket } = require('ws');
const { fixture, client, mutation, tls, root } = require('./helpers.cjs');
const evidence = path.join(root, 'evidence');
const browserPath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = path.join(root, 'browser-profile');
let app, chrome, cdp, outsider;
const passed = [], errors = [];
async function poll(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(50); }
  throw new Error('Browser condition timed out');
}
(async () => {
  app = await fixture({ items: 3 });
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const spki = createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const log = fs.openSync(path.join(evidence, 'chrome.log'), 'w');
  chrome = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--disk-cache-dir=${path.join(profile, 'cache')}`, '--disable-background-networking', '--disable-sync',
    '--disable-crash-reporter', '--no-first-run', '--no-default-browser-check', '--password-store=basic',
    `--ignore-certificate-errors-spki-list=${spki}`, 'about:blank'], { stdio: ['ignore', log, log] });
  fs.closeSync(log);
  await poll(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')));
  const [port] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  cdp = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await once(cdp, 'open');
  let id = 0; const calls = new Map();
  cdp.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.id) { const call = calls.get(msg.id); calls.delete(msg.id); if (call) msg.error ? call.reject(new Error(JSON.stringify(msg.error))) : call.resolve(msg.result); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.source === 'security') errors.push(msg.params.entry.text);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { calls.set(++id, { resolve, reject }); cdp.send(JSON.stringify({ id, method, params })); });
  const run = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const value = selector => run(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const put = text => run(`document.querySelector('#paste-box').value=${JSON.stringify(text)};document.querySelector('#paste-box').dispatchEvent(new Event('input'));`);
  const waitText = (selector, text) => poll(async () => (await value(selector)).includes(text));
  await call('Runtime.enable'); await call('Page.enable'); await call('Log.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__sockets=[]; window.__dropAcks=false; window.__copyFail=false; window.__copies=[];
    const Native=window.WebSocket;
    window.WebSocket=class extends Native {
      constructor(...args) { super(...args); window.__sockets.push(this);
        this.addEventListener('message', event => { if(window.__dropAcks && JSON.parse(event.data).type==='ack') event.stopImmediatePropagation(); });
      }
    };
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText: async text => {
      if(window.__deferCopy) return new Promise((resolve,reject)=>window.__copyReject=reject);
      if(window.__copyFail) throw new DOMException('Test denial','NotAllowedError'); window.__copies.push(text);
    }}});
  ` });
  await call('Emulation.setDeviceMetricsOverride', { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: app.origin }); await waitText('#status-text', 'Connected');
  assert.equal(await run('window.isSecureContext'), true);
  passed.push('TLS page and real WebSocket connect with CSP');
  const observer = client(app); const { session } = await observer.next('init');
  const original = '  <img src=x onerror="window.__injected=true">\n\tHello 🙂\n';
  await put(original); await click('#send-btn'); await waitText('#delivery-status', 'accepted');
  assert.equal(await run("document.querySelector('#paste-box').value"), '');
  const first = await observer.next('add'); assert.equal(first.clip.text, original);
  await click('.clip-select'); assert.equal(await value('#viewer'), original);
  assert.equal(await run('window.__injected === undefined'), true);
  await click('#copy-btn'); assert.equal(await run('window.__copies.at(-1)'), original);
  passed.push('Exact text, acknowledgement, DOM injection protection and copy request');
  const duplicate = mutation(session, 'add', { text: original }); observer.send(duplicate);
  const duplicateAck = await observer.next('ack');
  await poll(() => run(`document.querySelector('.clip-select[aria-pressed="true"]')?.dataset.id === ${JSON.stringify(duplicateAck.clipId)}`));
  await click('#copy-btn'); assert.equal(await run('window.__copies.at(-1)'), original);
  passed.push('Selected duplicate follows the new ID and still copies visible text');
  await run('window.__copyFail=true'); await click('#copy-btn'); await waitText('#delivery-status', 'Clipboard access failed');
  assert.equal(await run(`(()=>{const field=document.querySelector('#manual-copy');return field.value.slice(field.selectionStart,field.selectionEnd)})()`), original);
  await run('window.__copyFail=false');
  passed.push('Clipboard rejection selects exact text and gives manual-copy instructions');
  await run('window.__deferCopy=true'); await click('#copy-btn');
  const remove = mutation(session, 'delete', { id: duplicateAck.clipId }); observer.send(remove);
  await poll(() => run("document.querySelector('#copy-btn').hidden"));
  passed.push('Remote deletion clears the viewer and Copy button');
  await run("window.__copyReject(new DOMException('Test denial','NotAllowedError'));window.__deferCopy=false");
  await waitText('#delivery-status','selected clip changed');
  assert.equal(await run("document.querySelector('#manual-copy').hidden"),true);
  passed.push('Delayed clipboard failure cannot restore a deleted clip');

  await run('window.__dropAcks=true'); await put('ack loss fixture'); await click('#send-btn');
  await waitText('#delivery-status', 'not confirmed');
  assert.equal(await run("document.querySelector('#paste-box').value"), 'ack loss fixture');
  const before = observer.messages.filter(msg => msg.type === 'add').length;
  await run('window.__dropAcks=false'); await click('#send-btn'); await waitText('#delivery-status', 'accepted');
  assert.equal(observer.messages.filter(msg => msg.type === 'add').length, before);
  passed.push('Lost acknowledgement keeps draft; retry does not repeat the broadcast');

  await run('window.__dropAcks=true'); await put('old pending draft'); await click('#send-btn');
  await put('newer draft'); await waitText('#delivery-status', 'not confirmed');
  await run('window.__dropAcks=false'); await click('#send-btn'); await waitText('#delivery-status', 'accepted');
  assert.equal(await run("document.querySelector('#paste-box').value"), 'newer draft');
  passed.push('Acknowledgement never clears text edited after submission');

  await click('.clip-select');
  await run('window.__sockets.at(-1).close()'); await waitText('#status-text', 'Reconnecting');
  assert.equal(await run("document.querySelector('#copy-btn').hidden"), true);
  await waitText('#status-text', 'Connected');
  assert.equal(await run("document.querySelector('#paste-box').value"), 'newer draft');
  passed.push('Reconnect clears stale selection and retains unsent draft');
  await click('.clip-select');
  for (let n = 0; n < 3; n++) {
    const add = mutation(session, 'add', { text: `eviction ${n}` }); observer.send(add); await observer.next('ack', msg => msg.requestId === add.requestId);
  }
  await poll(() => run("document.querySelector('#copy-btn').hidden"));
  passed.push('Eviction removes stale selection');
  await click('.clip-select'); observer.send(mutation(session, 'clear'));
  await poll(() => run("document.querySelectorAll('.clip-select').length===0 && document.querySelector('#copy-btn').hidden"));
  passed.push('Remote clear removes list, selection and Copy button');

  await run('window.__dropAcks=true'); await put('restart pending draft'); await click('#send-btn');
  await observer.next('add', msg => msg.clip.text === 'restart pending draft');
  const oldPort = app.port; await app.close(); app = await fixture({ items: 3 }, oldPort);
  await waitText('#delivery-status', 'server restarted'); await waitText('#status-text', 'Connected');
  assert.equal(await run("document.querySelector('#paste-box').value"), 'restart pending draft');
  assert.equal(await run("document.querySelectorAll('.clip-select').length"), 0);
  await run('window.__dropAcks=false');
  passed.push('Restart retains pending draft without automatic replay or reused selection');

  for (const [width, height, mobile, name] of [[1365, 900, false, 'desktop'], [390, 844, true, 'mobile'], [844, 390, true, 'mobile-landscape']]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await delay(100);
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, name + ' horizontal overflow');
    const bounds = await run(`['#paste-box','#send-btn','#status-text'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {s,x:r.x,y:r.y,right:r.right,bottom:r.bottom}})`);
    for (const rect of bounds) assert.ok(rect.x >= 0 && rect.y >= 0 && rect.right <= width + 1 && rect.bottom <= height + 1, name + JSON.stringify(rect));
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(shot.data, 'base64'));
    passed.push(name + ' controls fit viewport');
  }
  assert.deepEqual(errors, []);
  passed.push('No JavaScript exceptions or CSP violations during app tests');

  outsider = https.createServer(tls, (_, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Foreign origin test</title>'); });
  outsider.listen(0, '127.0.0.1'); await once(outsider, 'listening');
  await call('Page.navigate', { url: `https://127.0.0.1:${outsider.address().port}` });
  await poll(() => run("document.title==='Foreign origin test'"));
  const result = await run(`new Promise(resolve=>{const socket=new WebSocket('wss://127.0.0.1:${app.port}/ws');socket.onopen=()=>resolve('opened');socket.onmessage=()=>resolve('leaked');socket.onerror=()=>resolve('blocked');})`);
  assert.equal(result, 'blocked'); passed.push('Actual foreign browser origin cannot open the clipboard WebSocket');
  fs.writeFileSync(path.join(evidence, 'browser-results.json'), JSON.stringify({ browser: await call('Browser.getVersion'), passed, errors, clipboard: 'Write API is stubbed; no system clipboard data is accessed.' }, null, 2));
  console.log(passed.map(item => 'PASS ' + item).join('\n'));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.close();
  if (chrome) { const stopped = once(chrome, 'exit'); chrome.kill('SIGTERM'); await stopped; }
  if (app) await app.close();
  if (outsider) { outsider.closeAllConnections(); await new Promise(resolve => outsider.close(resolve)); }
});
