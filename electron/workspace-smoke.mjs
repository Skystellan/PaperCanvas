import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Exercises the changed workflows against the real renderer and a disposable DB.
export async function workspaceSmoke({ wc, backend, paper, dataDirectory, evaluate, until, chats, chat }) {
  const byLabel = (label) => `document.querySelector('[aria-label=${JSON.stringify(label)}]')`;
  const click = (label) => evaluate(`${byLabel(label)}.click()`);
  const textButton = (text) => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const setText = (selector, text) => evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const reload = async () => { const ready = once(wc, 'did-finish-load'); wc.reload(); await ready; };
  const openPaper = () => evaluate(`${byLabel(paper.title)}.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`);

  const setDiagram = async (source) => {
    if (await evaluate(`document.querySelector('.paper-mind-map__composer')?.hidden`)) await textButton('Edit source');
    await setText('textarea[aria-label="Markdown source"]', source);
  };

  // More options must occupy local layout space rather than sit behind the native chat view.
  await click('更多对话操作');
  await until(`!!document.querySelector('.web-chat-options')`, 'chat options');
  await until(`(() => {
    const options = document.querySelector('.web-chat-options').getBoundingClientRect();
    const slot = document.querySelector('.web-chat-browser').getBoundingClientRect();
    return slot.top >= options.bottom;
  })()`, 'chat options above browser slot');
  const optionBottom = await evaluate(`document.querySelector('.web-chat-options').getBoundingClientRect().bottom`);
  // ResizeObserver forwards the new bounds over IPC after the renderer commits.
  for (let attempt = 0; attempt < 30 && chats.views.get(chat.id).getBounds().y < optionBottom - 1; attempt++) await delay(100);
  assert.ok(chats.views.get(chat.id).getBounds().y >= optionBottom - 1, 'Native chat must not cover its action menu');
  assert.equal(await evaluate(`!!${byLabel('复制论文信息')}`), true);
  await writeFile(path.join(dataDirectory, 'chat-menu.png'), (await wc.capturePage()).toPNG());
  await click('Back to canvas');
  await until(`!document.querySelector('.paper-reader')`, 'canvas return');

  await backend.call('database_execute', { query: 'INSERT INTO board_nodes(id,board_id,paper_id,x,y,width,height) VALUES(?,?,?,?,?,?,?)', values: ['smoke-paper-node','board-default',paper.id,500,450,280,128] });
  await backend.call('database_execute', { query: 'INSERT INTO board_edges(id,board_id,source_node_id,target_node_id,created_at) VALUES(?,?,?,?,?)', values: ['smoke-edge','board-default','smoke-paper-node','node-attention',1] });
  await reload();
  await until(`!!document.querySelector('.react-flow__edge[data-testid="rf__edge-smoke-edge"]')`, 'test canvas connection');
  assert.equal(await evaluate(`document.querySelector('.recent-discussions').classList.contains('is-collapsed')`), false);
  assert.equal(await evaluate(`!!${byLabel(`移动 ${paper.title} 到领域`)}`), false);
  await click(`${paper.title} 的更多操作`);
  assert.equal(await evaluate(`!!${byLabel(`移动 ${paper.title} 到领域`)}`), true);
  await click(`${paper.title} 的更多操作`);
  const widthBefore = await evaluate(`document.querySelector('.paper-library').getBoundingClientRect().width`);
  await evaluate(`${byLabel('调整论文库宽度')}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  const widthAfter = await evaluate(`document.querySelector('.paper-library').getBoundingClientRect().width`);
  assert.ok(widthAfter > widthBefore, 'Library resize handle changes its width');

  await evaluate(`document.querySelector('.react-flow__edge[data-testid="rf__edge-smoke-edge"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await until(`!!document.querySelector('[aria-label="连线解释与证据"]')`, 'connection editor');
  await setText('.whiteboard__edge-editor textarea[placeholder="这两篇论文为什么相关？"]', 'Supports the comparison');
  await setText('.whiteboard__edge-editor textarea[placeholder="摘录、来源或页码"]', 'Paper 1, page 3, Table 1');
  // Navigation, rather than a Save click, must preserve edited evidence.
  await openPaper();
  await until(`!!document.querySelector('.pdfViewer .page canvas')?.width`, 'reader opened from library');
  const savedEdge = await backend.call('database_select', { query: 'SELECT explanation,evidence FROM board_edges WHERE id=?', values:['smoke-edge'] });
  assert.deepEqual(savedEdge, [{ explanation:'Supports the comparison', evidence:'Paper 1, page 3, Table 1' }]);
  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='Notes').click()`);
  assert.equal(await evaluate(`document.querySelector('.paper-reader__title').textContent.includes('Metadata unavailable')`), false);
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="Search highlights"]')`), false);
  assert.equal(await evaluate(`document.querySelector('.paper-reader__highlights').getBoundingClientRect().height < 70`), true);
  await until(`document.querySelector('.markdown-note') && !document.querySelector('.paper-reader__note-error')`, 'notes ready');

  const zoomPercent = `[...document.querySelectorAll('.pdf-viewer__toolbar span')].find(s=>s.textContent.endsWith('%'))?.textContent`;
  for (let step=0; step<25; step++) {
    const before = await evaluate(zoomPercent);
    if (Number.parseInt(before) <= 110) break;
    await click('Zoom out');
    await until(`${zoomPercent} !== ${JSON.stringify(before)}`, 'zoom preview changed');
  }

  // Select adjacent baseline/superscript symbols in the synthetic PDF.
  await until(`[...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].some(s=>s.textContent==='E = mc')`, 'formula text');
  const formula = await evaluate(`(() => {
    const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')];
    const base = spans.find(s=>s.textContent==='E = mc');
    const exponent = spans.slice(spans.indexOf(base)+1).find(s=>s.textContent==='2');
    const range = document.createRange(); range.setStart(base.firstChild,0); range.setEnd(exponent.firstChild,1);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const count = range.getClientRects().length;
    base.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    base.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
    return { count };
  })()`);
  await until(`!!document.querySelector('[aria-label="PDF selection tools"]')`, 'annotation popover');
  assert.equal(await evaluate(`document.querySelector('[aria-label="PDF selection tools"]').textContent.includes('Ask AI')`), false);
  await textButton('Save annotation');
  await until(`!!document.querySelector('[aria-label="Add highlight from page 1 to notes"]')`, 'saved annotation');
  const savedHighlights = await backend.call('database_select', { query:'SELECT rects_json FROM pdf_highlights WHERE paper_id=?', values:[paper.id] });
  assert.equal(savedHighlights.length, 1);
  assert.ok(JSON.parse(savedHighlights[0].rects_json).length < formula.count, 'Formula glyphs merge into a background');
  await click('Add highlight from page 1 to notes');
  await evaluate(`[...document.querySelectorAll('.markdown-note summary')].find(s=>s.textContent==='View').click()`);
  await textButton('Read');
  await until(`!!document.querySelector('.markdown-note__preview a[href^="#paper="]')`, 'source-linked note');
  await click('Next page');
  await until(`document.querySelector('.pdf-viewer__toolbar').textContent.includes('2 /')`, 'page two');
  await evaluate(`document.querySelector('.markdown-note__preview a[href^="#paper="]').click()`);
  await until(`document.querySelector('.pdf-viewer__toolbar').textContent.includes('1 /')`, 'citation returns to source');
  await writeFile(path.join(dataDirectory, 'formula-annotation.png'), (await wc.capturePage()).toPNG());

  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='Mind map').click()`);
  await until(`!!document.querySelector('textarea[aria-label="Markdown source"]')`, 'Markdown editor');
  const markdown = '# 论文研究\n## 研究问题与已有方法的局限\n- 为什么需要这个研究\n- 现有方法缺少的证据\n## 方法设计\n- 关键假设\n- 实验步骤\n## 数据来源\n- 样本选择\n- 质量控制\n## 实验结果\n- 基线比较\n- 消融实验\n## 研究结论\n- 主要贡献\n- 后续方向';
  await setDiagram('```markdown\n' + markdown + '\n```');
  await textButton('Render preview');
  await until(`document.querySelectorAll('.markmap-node').length >= 16 && document.querySelector('.markmap-node')?.getBoundingClientRect().width > 0`, 'interactive Markdown map');
  await until(`document.querySelector('.paper-mind-map__interactive svg > g')?.getBBox().height > document.querySelector('.paper-mind-map__interactive svg > g')?.getBBox().width`, 'portrait left-to-right map');
  await writeFile(path.join(dataDirectory, 'markmap-preview.png'), (await wc.capturePage()).toPNG());
  const markmapNodes = await evaluate(`document.querySelectorAll('.markmap-node').length`);
  const fold = `(() => {
    const branch = [...document.querySelectorAll('.markmap-node')].find(g => g.__data__.state.depth === 2 && g.__data__.children?.length);
    branch.querySelector('circle').dispatchEvent(new MouseEvent('click',{bubbles:true}));
  })()`;
  await evaluate(fold);
  await until(`document.querySelectorAll('.markmap-node').length < ${markmapNodes}`, 'Markmap branch folds');
  await evaluate(fold);
  await until(`document.querySelectorAll('.markmap-node').length === ${markmapNodes}`, 'Markmap branch expands');
  const mapScale = await evaluate(`document.querySelector('.paper-mind-map__interactive svg').__zoom.k`);
  await evaluate(`document.querySelector('.paper-mind-map__interactive [aria-label="Zoom in"]').click()`);
  await until(`document.querySelector('.paper-mind-map__interactive svg').__zoom.k > ${mapScale}`, 'Markmap zoom control');
  await textButton('Fit');
  await setDiagram('mindmap\n  Preserved old Mermaid source');
  await textButton('Render preview');
  await until(`!!document.querySelector('.paper-mind-map__error')`, 'old source kept with conversion guidance');
  assert.equal(await evaluate(`document.querySelectorAll('.markmap-node').length`), markmapNodes);
  await setDiagram(markdown);
  await textButton('Render preview');
  await until(`!document.querySelector('.paper-mind-map__error') && document.querySelector('.paper-mind-map__composer').hidden`, 'Markdown preview restored');
  await click('Next page');
  await click('Next page');
  await until(`document.querySelector('.pdf-viewer__toolbar').textContent.includes('3 /')`, 'reading location page three');
  await evaluate(`document.querySelector('.pdf-viewer__pages').scrollTop += 200`);
  await until(`JSON.parse(localStorage.getItem('paper-reader:v1:${paper.id}')).location.offset > 0.1`, 'within-page reading offset saved');
  const readingLocation = await evaluate(`JSON.parse(localStorage.getItem('paper-reader:v1:${paper.id}')).location`);
  await click('Back to canvas');
  await until(`!document.querySelector('.paper-reader')`, 'saved and returned');
  const maps = await backend.call('database_select', { query:'SELECT source FROM paper_mermaid_maps WHERE paper_id=?', values:[paper.id] });
  assert.equal(maps[0].source, markdown);
  await openPaper();
  await until(`!!document.querySelector('.pdfViewer .page canvas')?.width`, 'restored PDF rendered');
  await until(`document.querySelector('.pdf-viewer__toolbar')?.textContent.includes('3 /')`, 'reading position restored');
  const restoredOffset = await evaluate(`(() => {
    const container = document.querySelector('.pdf-viewer__pages').getBoundingClientRect();
    const page = document.querySelector('.page[data-page-number="3"]').getBoundingClientRect();
    return (container.top - page.top) / page.height;
  })()`);
  assert.ok(Math.abs(restoredOffset - readingLocation.offset) < 0.02, 'PDF restores within-page offset');
  assert.equal(await evaluate(zoomPercent), `${Math.round(readingLocation.zoom * 100)}%`);
  await until(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === 'Mind map'`, 'reader workspace restored');
  await until(`document.querySelectorAll('.markmap-node').length === ${markmapNodes}`, 'saved Markdown restored');
  await click('Back to canvas');
  await until(`!document.querySelector('.paper-reader')`, 'canvas before deletions');

  await evaluate(`document.querySelector('.react-flow__edge[data-testid="rf__edge-smoke-edge"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await until(`!!document.querySelector('[aria-label="连线解释与证据"]')`, 'selected edge before delete');
  await evaluate(`document.activeElement?.blur(); document.querySelector('.whiteboard').dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}))`);
  await until(`!document.querySelector('.react-flow__edge[data-testid="rf__edge-smoke-edge"]')`, 'keyboard deletes connection');
  await click(paper.title);
  await until(`!!document.querySelector('.react-flow__node[data-id="smoke-paper-node"].selected')`, 'library locates selected card');
  await textButton('从白板移除选中卡片');
  await until(`!document.querySelector('.react-flow__node[data-id="smoke-paper-node"]')`, 'remove card');
  assert.equal((await backend.call('database_select', { query:'SELECT id FROM papers WHERE id=?', values:[paper.id] })).length, 1);
  assert.equal((await backend.call('database_select', { query:'SELECT id FROM board_nodes WHERE id=?', values:['smoke-paper-node'] })).length, 0);
  await reload();
  await until(`!!document.querySelector('.paper-library') && !!document.querySelector('.react-flow__node')`, 'workspace reload');
  assert.equal(await evaluate(`document.querySelector('.paper-library').getBoundingClientRect().width`), widthAfter);
  assert.equal(await evaluate(`!!document.querySelector('.react-flow__node[data-id="smoke-paper-node"]')`), false);
  await writeFile(path.join(dataDirectory, 'compact-library.png'), (await wc.capturePage()).toPNG());
  await openPaper();
  await until(`document.querySelector('.pdf-viewer__toolbar')?.textContent.includes('3 /')`, 'reading location survives renderer restart');
  await until(`document.querySelectorAll('.markmap-node').length === ${markmapNodes}`, 'mind map survives renderer restart');
  return { libraryResize:true, directReading:true, edgeEvidence:true, formulaBackground:true, sourceCitation:true, markmapPortrait:true, markmapFold:true, readingRestored:true, canvasDeletionPreservesPaper:true };
}
