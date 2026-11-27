// Chat: tapping a photo opens the in-app viewer with every photo of the
// conversation — swipe (phone) / arrows and ← → (computer) / thumbnails move
// between them, the count follows, Back / ✕ closes; nothing opens in a new tab.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const fs = require('fs');
const B = process.env.BASE || 'http://localhost:3200';
const OUT = process.argv[2] || '/tmp';
const IMGS = process.env.IMGS || '/tmp/claude-0/imgs';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const PASS = 'Chat#2026pass';
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const SA = (await login('admin@credence.test', 'ProbePass123')).token;
  const tag = Date.now().toString(36).slice(-5);
  const dept = Number(sql('SELECT MIN(id) FROM departments'));
  const person = async (name) => {
    const email = `${name}.${tag}@credence.test`;
    const e = await (await fetch(B + '/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SA }, body: JSON.stringify({ name: `${name} ${tag}`, designation: 'Engineer', department_id: dept, joining_date: '2024-01-01', email, create_login: true, login_email: email, login_password: PASS }) })).json();
    const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${e.id}`));
    sql(`UPDATE users SET must_change_password=0, can_use_chat=1 WHERE id=${uid}`);
    return { uid, email, a: await login(email, PASS) };
  };
  const A = await person('photosender'), Bb = await person('photoviewer');
  const room = await (await fetch(B + '/api/chat/rooms', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + A.a.token }, body: JSON.stringify({ type: 'direct', memberIds: [Bb.uid] }) })).json();
  for (const c of ['red', 'green', 'blue']) {
    const qs = new URLSearchParams({ messageType: 'image', filename: `${c}.png`, mimetype: 'image/png' });
    const r = await fetch(B + `/api/chat/rooms/${room.id}/messages?${qs}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer ' + A.a.token }, body: fs.readFileSync(`${IMGS}/${c}.png`) });
    if (!r.ok) console.log('send failed', r.status, await r.text());
  }
  await fetch(B + `/api/chat/rooms/${room.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + A.a.token }, body: JSON.stringify({ content: 'three photos' }) }).catch(() => {});

  const b = await chromium.launch();
  const open = async (who, phone) => {
    const ctx = await b.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); }, [who.a.token, who.a.user]);
    const p = await ctx.newPage(); p.errs = []; p.popups = 0;
    p.on('pageerror', (x) => p.errs.push(String(x))); ctx.on('page', () => p.popups++);
    await p.addLocatorHandler(p.getByText('How do you like the app?'), async () => { await p.getByRole('button', { name: 'Later' }).click(); });
    await p.goto(B + '/'); await p.waitForTimeout(6500);
    await p.evaluate((id) => window.dispatchEvent(new CustomEvent('credence:open-chat-room', { detail: { roomId: id } })), room.id);
    await p.waitForTimeout(4000);
    return p;
  };
  const centerColor = (p) => p.evaluate(() => {
    const img = [...document.querySelectorAll('[data-testid="chat-viewer-track"] img')].find((i) => { const r = i.getBoundingClientRect(); return r.left >= -5 && r.right <= innerWidth + 5 && r.width > 50; });
    if (!img) return null;
    const c = document.createElement('canvas'); c.width = 4; c.height = 4; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 4, 4);
    const [r, g, bl] = x.getImageData(2, 2, 1, 1).data; return r > 200 ? 'red' : g > 100 ? 'green' : bl > 200 ? 'blue' : `${r},${g},${bl}`;
  });

  // Phone: tap the 2nd photo, swipe both ways, thumbnails, Back.
  let p = await open(Bb, true);
  const photos = p.getByTestId('chat-photo').filter({ visible: true });
  ok((await photos.count()) === 3, 'phone: three photos in the conversation');
  await photos.nth(1).click(); await p.waitForTimeout(900);
  const viewer = p.getByRole('dialog', { name: 'Photo viewer' });
  ok(await viewer.isVisible(), 'tap a photo: the viewer opens in the app');
  ok((await p.getByTestId('chat-viewer-count').innerText()).trim() === '2 / 3', 'starts at the tapped photo: 2 / 3');
  ok((await centerColor(p)) === 'green', 'shows the green (2nd) photo');
  await p.screenshot({ path: `${OUT}/chat-viewer-phone.png` }).catch(() => {});
  const swipe = async (dx) => {
    await p.evaluate((dx) => {
      const el = document.querySelector('[data-testid="chat-viewer-track"]').parentElement;
      const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(200)], changedTouches: [t(200)], bubbles: true }));
      for (let i = 1; i <= 6; i++) el.dispatchEvent(new TouchEvent('touchmove', { touches: [t(200 + (dx * i) / 6)], changedTouches: [t(200 + (dx * i) / 6)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(200 + dx)], bubbles: true }));
    }, dx);
    await p.waitForTimeout(700);
  };
  await swipe(-160);
  ok((await p.getByTestId('chat-viewer-count').innerText()).trim() === '3 / 3' && (await centerColor(p)) === 'blue', 'swipe left: next photo (3 / 3, blue)');
  await swipe(160); await swipe(160);
  ok((await p.getByTestId('chat-viewer-count').innerText()).trim() === '1 / 3' && (await centerColor(p)) === 'red', 'swipe right twice: back to the first (1 / 3, red)');
  await viewer.getByRole('button', { name: 'Show this photo' }).nth(2).click(); await p.waitForTimeout(700);
  ok((await p.getByTestId('chat-viewer-count').innerText()).trim() === '3 / 3', 'thumbnail: jumps to that photo');
  ok(await viewer.getByRole('button', { name: 'Download' }).isVisible(), 'Download button');
  await viewer.getByRole('button', { name: 'Close' }).click(); await p.waitForTimeout(500);
  ok(!(await viewer.isVisible()), '✕ closes the viewer, the chat stays');
  ok(p.popups === 0, 'nothing opened in a new tab');
  ok(p.errs.length === 0, 'phone: no page errors ' + JSON.stringify(p.errs));
  await p.context().close();

  // Computer: arrows and keyboard.
  p = await open(Bb, false);
  await p.getByTestId('chat-photo').filter({ visible: true }).first().click(); await p.waitForTimeout(800);
  ok((await p.getByTestId('chat-viewer-count').innerText()).trim() === '1 / 3', 'computer: opens at 1 / 3');
  ok((await p.getByRole('button', { name: 'Previous photo' }).count()) === 0, 'no "previous" on the first photo');
  await p.getByRole('button', { name: 'Next photo' }).click(); await p.waitForTimeout(600);
  ok((await p.getByTestId('chat-viewer-count').innerText()).trim() === '2 / 3', 'next arrow: 2 / 3');
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(600);
  ok((await p.getByTestId('chat-viewer-count').innerText()).trim() === '3 / 3' && (await centerColor(p)) === 'blue', '→ key: 3 / 3');
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(600);
  ok((await p.getByTestId('chat-viewer-count').innerText()).trim() === '2 / 3', '← key: 2 / 3');
  await p.screenshot({ path: `${OUT}/chat-viewer-desktop.png` }).catch(() => {});
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  ok(!(await p.getByRole('dialog', { name: 'Photo viewer' }).isVisible()), 'Esc closes');
  ok(p.popups === 0 && p.errs.length === 0, 'computer: no new tab, no page errors ' + JSON.stringify(p.errs));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
