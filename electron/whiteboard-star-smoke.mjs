import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function whiteboardStarSmoke({ wc, backend, dataDirectory, evaluate, until, reload }) {
  assert.match(dataDirectory, /papercanvas-smoke-/);
  const execute = (query, values = []) => backend.call('database_execute', { query, values });
  await execute('DELETE FROM board_edges');
  await execute('DELETE FROM board_nodes');
  for (let index = -1; index < 8; index++) {
    const id = index < 0 ? 'star-hub' : `star-leaf-${index}`;
    const angle = index * Math.PI / 4;
    await execute('INSERT INTO papers(id,title,created_at) VALUES(?,?,1)', [id, index < 0 ? 'Research hub' : `Research direction ${index + 1}`]);
    await execute('INSERT INTO board_nodes(id,board_id,paper_id,x,y,width,height) VALUES(?,?,?,?,?,280,128)',
      [id, 'board-default', id, index < 0 ? 0 : Math.cos(angle) * 500, index < 0 ? 0 : Math.sin(angle) * 500]);
    if (index >= 0) await execute('INSERT INTO board_edges(id,board_id,source_node_id,target_node_id,created_at) VALUES(?,?,?,?,1)',
      [`star-edge-${index}`, 'board-default', 'star-hub', id]);
  }
  await reload();
  await until("document.querySelectorAll('.react-flow__node').length === 9", 'star fixture');
  const painted = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await painted();
  // Leave enough visible room to drag the hub past the original right-hand petals.
  for (let i = 0; i < 3; i++) {
    await evaluate('document.querySelector(\'button[aria-label="Zoom Out"]\').click()');
    await painted();
  }
  const positions = `[...document.querySelectorAll('.react-flow__node')].map(node => {
    const matrix = new DOMMatrix(getComputedStyle(node).transform);
    return { id: node.dataset.id, x: matrix.m41, y: matrix.m42 };
  })`;
  const start = await evaluate(`(() => {
    const rect = document.querySelector('[data-id="star-hub"]').getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 24),
      zoom: new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a };
  })()`);
  const before = await evaluate(positions);
  await writeFile(path.join(dataDirectory, 'whiteboard-star-before.png'), (await wc.capturePage()).toPNG());
  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: start.x, y: start.y });
  const target = { x: Math.round(start.x + 1_000 * start.zoom), y: start.y };
  let drop;
  try {
    for (let step = 1; step <= 60; step++) {
      wc.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'],
        x: Math.round(start.x + (target.x - start.x) * step / 60), y: start.y });
      await painted();
    }
    drop = (await evaluate(positions)).find(node => node.id === 'star-hub');
  } finally {
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...target });
  }
  assert.ok(drop.x > 900, 'The hub moved past the original star');
  let final;
  let saved;
  const matches = () => final?.every(node => {
    const record = saved.find(row => row.id === node.id);
    return record && Math.hypot(node.x - record.x, node.y - record.y) < 0.01;
  });
  const deadline = Date.now() + 25_000;
  do {
    await delay(100);
    final = await evaluate(positions);
    saved = await backend.call('database_select', { query: 'SELECT id,x,y FROM board_nodes', values: [] });
  } while (Date.now() < deadline && !matches());
  assert.ok(matches(), 'The complete star settles and saves');
  const hub = final.find(node => node.id === 'star-hub');
  assert.ok(Math.hypot(hub.x - drop.x, hub.y - drop.y) < 0.01,
    `The hub keeps its drop point: ${JSON.stringify({ hub, drop, start, target })}`);
  let maximumAngleError = 0;
  const lengths = [];
  for (const leaf of before.filter(node => node.id !== 'star-hub')) {
    const moved = final.find(node => node.id === leaf.id);
    const dx = moved.x - hub.x;
    const dy = moved.y - hub.y;
    const difference = Math.atan2(dy, dx) - Math.atan2(leaf.y, leaf.x);
    const error = Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference)));
    maximumAngleError = Math.max(maximumAngleError, error * 180 / Math.PI);
    assert.ok(error < Math.PI / 7, `Petal retains its original direction: ${leaf.id}, ${error}`);
    lengths.push(Math.hypot(dx, dy));
    assert.ok(lengths.at(-1) < 950, 'Petal connections stay bounded');
  }
  const meanLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  const lengthRatio = Math.max(...lengths) / Math.min(...lengths);
  assert.ok(meanLength < 500, `The star contracts after the drag: ${meanLength}`);
  assert.ok(lengthRatio < 1.4, `Petals keep comparable spacing: ${lengthRatio}`);
  await evaluate('document.querySelector(\'button[aria-label="Fit View"]\').click()');
  await painted();
  await writeFile(path.join(dataDirectory, 'whiteboard-star-after.png'), (await wc.capturePage()).toPNG());
  await reload();
  await until("document.querySelectorAll('.react-flow__node').length === 9", 'saved star');
  assert.deepEqual(await evaluate(positions), final, 'Reload preserves the star structure');
  console.log('Whiteboard star:', JSON.stringify({ maximumAngleError, meanLength, lengthRatio, dropDrift: 0, saved: true, restored: true }));
}
