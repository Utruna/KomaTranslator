const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs');
const L = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ok = 0, ko = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : ko++); L((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? ' — ' + extra : '')); };

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/prof-e2e', { headless: false, args: ['--no-sandbox', '--disable-extensions-except=/ext', '--load-extension=/ext'], viewport: { width: 760, height: 700 }, acceptDownloads: true });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  // 5 images de test
  const g = await ctx.newPage(); const imgs = [];
  for (let i = 0; i < 5; i++) {
    await g.setContent(`<body style="margin:0"><div style="width:700px;height:500px;background:#fff;display:flex;align-items:center;justify-content:center;text-align:center;font:bold 38px Arial,sans-serif;color:#000;line-height:1.3">PAGE ${i}: I WILL NOT<br>LOSE TO YOU ${'!'.repeat(i + 1)}</div></body>`);
    imgs.push(await g.screenshot({ clip: { x: 0, y: 0, width: 700, height: 500 } }));
  }
  await g.close();
  // faux serveur: page + LLM compatible OpenAI
  const S = { llm: 0, prompts: [], delay: 400 };
  const server = http.createServer((rq, rs) => {
    const m = rq.url.match(/^\/p(\d)\.png/);
    if (m) { rs.writeHead(200, { 'content-type': 'image/png' }); return rs.end(imgs[+m[1]]); }
    if (rq.url.startsWith('/v1/chat/completions')) {
      let body = ''; rq.on('data', (c) => body += c); rq.on('end', () => {
        const content = JSON.parse(body).messages[0].content; S.llm++; S.prompts.push(content);
        const items = JSON.parse(content.split('ITEMS:\n')[1]);
        const out = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, 'TR ' + String(v).slice(0, 18)]));
        setTimeout(() => { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } })); }, S.delay);
      }); return;
    }
    rs.writeHead(200, { 'content-type': 'text/html' });
    rs.end('<body style="margin:0;background:#888">' + [0, 1, 2, 3, 4].map(i => `<img class="p" src="/p${i}.png" width="700" height="500" style="display:block;margin:0 0 10px">`).join('') + '</body>');
  });
  await new Promise(r => server.listen(8099, '127.0.0.1', r));
  const URL_ = 'http://127.0.0.1:8099/';
  const cfgBase = { provider: 'openai', apiBase: 'http://127.0.0.1:8099/v1', apiKey: 'k', apiModel: 'fake', review: false, priceIn: '1', priceOut: '2', dailyCapCents: 0, profiles: {} };
  const reset = async (extraSync = {}, extraCfg = {}) => {
    await sw.evaluate(async ([s, c]) => { await chrome.storage.local.clear(); await chrome.storage.sync.clear(); await chrome.storage.sync.set(s); await chrome.storage.local.set({ cfg: c }); }, [{ sites: { '127.0.0.1': true }, src: 'auto', tgt: 'fr', siteLangs: { '127.0.0.1': { src: 'ko' } }, ...extraSync }, { ...cfgBase, ...extraCfg }]);
    await sw.evaluate(() => KomaStore.cacheClear()); S.llm = 0; S.prompts = [];
  };
  const blobs = (p) => p.evaluate(() => [...document.images].filter(i => i.src.startsWith('blob:')).length);
  const waitBlobs = async (p, n, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await blobs(p) >= n) return true; await sleep(300); } return false; };
  const openPage = async () => { const p = await ctx.newPage(); await p.goto(URL_); return p; };
  const tabId = async () => sw.evaluate(() => chrome.tabs.query({ url: 'http://127.0.0.1:8099/*' }).then(t => t[0].id));
  const openPopup = async (tid) => {
    const p = await ctx.newPage(); await p.setViewportSize({ width: 380, height: 1100 });
    await p.addInitScript((id) => { chrome.tabs.query = async () => [{ id, url: 'http://127.0.0.1:8099/' }]; }, tid);
    await p.goto(`chrome-extension://${extId}/popup.html`); await sleep(900); return p;
  };
  const usage = () => sw.evaluate(() => KomaStore.usageSummary());

  // ───── T1: langue par site, consommation, tarif saisi
  L('\nT1 — traduction, langue source par site, consommation');
  await reset();
  let page = await openPage();
  check('5 images traduites', await waitBlobs(page, 5));
  check('5 requêtes LLM', S.llm === 5, `requêtes = ${S.llm}`);
  check('langue source de ce site (coréen) envoyée au LLM', S.prompts.every(p => /from Korean/.test(p)), (S.prompts[0].match(/from \w+ into \w+/) || [])[0]);
  await sleep(500);
  let u = await usage(); const d = u.today.custom || {};
  check('jetons comptés (5 × 1000 / 5 × 200)', d.tin === 5000 && d.tout === 1000 && d.req === 5, JSON.stringify(d));
  check('pages comptées', d.pages === 5);
  check('coût = (1000×1 + 200×2)/1e6 × 5 = 0,007 $', Math.abs(d.cost - 0.007) < 1e-9, String(d.cost));
  // ───── T2: menu — progression
  L('\nT2 — menu: progression, consommation');
  const tid = await tabId();
  let pop = await openPopup(tid);
  const prog = await pop.textContent('#progress');
  check('progression « 5 / 5 images traduites »', /5 \/ 5 images traduites/.test(prog), prog);
  check('barre à 100 %', (await pop.$eval('#barFill', e => e.style.width)) === '100%');
  check('source = Coréen pour ce site', (await pop.$eval('#src', e => e.selectedOptions[0].textContent)) === 'Coréen');
  check('étiquette « Général (Auto) » et plus « Chinois »', (await pop.$eval('#src', e => e.options[0].textContent)) === 'Général (Auto)');
  check('carte consommation visible (LLM)', !(await pop.$eval('#usageCard', e => e.hidden)));
  await pop.click('#usageCard summary'); await sleep(300);
  const ub = await pop.textContent('#usageBody');
  check('consommation affichée: 5 pages, 6 k jetons, ≈ 0,70 ¢', /5 pages · 6 k jetons · ≈ 0,70 ¢/.test(ub), ub.slice(0, 120));
  await pop.screenshot({ path: '/o/e2e-popup-complet.png', fullPage: true });
  // ───── T3: voir l'original
  L('\nT3 — voir l\'original');
  const before = S.llm;
  await pop.click('#orig'); await sleep(700);
  check('images d\'origine affichées', await blobs(page) === 0);
  check('bouton « Voir la traduction »', /traduction/.test(await pop.textContent('#orig')));
  await pop.click('#orig'); await sleep(900);
  check('traduction revenue sans nouvelle requête', await blobs(page) === 5 && S.llm === before, `blobs=${await blobs(page)} requêtes+${S.llm - before}`);
  // ───── T4: retraduire une image (Alt+Maj+clic)
  L('\nT4 — Alt+Maj+clic: retraduire une image sans cache');
  const b4 = S.llm;
  await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
  await page.locator('img.p').nth(1).click({ position: { x: 20, y: 20 }, modifiers: ['Alt', 'Shift'] });
  await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
  for (let i = 0; i < 60 && !(S.llm === b4 + 1 && await blobs(page) === 5); i++) await sleep(500);
  check('une seule nouvelle requête LLM', S.llm === b4 + 1, `+${S.llm - b4}`);
  check('image de nouveau traduite', await blobs(page) === 5);
  await pop.close(); await page.close();
  // ───── T5: pause / reprise
  L('\nT5 — pause et reprise');
  await reset(); S.delay = 2500;
  page = await openPage(); await sleep(800);
  const tid5 = await tabId(); pop = await openPopup(tid5);
  await pop.click('#pause'); await sleep(2500);
  const bp = await blobs(page), lp = S.llm;
  check('après pause: pas toutes traduites', bp < 5, `traduites = ${bp}`);
  await sleep(2500);
  check('en pause: plus aucune requête', S.llm === lp, `requêtes ${lp} → ${S.llm}`);
  check('bouton « Reprendre » + texte « En pause »', /Reprendre/.test(await pop.textContent('#pause')) && /En pause/.test(await pop.textContent('#progress')));
  await pop.click('#pause');
  check('reprise: tout est traduit', await waitBlobs(page, 5, 30000));
  await pop.close(); await page.close();
  // ───── T6: mode économie
  L('\nT6 — mode économie');
  await reset({ eco: true }); S.delay = 300;
  page = await openPage(); await sleep(6000);
  const be = await blobs(page);
  check('économie: seulement ce qui est proche de l\'écran', be >= 1 && be <= 3, `traduites = ${be} sur 5, requêtes = ${S.llm}`);
  await page.evaluate(() => scrollTo(0, 3000)); await sleep(800);
  check('en défilant, le reste est traduit', await waitBlobs(page, 5, 30000));
  await page.close();
  // ───── T7: plafond de dépense
  L('\nT7 — plafond de dépense');
  await reset({}, { dailyCapCents: 0.3 }); S.delay = 300;
  page = await openPage(); await waitBlobs(page, 5, 90000); await sleep(1500);
  check('plafond: le LLM s\'arrête après 3 requêtes (la 3e est permise: 0,28 ¢ < 0,3 ¢)', S.llm === 3, `requêtes = ${S.llm}`);
  const us = await usage(); const sess = await sw.evaluate(() => chrome.storage.session.get('komaLastError'));
  L('   diag plafond: coût du jour =', JSON.stringify(us.today), '| requêtes serveur =', S.llm, '| blobs =', await blobs(page));
  check('message « Plafond du jour atteint » dans l\'état', /Plafond du jour atteint/.test(sess.komaLastError || ''), (sess.komaLastError || '').slice(0, 80));
  pop = await openPopup(await tabId()); await pop.click('#usageCard summary'); await sleep(300);
  check('le menu signale le plafond', /Plafond atteint/.test(await pop.textContent('#usageBody')));
  await pop.close(); await page.close();
  // ───── T8: mémoire — export / import / annulation
  L('\nT8 — mémoire: export, import, annulation');
  await reset();
  await sw.evaluate(async () => { await chrome.storage.local.set({
    'series:a.com/x': { key: 'a.com/x', wiki: 'https://w.org/x', summary: 'résumé A', glossary: [{ src: 'Xiao Yan', orig: '', tgt: 'Xiao Yan', type: '', note: '' }], corrections: { t: 'ma version' }, history: [['h', 'i']] },
    'series:b.com/y': { key: 'b.com/y', wiki: '', summary: '', glossary: [], corrections: {}, history: [] } }); });
  const mp = await ctx.newPage(); const dialogs = []; mp.on('dialog', d => { dialogs.push(d.message().split('\n')[0]); d.accept(); });
  await mp.goto(`chrome-extension://${extId}/memoire.html`); await sleep(900);
  const dl = mp.waitForEvent('download');
  await mp.click('#exportAll'); const download = await dl;
  const path = '/o/export.json'; await download.saveAs(path);
  const exp = JSON.parse(fs.readFileSync(path, 'utf8'));
  check('export: 2 séries, app KomaTranslator', exp.app === 'KomaTranslator' && exp.series.length === 2);
  check('export: ni clé API ni historique', !JSON.stringify(exp).includes('"apiKey"') && !('history' in exp.series[0]));
  // suppression + annulation
  await mp.locator('.serie', { hasText: 'a.com/x' }).getByText('Supprimer la série').click(); await sleep(700);
  check('série supprimée', (await mp.$$eval('.serie b', e => e.map(x => x.textContent))).join() === 'b.com/y');
  check('bouton Annuler affiché', await mp.locator('#msg button').count() === 1);
  await mp.click('#msg button'); await sleep(700);
  const restored = await sw.evaluate(() => chrome.storage.local.get('series:a.com/x').then(r => r['series:a.com/x']));
  check('annulation: série restaurée telle quelle (historique compris)', restored?.summary === 'résumé A' && restored.history.length === 1 && restored.corrections.t === 'ma version');
  // import: fichier avec une série nouvelle, une existante enrichie
  const imp = { app: 'KomaTranslator', version: 1, series: [
    { key: 'a.com/x', summary: 'importé', glossary: [{ src: 'Lin Dong', tgt: 'Lin Dong' }], corrections: { t: 'autre', u: 'v' } },
    { key: 'n.com/z', glossary: [{ src: 'A', tgt: 'B' }] }, { nokey: 1 }] };
  fs.writeFileSync('/o/import.json', JSON.stringify(imp));
  await mp.setInputFiles('#importFile', '/o/import.json'); await sleep(900);
  const msg = await mp.textContent('#msg');
  check('import: 1 ajoutée, 1 fusionnée, 1 ignorée', /1 série ajoutée.*1 fusionnée.*1 ignorée/.test(msg), msg.slice(0, 80));
  const a = await sw.evaluate(() => chrome.storage.local.get('series:a.com/x').then(r => r['series:a.com/x']));
  check('import: glossaire fusionné, corrections locales gardées, résumé gardé', a.glossary.length === 2 && a.corrections.t === 'ma version' && a.corrections.u === 'v' && a.summary === 'résumé A');
  await mp.click('#msg button'); await sleep(900);
  const keys = (await mp.$$eval('.serie b', e => e.map(x => x.textContent))).sort().join();
  const a2 = await sw.evaluate(() => chrome.storage.local.get('series:a.com/x').then(r => r['series:a.com/x']));
  check('annuler l\'import: série nouvelle retirée, existante rétablie', keys === 'a.com/x,b.com/y' && a2.glossary.length === 1 && !a2.corrections.u, keys);
  await mp.screenshot({ path: '/o/e2e-memoire.png', fullPage: true });
  // consommation dans l'écran mémoire
  await sw.evaluate(() => KomaStore.usageAdd('deepseek', { req: 2, tin: 3000, tout: 400, pages: 2, cost: 0.0007 }));
  await mp.reload(); await sleep(800);
  check('détail de consommation affiché', /deepseek|Total/.test(await mp.textContent('#usageTable')) || /Total/.test(await mp.textContent('#usageTable')));
  L(`\nRÉSULTAT: ${ok} réussis, ${ko} échecs`);
  server.close(); await ctx.close(); process.exit(ko ? 1 : 0);
})().catch(e => { console.log('ERREUR', e.stack?.split('\n').slice(0, 4).join(' | ')); process.exit(2); });
