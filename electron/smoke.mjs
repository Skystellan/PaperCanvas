import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { clipboard, ClipboardItem } from 'electron';

// Fresh database and chat profile. PDF defaults to synthetic content; an explicit
// PAPERCANVAS_SMOKE_PDF path imports a copy for local performance measurements.
function pdfFixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  const pageCount = process.env.PAPERCANVAS_PERFORMANCE === '1' ? 150 : 20;
  for (let page = 0; page < pageCount; page++) {
    const pageId = objects.length + 1;
    kids.push(`${pageId} 0 R`);
    let content = `BT /F1 12 Tf 40 740 Td (PaperCanvas zoom fixture - page ${page + 1}) Tj\n` +
      Array.from({ length: 45 }, (_, i) => `0 -15 Td (Line ${i + 1}: text selection and zoom remain responsive.) Tj`).join('\n') + '\nET';
    if (page === 0) content += '\nBT /F1 20 Tf 410 680 Td (E = mc) Tj /F1 11 Tf 65 10 Td (2) Tj ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  const outlineId = objects.length + 1;
  objects[0] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineId} 0 R >>`;
  objects.push(
    `<< /Type /Outlines /First ${outlineId + 1} 0 R /Last ${outlineId + 2} 0 R /Count 2 >>`,
    `<< /Title (Introduction) /Parent ${outlineId} 0 R /Next ${outlineId + 2} 0 R /Dest [${kids[0]} /Fit] >>`,
    `<< /Title (Results) /Parent ${outlineId} 0 R /Prev ${outlineId + 1} 0 R /Dest [${kids[2]} /Fit] >>`,
  );
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
}

export async function smoke({ window, backend, chats, dataDirectory, chatSession }) {
  assert.match(dataDirectory, /papercanvas-smoke-/);
  // Real mouse/trackpad input must not mix with the scripted input schedule.
  window.setIgnoreMouseEvents(true);
  const wc = window.webContents;
  const evaluate = (script) => wc.executeJavaScript(script).catch((error) => {
    throw new Error(`${script.slice(0, 90)}: ${error.message}`);
  });
  const errors = [];
  wc.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  async function until(script, label) {
    const deadline = Date.now() + 20_000;
    do {
      if (await evaluate(script)) return;
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}; renderer errors: ${errors.join('; ')}`);
  }
  await until('!!window.paperCanvas', 'preload');
  if (process.env.PAPERCANVAS_WHITEBOARD_SMOKE === '1') {
    const reload = async () => { const ready = once(wc, 'did-finish-load'); wc.reload(); await ready; };
    await until(`!!document.querySelector('.react-flow__node[data-id="node-attention"]')`, 'canvas fixture');
    await backend.call('database_execute', {
      query: 'INSERT INTO board_edges(id,board_id,source_node_id,target_node_id,created_at) VALUES(?,?,?,?,?)',
      values: ['drag-smoke-edge', 'board-default', 'node-attention', 'node-bert', 1],
    });
    await reload();
    await until(`!!document.querySelector('.react-flow__edge[data-testid="rf__edge-drag-smoke-edge"]')`, 'connected canvas fixture');
    const { whiteboardDragSmoke, whiteboardDomainSmoke, whiteboardEdgeSmoke } = await import('./whiteboard-drag-smoke.mjs');
    await whiteboardDragSmoke({ wc, backend, dataDirectory, evaluate, until, reload });
    await whiteboardDomainSmoke({ wc, backend, dataDirectory, evaluate, until, reload });
    await whiteboardEdgeSmoke({ wc, backend, dataDirectory, evaluate, until, reload });
    return;
  }
  // Missing grants must fail even when the caller is the trusted renderer.
  assert.equal(await evaluate(`window.paperCanvas.invoke('import_pdf', {sourcePath:'/ungranted.pdf'}).then(()=>false,()=>true)`), true);
  const source = process.env.PAPERCANVAS_SMOKE_PDF || path.join(dataDirectory, 'Zoom fixture.pdf');
  if (!process.env.PAPERCANVAS_SMOKE_PDF) await writeFile(source, pdfFixture());
  const paper = await backend.call('import_pdf', { sourcePath: source });
  if (process.env.PAPERCANVAS_LIVE_CHAT === '1') {
    console.log('Chat proxy:', await chatSession.resolveProxy('https://chatgpt.com/'));
    chatSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === 'mainFrame') console.log('Chat response:', JSON.stringify({status:details.statusCode,host:new URL(details.url).host,challenge:details.responseHeaders['cf-mitigated']}));
      callback({});
    });
    chatSession.webRequest.onErrorOccurred(details => console.log('Chat request failure:', JSON.stringify({error:details.error,host:new URL(details.url).host,type:details.resourceType})));
  }
  let challengePage = false;
  let requests = 0;
  if (process.env.PAPERCANVAS_LIVE_CHAT !== '1') chatSession.protocol.handle('https', () => {
    requests++;
    return challengePage
      ? new Response('<!doctype html><title>请稍候…</title>', { status:403, headers:{ 'Content-Type':'text/html', 'cf-mitigated':'challenge' } })
      : new Response('<!doctype html><title>Chat fixture</title><p>Local test page</p><textarea aria-label="draft"></textarea>', { headers: { 'Content-Type': 'text/html' } });
  });
  const chat = await backend.call('save_paper_web_chat', { paperId: paper.id, title: 'Chat fixture' });
  const loaded = once(wc, 'did-finish-load');
  wc.reload();
  await loaded;
  await until(`!!document.querySelector('button[aria-label^="Open Chat fixture"]')`, 'recent discussion');
  await evaluate(`document.querySelector('button[aria-label^="Open Chat fixture"]').click()`);
  await until(`!!document.querySelector('.pdfViewer .page canvas')?.width`, 'real PDF.js render');
  const zoom = await evaluate(`(async () => {
    const label = () => [...document.querySelectorAll('.pdf-viewer__toolbar span')].map(e=>e.textContent).find(t=>t.endsWith('%'));
    const before = label();
    const button = document.querySelector('button[aria-label="Zoom in"]');
    const start = performance.now();
    for (let i=0;i<6;i++) button.click();
    const dispatchMs = performance.now()-start;
    await new Promise(resolve => setTimeout(resolve,700));
    const after = label();
    const pages = document.querySelector('.pdf-viewer__pages');
    const bounds = pages.getBoundingClientRect();
    for(let i=0;i<12;i++) pages.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-2,deltaMode:0,clientX:bounds.left+200,clientY:bounds.top+200,bubbles:true,cancelable:true}));
    await new Promise(resolve => setTimeout(resolve,700));
    return {before,after,pinch:label(),dispatchMs,pages:document.querySelectorAll('.pdfViewer .page').length,text:!!document.querySelector('.textLayer span')};
  })()`);
  if (process.env.PAPERCANVAS_SMOKE_PDF) assert.ok(zoom.pages > 0);
  else assert.equal(zoom.pages, process.env.PAPERCANVAS_PERFORMANCE === '1' ? 150 : 20);
  assert.notEqual(zoom.after, zoom.before);
  assert.notEqual(zoom.pinch, zoom.after);
  assert.deepEqual([zoom.before, zoom.after, zoom.pinch], ['100%', '210%', '267%']);
  assert.equal(zoom.text, true);
  await writeFile(path.join(dataDirectory, 'pdf-zoom.png'), (await wc.capturePage()).toPNG());
  if (process.env.PAPERCANVAS_PERFORMANCE === '1') {
    const { measurePdfZoom } = await import('./pdf-performance-smoke.mjs');
    await measurePdfZoom(wc, dataDirectory);
    return;
  }

  // Intercept only this isolated test profile's remote protocol. No live web requests.
  const bounds = { x: 600, y: 100, width: 500, height: 600 };
  await chats.layout(chat.id, bounds);
  const guest = chats.views.get(chat.id).webContents;
  if (process.env.PAPERCANVAS_LIVE_CHAT === '1') {
    for (let attempt=0; attempt<4; attempt++) {
      await delay(5000);
      const state = await guest.executeJavaScript('({visibility:document.visibilityState,ready:document.readyState,text:document.body?.innerText.slice(0,200)})');
      if (state.text || attempt === 3) {
        const report = { title:guest.getTitle(), loading:guest.isLoading(), state };
        console.log('Live chat:', JSON.stringify(report));
        await writeFile(path.join(dataDirectory,'live-chat.json'), JSON.stringify(report,null,2));
        assert.ok(state.text, 'ChatGPT returned a blank page; inspect live-chat.json for the current site/network result.');
        assert.equal(chats.loadStates.get(chat.id)?.status, 'ready');
        break;
      }
    }
    return;
  }
  if (guest.isLoading()) await once(guest, 'did-finish-load');
  assert.equal(await guest.executeJavaScript('typeof window.paperCanvas'), 'undefined');
  assert.equal(await guest.executeJavaScript('typeof require'), 'undefined');
  assert.equal(guest.getLastWebPreferences().sandbox, true);
  // Exercise Chromium's clipboard permission and native paste, not a mocked API.
  const previousClipboard = await Promise.all((await clipboard.read()).map(async item =>
    new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))),
  ));
  try {
    window.focus();
    guest.focus();
    await guest.executeJavaScript(`navigator.clipboard.writeText('PaperCanvas clipboard fixture')`, true);
    await guest.executeJavaScript(`document.querySelector('textarea').focus()`);
    guest.paste();
    for (let i=0; i<30 && await guest.executeJavaScript(`document.querySelector('textarea').value`) !== 'PaperCanvas clipboard fixture'; i++) await delay(50);
    assert.equal(await guest.executeJavaScript(`document.querySelector('textarea').value`), 'PaperCanvas clipboard fixture');
    await guest.executeJavaScript(`window.pastedImage=false; document.addEventListener('paste',event=>{window.pastedImage=[...event.clipboardData.items].some(item=>item.type==='image/png')},{once:true})`);
    const png = (await guest.capturePage({ x: 0, y: 0, width: 1, height: 1 })).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    guest.paste();
    for (let i=0; i<30 && !(await guest.executeJavaScript('window.pastedImage')); i++) await delay(50);
    assert.equal(await guest.executeJavaScript('window.pastedImage'), true);
  } finally { await clipboard.write(previousClipboard); }
  await guest.executeJavaScript(`document.querySelector('textarea').value='Draft survives switching'`);
  const guestId = guest.id;
  await chats.layout(chat.id, null);
  await chats.layout(chat.id, bounds);
  assert.equal(chats.views.get(chat.id).webContents.id, guestId);
  assert.equal(await guest.executeJavaScript(`document.querySelector('textarea').value`), 'Draft survives switching');
  // A completed HTTP challenge is not a ready chat. Retrying must issue a new
  // page request, retain the session, and clear the notice when loading succeeds.
  challengePage = true;
  const challengeLoaded = once(guest, 'did-finish-load');
  await evaluate(`window.paperCanvas.invoke('reload_paper_web_chat',{id:${JSON.stringify(chat.id)}})`);
  await challengeLoaded;
  await until(`!!document.querySelector('.web-chat-login-help')?.textContent.includes('网站验证')`, 'verification status');
  assert.equal(chats.loadStates.get(chat.id).status, 'verification');
  const failedRequestCount = requests;
  challengePage = false;
  const recovered = once(guest, 'did-finish-load');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='重试加载').click()`);
  await recovered;
  await until(`!document.querySelector('.web-chat-login-help')`, 'recovered load status');
  assert.ok(requests > failedRequestCount);
  assert.equal(chats.views.get(chat.id).webContents.id, guestId);
  // Exercise both popup and same-window sign-in, without requesting Google or
  // carrying OAuth state from the guest into a separate browser session.
  for (const script of [
    `window.open('https://accounts.google.com/o/oauth2/v2/auth?state=fixture')`,
    `location.href='https://accounts.google.com/o/oauth2/v2/auth?state=fixture'`,
  ]) {
    await guest.executeJavaScript(script);
    await until(`!!document.querySelector('.web-chat-login-help')`, 'Google login help');
    assert.equal(guest.getURL(), 'https://chatgpt.com/');
    assert.equal(await evaluate(`document.querySelector('.web-chat-login-help').textContent.includes('不会同步')`), true);
    await writeFile(path.join(dataDirectory, 'google-login-help.png'), (await wc.capturePage()).toPNG());
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent==='关闭提示').click()`);
  }
  const { workspaceSmoke } = await import('./workspace-smoke.mjs');
  const workspace = await workspaceSmoke({ wc, backend, paper, dataDirectory, evaluate, until, chats, chat });
  const report = { workspace, chromium: process.versions.chrome, electron: process.versions.electron, pdf: zoom, chatClipboard: { copy: true, pasteText: true, pasteImage: true }, guestReused: true, remoteHasNoBridge: true, googleLoginHandoff: true, verificationRetryRecovered: true, errors };
  await writeFile(path.join(dataDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.deepEqual(errors, [], 'Native workflows should not produce renderer errors');
}
