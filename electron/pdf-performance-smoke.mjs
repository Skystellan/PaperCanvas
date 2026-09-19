import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Measure the real renderer, including layout work, under the same input schedule.
// Run with PAPERCANVAS_PERFORMANCE=1 node electron/run-smoke.mjs.
export async function measurePdfZoom(contents, directory) {
  contents.debugger.attach('1.3');
  await contents.debugger.sendCommand('Performance.enable');
  const metrics = async () => Object.fromEntries((await contents.debugger.sendCommand('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  const results = {};
  try {
    for (const kind of ['pinch', 'buttons']) {
      const before = await metrics();
      const result = await contents.executeJavaScript(`(async () => {
        const container = document.querySelector('.pdf-viewer__pages');
        const viewer = container.querySelector('.pdfViewer');
        const bounds = container.getBoundingClientRect();
        const frames = [];
        let previous = performance.now();
        const start = previous;
        let scaleChanges = 0;
        let layoutScale = viewer.style.getPropertyValue('--scale-factor');
        const observer = new MutationObserver(() => {
          const next = viewer.style.getPropertyValue('--scale-factor');
          if (next !== layoutScale) { scaleChanges++; layoutScale = next; }
        });
        observer.observe(viewer, { attributes: true, attributeFilter: ['style'] });
        for (let i = 0; i < 90; i++) {
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          frames.push(now - previous);
          previous = now;
          if (${JSON.stringify(kind)} === 'pinch') {
            for (let j = 0; j < 4; j++) container.dispatchEvent(new WheelEvent('wheel', {
              ctrlKey:true, deltaY:i < 45 ? -0.4 : 0.4, deltaMode:0,
              clientX:bounds.left + bounds.width / 2, clientY:bounds.top + bounds.height / 2,
              bubbles:true, cancelable:true,
            }));
          } else if (i % 3 === 0) {
            document.querySelector('button[aria-label="Zoom ' + (i % 6 === 0 ? 'in' : 'out') + '"]').click();
          }
        }
        observer.disconnect();
        const gestureMs = performance.now() - start;
        const scaleDuring = [...document.querySelectorAll('.pdf-viewer__toolbar span')].map(e => e.textContent).find(t => t.endsWith('%'));
        await new Promise(resolve => setTimeout(resolve, 700));
        const sorted = frames.slice(1).sort((a,b) => a-b);
        return {
          gestureMs, p50FrameMs: sorted[Math.floor(sorted.length * .5)],
          p95FrameMs: sorted[Math.floor(sorted.length * .95)], maxFrameMs: Math.max(...sorted),
          over25ms: sorted.filter(ms => ms > 25).length, layoutScaleChangesDuringGesture: scaleChanges,
          scaleDuring, pageCount: viewer.querySelectorAll('.page').length,
          textSelectable: !!viewer.querySelector('.textLayer span'),
          transformAfterSettle: viewer.style.transform,
        };
      })()`);
      const after = await metrics();
      for (const key of ['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration']) result[`${key}Ms`] = (after[key] - before[key]) * 1000;
      assert.equal(result.textSelectable, true);
      assert.equal(result.transformAfterSettle, '', `${kind}: ${JSON.stringify(result)}`);
      results[kind] = result;
    }
    results.anchor = await contents.executeJavaScript(`(async () => {
      const container = document.querySelector('.pdf-viewer__pages');
      const page = container.querySelector('.page[data-page-number="2"]');
      container.scrollTop = page.offsetTop + 300;
      await new Promise(resolve => setTimeout(resolve, 500));
      const bounds = container.getBoundingClientRect();
      const x = bounds.left + container.clientWidth / 2;
      const y = bounds.top + container.clientHeight / 2;
      const target = document.elementFromPoint(x, y).closest('.page');
      const rect = target.getBoundingClientRect();
      const px = (x-rect.left)/rect.width, py = (y-rect.top)/rect.height;
      const location = () => { const r = target.getBoundingClientRect(); return { x:r.left+px*r.width, y:r.top+py*r.height }; };
      for (let i=0;i<15;i++) {
        container.dispatchEvent(new WheelEvent('wheel', { ctrlKey:true, deltaY:-2, deltaMode:0, clientX:x,clientY:y,bubbles:true,cancelable:true }));
        await new Promise(requestAnimationFrame);
      }
      await new Promise(requestAnimationFrame);
      const preview = location();
      await new Promise(resolve => setTimeout(resolve,700));
      const settled = location();
      const span = target.querySelector('.textLayer span');
      let selected = '';
      if (span) {
        const range = document.createRange(); range.selectNodeContents(span);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        selected = selection.toString(); selection.removeAllRanges();
      }
      return { previewDrift:Math.hypot(preview.x-x,preview.y-y), settleDrift:Math.hypot(settled.x-preview.x,settled.y-preview.y), selectedTextLength:selected.length };
    })()`);
    assert.ok(results.anchor.previewDrift < 2, `Preview anchor moved: ${JSON.stringify(results.anchor)}`);
    assert.ok(results.anchor.settleDrift < 2, `Commit anchor moved: ${JSON.stringify(results.anchor)}`);
    assert.ok(results.anchor.selectedTextLength > 0);
    await writeFile(path.join(directory, 'pdf-settled.png'), (await contents.capturePage()).toPNG());
    await writeFile(path.join(directory, 'pdf-performance.json'), JSON.stringify(results, null, 2));
    console.log('PDF performance:', JSON.stringify(results));
    return results;
  } finally { contents.debugger.detach(); }
}
