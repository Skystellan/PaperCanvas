import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function pdfNavigationSmoke({ wc, dataDirectory, evaluate, until }) {
  const click = (label) => evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
  const query = (value) => evaluate(`(() => {
    const input = document.querySelector('.pdf-findbar input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(`!!document.querySelector('[aria-label="跳转：Results"]')`, 'real PDF outline');
  await click('固定 PDF 目录');
  await click('跳转：Results');
  await until(`document.querySelector('.pdf-viewer__toolbar').textContent.includes('3 /')`, 'outline destination');
  await evaluate(`[...document.querySelectorAll('.pdf-outline button')].find(b=>b.textContent==='收藏本页').click()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.pdf-outline button')].some(b=>b.textContent==='★ 第 3 页')`), true);
  await writeFile(path.join(dataDirectory, 'pdf-outline.png'), (await wc.capturePage()).toPNG());
  await click('固定 PDF 目录');
  await evaluate(`document.activeElement?.blur()`);
  wc.focus();
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: ['meta'] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'f', modifiers: ['meta'] });
  await until(`document.activeElement === document.querySelector('.pdf-findbar input')`, 'native Cmd+F');
  await query('page 13');
  await until(`document.querySelector('.pdf-findbar__count').textContent === '1 / 1' && document.querySelector('.pdf-viewer__toolbar').textContent.includes('13 /')`, 'search across unrendered pages');
  await until(`!!document.querySelector('.textLayer .highlight.selected')`, 'visible search highlight');
  await writeFile(path.join(dataDirectory, 'pdf-search.png'), (await wc.capturePage()).toPNG());
  await query('zoom fixture');
  await until(`document.querySelector('.pdf-findbar__count').textContent.endsWith('/ 20')`, 'all search results');
  const before = await evaluate(`document.querySelector('.pdf-findbar__count').textContent`);
  await click('下一个匹配');
  await until(`document.querySelector('.pdf-findbar__count').textContent !== ${JSON.stringify(before)}`, 'next match');
  await click('上一个匹配');
  await until(`document.querySelector('.pdf-findbar__count').textContent === ${JSON.stringify(before)}`, 'previous match');
  await query('not-present-in-this-pdf');
  await until(`document.querySelector('.pdf-findbar__count').textContent === '无匹配'`, 'empty search result');
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(`!document.querySelector('.pdf-findbar') && !document.querySelector('.textLayer .highlight')`, 'escape clears search');
  await click('跳转：Introduction');
  await until(`document.querySelector('.pdf-viewer__toolbar').textContent.includes('1 /')`, 'return to introduction');
}
