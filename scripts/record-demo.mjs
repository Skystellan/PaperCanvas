// Run with node after building. Uses the real app, an isolated sample library,
// scripted pointer input, and recording-only captions/cursor. Requires ffmpeg.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/media');

async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `${command} failed`);
}

if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const directory = await mkdtemp(path.join(tmpdir(), 'papercanvas-demo-'));
  console.log(`Isolated demo and frames: ${directory}`);
  await mkdir(output, { recursive: true });
  const env = { ...process.env, PAPERCANVAS_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PAPERCANVAS_SMOKE;
  await run(electron, ['scripts/record-demo.mjs'], { env });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-f', 'concat', '-safe', '0',
    '-i', path.join(directory, 'frames.txt'), '-vf', 'setpts=PTS/2,fps=24', '-c:v', 'libx264', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(output, 'paper-network-demo.mp4')]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-y', '-i', path.join(output, 'paper-network-demo.mp4'),
    '-filter_complex', 'fps=12,scale=1080:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop', '0', path.join(output, 'paper-network-demo.gif')]);
  console.log(`Demo ready: ${output}`);
} else {
  // Electron waits for its ESM entry to finish before resolving app readiness.
  void record();
}

async function record() {
  const { app, BrowserWindow } = await import('electron');
  const directory = process.env.PAPERCANVAS_DATA_DIR;
  assert.ok(directory && path.basename(directory).startsWith('papercanvas-demo-'), 'Use a fresh demo profile');
  await import('../electron/main.mjs');
  const timeout = setTimeout(() => { console.error('Demo timed out'); app.exit(1); }, 120_000);
  try {
    let window;
    for (let attempt = 0; attempt < 200; attempt++) {
      window = BrowserWindow.getAllWindows()[0];
      if (window?.webContents.getURL() && !window.webContents.isLoading()) break;
      await delay(50);
    }
    assert.ok(window, 'The app opened');
    window.setContentSize(1440, 900);
    window.setIgnoreMouseEvents(true);
    const wc = window.webContents;
    const evaluate = script => wc.executeJavaScript(script);
    async function until(script) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(script)) return;
        await delay(50);
      }
      throw new Error(`Not ready: ${script}`);
    }
    const invoke = (command, args) => evaluate(`window.paperCanvas.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
    const sql = (query, values = []) => invoke('database_execute', { query, values });
    await until(`document.querySelectorAll('.react-flow__node').length === 3`);
    await sql('DELETE FROM board_nodes');
    await sql('DELETE FROM papers');
    for (const [id, name] of [['models', 'Language models'], ['tuning', 'Efficient tuning']]) {
      await sql('INSERT INTO paper_domains(id,name,created_at,updated_at) VALUES(?,?,1,1)', [id, name]);
    }
    const papers = [
      ['attention', 'Attention Is All You Need', 'models', 60, 200],
      ['bert', 'BERT: Pre-training of Deep Bidirectional Transformers', 'models', 410, 20],
      ['gpt3', 'Language Models are Few-Shot Learners', 'models'],
      ['lora', 'LoRA: Low-Rank Adaptation of Large Language Models', 'tuning', 1050, 30],
      ['qlora', 'QLoRA: Efficient Finetuning of Quantized LLMs', 'tuning', 1050, 440],
    ];
    await mkdir(path.join(directory, 'papers'));
    const pdfObjects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>'];
    let pdf = '%PDF-1.4\n';
    const offsets = pdfObjects.map((object, i) => { const offset = pdf.length; pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
    const xref = pdf.length;
    pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    for (const [index, [id, title, domain, x, y]] of papers.entries()) {
      const file = path.join(directory, 'papers', `${id}.pdf`);
      await writeFile(file, pdf);
      await sql('INSERT INTO papers(id,title,domain_id,created_at,file_path) VALUES(?,?,?,?,?)', [id, title, domain, 10 - index, file]);
      if (x !== undefined) await sql('INSERT INTO board_nodes(id,board_id,paper_id,x,y,width,height) VALUES(?,?,?,?,?,280,128)',
        [id, 'board-default', id, x, y]);
    }
    for (const [source, target] of [['attention', 'bert'], ['bert', 'lora'], ['lora', 'qlora']]) {
      await sql('INSERT INTO board_edges(id,board_id,source_node_id,target_node_id,relation_type,created_at) VALUES(?,?,?,?,?,1)',
        [`${source}-${target}`, 'board-default', source, target, source === 'bert' ? null : 'support']);
    }
    await evaluate(`localStorage.setItem('paper-library-width','270')`);
    const loaded = once(wc, 'did-finish-load'); wc.reload(); await loaded;
    await until(`document.querySelectorAll('.react-flow__node').length === 4`);
    await evaluate(`document.querySelector('[aria-label="Hide recent discussions"]').click()`);
    // Captions and a visible cursor are presentation overlays, never shipped in the app.
    await evaluate(`(() => {
      const style = document.createElement('style');
      style.textContent = '#root{height:calc(100% - 108px);margin-top:108px} #demo-caption{position:fixed;inset:0 0 auto;height:108px;padding:20px 32px;background:#101c31;color:white;display:flex;align-items:center;justify-content:space-between;font-family:-apple-system,BlinkMacSystemFont,sans-serif;z-index:9999} #demo-en{font-size:27px;font-weight:650;letter-spacing:-.6px} #demo-zh{font-size:16px;color:#acbdd8;margin-top:7px} #demo-brand{text-align:right;font-size:19px;font-weight:650} #demo-brand small{display:block;font-size:11px;letter-spacing:1.5px;font-weight:400;color:#9cb1ce;margin-top:8px} #demo-cursor{position:fixed;left:0;top:0;width:28px;height:34px;z-index:10000;pointer-events:none;filter:drop-shadow(0 2px 2px #17294455)} #demo-cursor.pressed{filter:drop-shadow(0 0 8px #3984ff)}';
      document.head.append(style);
      const caption = document.createElement('div'); caption.id='demo-caption';
      caption.innerHTML='<div><div id="demo-en"></div><div id="demo-zh"></div></div><div id="demo-brand">PaperCanvas<small>YOUR PAPERS. YOUR NETWORK.</small></div>';
      document.body.append(caption);
      const cursor = document.createElement('div'); cursor.id='demo-cursor';
      cursor.innerHTML='<svg viewBox="0 0 28 34"><path d="M3 2 L3 26 L9 20 L15 31 L20 28 L14 18 L24 18 Z" fill="white" stroke="#172944" stroke-width="1.8" stroke-linejoin="round"/></svg>';
      document.body.append(cursor);
    })()`);
    const caption = (en, zh) => evaluate(`document.querySelector('#demo-en').textContent=${JSON.stringify(en)};document.querySelector('#demo-zh').textContent=${JSON.stringify(zh)}`);
    let pointer = { x: 800, y: 800 };
    async function move(to, duration = 600, held = false) {
      const from = { ...pointer };
      for (let step = 1; step <= Math.ceil(duration / 25); step++) {
        const t = step / Math.ceil(duration / 25), eased = t * t * (3 - 2 * t);
        pointer = { x: Math.round(from.x + (to.x - from.x) * eased), y: Math.round(from.y + (to.y - from.y) * eased) };
        wc.sendInputEvent({ type: 'mouseMove', ...pointer, ...(held ? { button: 'left', modifiers: ['leftbuttondown'] } : {}) });
        await evaluate(`document.querySelector('#demo-cursor').style.transform='translate(${pointer.x}px,${pointer.y}px)';document.querySelector('#demo-drag-preview')?.style.setProperty('transform','translate(${pointer.x + 20}px,${pointer.y + 20}px)')`);
        await delay(25);
      }
    }
    async function press(type) {
      wc.sendInputEvent({ type, ...pointer, button: 'left', clickCount: 1 });
      await evaluate(`document.querySelector('#demo-cursor').classList.toggle('pressed',${type === 'mouseDown'})`);
    }
    const center = selector => evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    async function click(selector) {
      await move(await center(selector)); await press('mouseDown'); await delay(130); await press('mouseUp'); await delay(300);
    }
    const nodeSelector = id => `.react-flow__node[data-id="${id}"]`;
    await caption('Drag papers. Connect ideas.', '拖动论文，构建属于自己的研究网络');
    await delay(700);
    await evaluate(`document.querySelector('[aria-label="Fit View"]').click()`);
    await delay(700);
    const frames = [];
    let recording = true;
    const capture = (async () => {
      while (recording) {
        const time = performance.now();
        const name = path.join(directory, `${String(frames.length).padStart(5, '0')}.png`);
        await writeFile(name, (await wc.capturePage()).resize({ width: 1440 }).toPNG());
        frames.push({ name, time });
        await delay(Math.max(0, 50 - (performance.now() - time)));
      }
    })();
    try {
      await delay(1600);
      await caption('01 / Drop a paper into your canvas', '从论文库拖入画布，按自己的思路组织');
      await move(await center('.paper-library__item[aria-label^="Language Models are Few-Shot"]'));
      const drop = await evaluate(`(() => {
        const viewport=document.querySelector('.react-flow__viewport');
        const r=document.querySelector('.react-flow').getBoundingClientRect();
        const m=new DOMMatrix(getComputedStyle(viewport).transform);
        return {x:Math.round(r.x+m.e+410*m.a),y:Math.round(r.y+m.f+420*m.a)};
      })()`);
      // Replay HTML5 drag events through the library/canvas handlers; macOS native
      // drag sessions do not finish reliably with webContents.sendInputEvent.
      await evaluate(`(() => {
        window.demoDrag = new DataTransfer();
        const source=document.querySelector('.paper-library__item[aria-label^="Language Models are Few-Shot"]');
        source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.demoDrag}));
        document.querySelector('#demo-cursor').classList.add('pressed');
        const preview=source.cloneNode(true); preview.id='demo-drag-preview';
        preview.style.cssText='position:fixed;left:0;top:0;width:245px;z-index:9999;pointer-events:none;opacity:.9;background:white;border:1px solid #66a0ff;border-radius:12px;box-shadow:0 8px 28px #27477725;transform:translate(${pointer.x + 20}px,${pointer.y + 20}px)';
        document.body.append(preview);
      })()`);
      assert.equal(await evaluate(`window.demoDrag.getData('application/papercanvas-paper')`), 'gpt3');
      await move(drop, 1400);
      await evaluate(`(() => {
        const target=document.querySelector('.react-flow');
        for(const type of ['dragenter','dragover','drop']) target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,clientX:${drop.x},clientY:${drop.y},dataTransfer:window.demoDrag}));
        document.querySelector('.paper-library__item[aria-label^="Language Models are Few-Shot"]').dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window.demoDrag}));
        document.querySelector('#demo-cursor').classList.remove('pressed');
        document.querySelector('#demo-drag-preview').remove();
        delete window.demoDrag;
      })()`);
      await until(`document.querySelectorAll('.react-flow__node').length === 5`);
      const [added] = await invoke('database_select', { query: "SELECT id FROM board_nodes WHERE paper_id='gpt3'", values: [] });
      await delay(1400);
      await caption('02 / Connect the ideas that matter', '点选两篇论文，建立你理解的关系');
      await click('[aria-label="连线模式"]');
      await click(nodeSelector('attention'));
      await click(nodeSelector(added.id));
      await until(`document.querySelectorAll('.react-flow__edge').length === 4`);
      await click(nodeSelector('bert'));
      await click(nodeSelector(added.id));
      await until(`document.querySelectorAll('.react-flow__edge').length === 5`);
      await click('[aria-label="连线模式"]');
      await delay(1500);
      await caption('03 / Move a paper. Let the network follow.', '拖动节点，连线与分区平滑跟随');
      const beforeDrag = await center(nodeSelector(added.id));
      await move(await center(nodeSelector(added.id)));
      const start = { ...pointer };
      await press('mouseDown');
      await move({ x: start.x + 110, y: start.y + 65 }, 1800, true);
      await delay(350);
      await move({ x: start.x + 45, y: start.y - 30 }, 1400, true);
      await press('mouseUp');
      await move({ x: 1340, y: 835 }, 500);
      await delay(4500);
      const afterDrag = await center(nodeSelector(added.id));
      assert.ok(Math.hypot(afterDrag.x - beforeDrag.x, afterDrag.y - beforeDrag.y) > 10, 'The recorded drag moved a real card');
      await click('[aria-label="Fit View"]');
      await caption('Your reading. Your connections. Your canvas.', '让论文之间的关系，一目了然');
      await move({ x: 1350, y: 850 }, 600);
      await delay(2300);
      await writeFile(path.join(output, 'paper-network-poster.png'), (await wc.capturePage()).resize({ width: 1440 }).toPNG());
      const [counts] = await invoke('database_select', { query: 'SELECT (SELECT COUNT(*) FROM board_nodes) AS nodes, (SELECT COUNT(*) FROM board_edges) AS edges', values: [] });
      assert.deepEqual(counts, { nodes: 5, edges: 5 }, 'Demo actions persisted real cards and connections');
      assert.equal(await evaluate(`document.querySelectorAll('[role="alert"]').length`), 0, 'No visible errors in the demo');
      console.log('Verified demo:', JSON.stringify(counts));
    } finally {
      recording = false; await capture;
      await writeFile(path.join(directory, 'frames.txt'), frames.map((frame, i) =>
        `file '${frame.name}'\nduration ${((frames[i + 1]?.time ?? frame.time + 50) - frame.time) / 1000}`).join('\n'));
      console.log(`Captured ${frames.length} frames`);
    }
    clearTimeout(timeout);
    await invoke('window_destroy', {});
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
}
