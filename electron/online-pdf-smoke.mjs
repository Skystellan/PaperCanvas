import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pdfFixture } from './smoke.mjs';

// Synthetic network content only. The normal app always uses its ephemeral
// Electron session; this injector is selected exclusively by the smoke launcher.
export function createOnlinePdfFixture() {
  const fixture = {
    bytes: Buffer.from(pdfFixture()), requests: 0, mode: 'ok',
    async fetchPdf(url) {
      assert.match(String(url), /^https:\/\/arxiv\.org\/pdf\/1706\.03762v1$/);
      fixture.requests++;
      if (fixture.mode === 'unavailable') throw new Error('Synthetic offline network');
      const bytes = fixture.mode === 'changed' ? Buffer.concat([fixture.bytes, Buffer.from('\n% updated PDF\n')]) : fixture.bytes;
      return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length) } });
    },
  };
  return fixture;
}

export async function onlinePdfSmoke({ wc, backend, dataDirectory, evaluate, until, fixture }) {
  await until(`document.querySelectorAll('.paper-card').length > 0`, 'board ready');
  const command = request => backend.call('workspace_command', { request, origin: 'online-smoke' });
  const title = 'Online PDF smoke';
  const pdfFiles = async () => (await readdir(path.join(dataDirectory, 'papers')).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })).filter(name => name.endsWith('.pdf'));
  const before = await pdfFiles();
  const imported = (await command({ type: 'import_research_batch', batch: {
    requestId: 'online-pdf-smoke', title: 'Online reading candidates',
    papers: [{ ref: 'a', title, url: 'https://arxiv.org/abs/1706.03762v1', arxivId: '1706.03762', reason: 'Read only when opened.' }],
  } })).value;
  const id = imported.placements[0].paperId;
  const getPaper = async () => (await command({ type: 'get_paper', id })).value;
  const count = async () => (await backend.call('database_select', { query: 'SELECT COUNT(*) AS n FROM papers', values: [] }))[0].n;
  const total = await count();
  const initialNote = await backend.call('load_markdown_note', { paperId: id });
  await backend.call('save_markdown_note', { paperId: id, content: 'Keep the candidate notes', expected: initialNote });
  await backend.call('database_execute', { query: 'INSERT INTO pdf_highlights(id,paper_id,page_number,selected_text,comment,rects_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    values: ['online-highlight', id, 1, 'Existing annotation', 'Keep this annotation', '[{"left":0.1,"top":0.1,"width":0.2,"height":0.02}]', 1, 1] });
  const open = async (local = false) => {
    const label = local ? title : `${title}（无本地 PDF）`;
    await until(`!!document.querySelector('button[aria-label="${label}"]')`, 'candidate in library');
    await evaluate(`document.querySelector('button[aria-label="${label}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  };
  const back = async () => {
    await evaluate(`document.querySelector('[aria-label="Back to canvas"]').click()`);
    await until(`!document.querySelector('.paper-reader')`, 'canvas after reading');
  };
  const rendered = () => until(`!!document.querySelector('.pdfViewer .page canvas')?.width`, 'online PDF.js canvas');
  const click = text => evaluate(`[...document.querySelectorAll('.research-pdf button')].find(button => button.textContent === ${JSON.stringify(text)}).click()`);

  assert.equal(fixture.requests, 0, 'Importing a paper must never fetch a PDF');
  await open(); await rendered();
  assert.equal(await evaluate(`[...document.querySelectorAll('.research-pdf__toolbar button')].every(button => {
    const style = getComputedStyle(button); return style.color !== style.backgroundColor;
  })`), true, 'Toolbar labels must remain visible with the system dark appearance');
  assert.equal(fixture.requests, 1);
  assert.equal((await getPaper()).filePath, null);
  assert.deepEqual(await pdfFiles(), before, 'Preview writes no permanent or temporary PDF to the library');
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="PDF 目录与书签"]')`), true);
  assert.equal(await evaluate(`document.querySelector('[aria-label="搜索 PDF"]').disabled`), false);
  await evaluate(`document.querySelector('[aria-label="固定 PDF 目录"]').click()`);
  await evaluate(`[...document.querySelectorAll('.pdf-outline button')].find(button => button.textContent === '收藏本页').click()`);
  const bookmarkKey = `paper-pdf-bookmarks:v1:papers/${id}.pdf`;
  const bookmark = await evaluate(`localStorage.getItem(${JSON.stringify(bookmarkKey)})`);
  assert.ok(bookmark.includes('1'));
  await writeFile(path.join(dataDirectory, 'online-reading.png'), (await wc.capturePage()).toPNG());
  await click('初筛信息');
  await until(`!!document.querySelector('[aria-label="论文初筛信息"]')`, 'metadata tab');
  await click('PDF'); await rendered();
  assert.equal(fixture.requests, 1, 'Switching to metadata reuses the open document');
  await back();

  fixture.mode = 'changed';
  await open();
  await until(`document.querySelector('.research-pdf__loading [role="alert"]')?.textContent.includes('ONLINE_PDF_CHANGED')`, 'changed PDF blocked');
  assert.equal(await evaluate(`!!document.querySelector('.pdfViewer .page canvas')`), false, 'Old highlights must not be displayed over changed bytes');
  assert.equal((await getPaper()).filePath, null);
  await back();
  fixture.mode = 'ok';
  await open(); await rendered();
  await click('保存离线');
  await until(`document.querySelector('.research-pdf__toolbar')?.textContent.includes('已保存离线')`, 'explicit offline save');
  const saved = await getPaper();
  assert.equal(saved.filePath, `papers/${id}.pdf`);
  assert.equal(await count(), total);
  assert.deepEqual(await readFile(path.join(dataDirectory, saved.filePath)), fixture.bytes);
  assert.equal((await command({ type: 'load_board' })).value.nodes.find(node => node.paper.id === id).id, imported.placements[0].nodeId);
  await back();

  const requests = fixture.requests;
  fixture.mode = 'unavailable';
  await open(true); await rendered();
  assert.equal(fixture.requests, requests, 'Saved documents must open offline without a network attempt');
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(bookmarkKey)})`), bookmark);
  const notes = await backend.call('load_markdown_note', { paperId: id });
  assert.ok(JSON.stringify(notes).includes('Keep the candidate notes'));
  const highlights = await backend.call('database_select', { query: 'SELECT id,comment FROM pdf_highlights WHERE paper_id=?', values: [id] });
  assert.deepEqual(highlights, [{ id: 'online-highlight', comment: 'Keep this annotation' }]);
  await writeFile(path.join(dataDirectory, 'offline-reading.png'), (await wc.capturePage()).toPNG());
  const report = { importDoesNotFetch: true, memoryPreview: true, pdfJsReader: true, metadataSwitch: true,
    changedPdfBlocked: true, explicitOfflineSave: true, samePaperAndNode: true, notesHighlightsBookmarksPreserved: true, offlineWithoutNetwork: true };
  await writeFile(path.join(dataDirectory, 'online-pdf-report.json'), JSON.stringify(report, null, 2));
  console.log('Online PDF:', JSON.stringify(report));
}
