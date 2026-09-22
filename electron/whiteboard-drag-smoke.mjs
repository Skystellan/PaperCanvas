import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function whiteboardDragSmoke({ wc, backend, dataDirectory, evaluate, until, reload }) {
  const nodes = `[...document.querySelectorAll('.react-flow__node')]`;
  const positions = `${nodes}.map(node => {
    const matrix = new DOMMatrix(getComputedStyle(node).transform);
    return { id: node.dataset.id, x: matrix.m41, y: matrix.m42 };
  })`;
  const draggedNode = `document.querySelector('.react-flow__node[data-id="node-attention"]')`;
  const start = await evaluate(`(() => {
    const rect = ${draggedNode}.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 24) };
  })()`);
  const before = await evaluate(positions);
  await evaluate(`(() => {
    window.dragFrames = [];
    window.captureDragFrames = true;
    function capture() {
      window.dragFrames.push(${positions});
      if (window.captureDragFrames) requestAnimationFrame(capture);
    }
    requestAnimationFrame(capture);
  })()`);

  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
  let grabOffset;
  try {
    for (let step = 1; step <= 20; step++) {
      const pointer = { x: start.x + step * 5, y: start.y + step * 2 };
      wc.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], ...pointer });
      await delay(20);
      const actual = await evaluate(`(() => {
        const rect = ${draggedNode}.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + 24 };
      })()`);
      // React Flow establishes the grab offset after crossing its drag threshold.
      grabOffset ??= { x: actual.x - pointer.x, y: actual.y - pointer.y };
      assert.ok(Math.hypot(actual.x - pointer.x - grabOffset.x, actual.y - pointer.y - grabOffset.y) < 3,
        `The dragged card follows every pointer update: ${JSON.stringify({ step, start, pointer, actual })}`);
    }
  } finally {
    await writeFile(path.join(dataDirectory, 'whiteboard-drag-release.png'), (await wc.capturePage()).toPNG());
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: start.x + 100, y: start.y + 40 });
  }

  const deadline = Date.now() + 12_000;
  let saved;
  let finalPositions;
  while (Date.now() < deadline) {
    finalPositions = await evaluate(positions);
    saved = await backend.call('database_select', {
      query: 'SELECT id,x,y FROM board_nodes ORDER BY id', values: [],
    });
    if (JSON.stringify(finalPositions) !== JSON.stringify(before) && finalPositions.every(position => {
      const record = saved.find(({ id }) => id === position.id);
      return record && Math.hypot(record.x - position.x, record.y - position.y) < 0.01;
    })) break;
    await delay(100);
  }
  const frames = await evaluate('window.captureDragFrames = false; window.dragFrames');
  let maximumStep = 0;
  for (let index = 1; index < frames.length; index++) {
    for (const position of frames[index]) {
      const previous = frames[index - 1].find(({ id }) => id === position.id);
      if (previous) maximumStep = Math.max(maximumStep, Math.hypot(position.x - previous.x, position.y - previous.y));
    }
  }
  assert.ok(frames.length > 20, 'Captured the actual drag and cooling animation');
  assert.ok(maximumStep < 80, `No hard position jumps: maximum frame step ${maximumStep}`);
  assert.notDeepEqual(finalPositions, before, 'Drag changed the layout');
  for (const position of finalPositions) {
    const record = saved.find(({ id }) => id === position.id);
    assert.ok(record && Math.hypot(record.x - position.x, record.y - position.y) < 0.01,
      'The cooled positions are durable');
  }
  await writeFile(path.join(dataDirectory, 'whiteboard-drag.png'), (await wc.capturePage()).toPNG());
  await reload();
  await until(`${nodes}.length === ${finalPositions.length}`, 'saved cards after reload');
  const restored = await evaluate(positions);
  assert.deepEqual(restored, finalPositions, 'Reload preserves positions without moving domain groups');
  console.log('Whiteboard drag:', JSON.stringify({ frames: frames.length, maximumStep, saved: true, restored: true }));
}

export async function whiteboardDomainSmoke({ wc, backend, dataDirectory, evaluate, until, reload }) {
  for (const [id, name] of [['domain-a', '领域 A'], ['domain-b', '领域 B']]) {
    await backend.call('database_execute', {
      query: 'INSERT INTO paper_domains(id,name,created_at,updated_at) VALUES(?,?,1,1)', values: [id, name],
    });
  }
  await backend.call('database_execute', {
    query: "UPDATE papers SET domain_id = CASE WHEN id='paper-bert' THEN 'domain-b' ELSE 'domain-a' END", values: [],
  });
  for (const [id, x, y] of [['node-attention', 120, 110], ['node-resnet', 120, 420], ['node-bert', 1000, 110]]) {
    await backend.call('database_execute', {
      query: 'UPDATE board_nodes SET x=?,y=? WHERE id=?', values: [x, y, id],
    });
  }
  await reload();
  await until(`document.querySelectorAll('.whiteboard__domain-frame').length === 2`, 'separate domain regions');
  const snapshot = `(() => {
    const worldBounds = element => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.m41, y: matrix.m42, right: matrix.m41 + element.offsetWidth, bottom: matrix.m42 + element.offsetHeight };
    };
    const card = id => document.querySelector('.react-flow__node[data-id="' + id + '"]');
    const grip = id => {
      const rect = card(id).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + 24 };
    };
    return {
      frames: ['domain-a', 'domain-b'].map(id => worldBounds(document.querySelector('[data-testid="domain-frame-' + id + '"]'))),
      a: worldBounds(card('node-attention')),
      b: worldBounds(card('node-bert')),
      sibling: worldBounds(card('node-resnet')),
      grips: { a: grip('node-attention'), b: grip('node-bert') },
    };
  })()`;
  const separate = ([a, b]) => a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y;
  const assertWrapping = (state, tolerance = 1) => {
    for (const [index, cards] of [[0, [state.a, state.sibling]], [1, [state.b]]]) {
      const expected = {
        x: Math.min(...cards.map(card => card.x)) - 48,
        y: Math.min(...cards.map(card => card.y)) - 48,
        right: Math.max(...cards.map(card => card.right)) + 48,
        bottom: Math.max(...cards.map(card => card.bottom)) + 48,
      };
      for (const key of Object.keys(expected)) {
        assert.ok(Math.abs(state.frames[index][key] - expected[key]) < tolerance,
          `Background wraps current member positions: ${JSON.stringify({ index, key, expected, actual: state.frames[index] })}`);
      }
    }
  };
  // Wait for the initial fit-view transform to be applied before sending coordinates.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const before = await evaluate(snapshot);
  assert.ok(separate(before.frames), 'Domain regions start separate');
  assertWrapping(before);
  await evaluate(`(() => {
    window.regionFrames = [];
    window.captureRegionFrames = true;
    function capture() {
      window.regionFrames.push(${snapshot});
      if (window.captureRegionFrames) requestAnimationFrame(capture);
    }
    requestAnimationFrame(capture);
  })()`);
  const start = { x: Math.round(before.grips.a.x), y: Math.round(before.grips.a.y) };
  const target = { x: Math.round(before.grips.b.x), y: start.y };
  let grabOffset;
  const drag = async (from, to) => {
    for (let step = 1; step <= 30; step++) {
      const pointer = {
        x: Math.round(from.x + (to.x - from.x) * step / 30),
        y: Math.round(from.y + (to.y - from.y) * step / 30),
      };
      wc.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], ...pointer });
      await delay(20);
      const state = await evaluate(snapshot);
      // Controlled React Flow nodes reach its internal store after the parent
      // commits. Allow one animation step while moving; check exact bounds at rest.
      assertWrapping(state, 32);
      grabOffset ??= { x: state.grips.a.x - pointer.x, y: state.grips.a.y - pointer.y };
      assert.ok(Math.hypot(state.grips.a.x - pointer.x - grabOffset.x, state.grips.a.y - pointer.y - grabOffset.y) < 3,
        'Dragging follows the pointer beyond the original region boundary');
    }
  };
  wc.focus();
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
  try {
    await drag(start, target);
    const expanded = await evaluate(snapshot);
    assert.ok(expanded.frames[0].right - expanded.frames[0].x > before.frames[0].right - before.frames[0].x + 200,
      'Dragging outward expands the background');
    assert.notDeepEqual(expanded.b, before.b, 'The neighboring domain moves aside');
    await writeFile(path.join(dataDirectory, 'whiteboard-domain-expanded.png'), (await wc.capturePage()).toPNG());
    await drag(target, start);
    const contracted = await evaluate(snapshot);
    assert.ok(contracted.frames[0].right - contracted.frames[0].x < expanded.frames[0].right - expanded.frames[0].x - 200,
      'Dragging inward shrinks the background');
  } finally {
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...start });
    await evaluate('window.captureRegionFrames = false');
  }
  const frames = await evaluate('window.regionFrames');
  const maximumNeighborStep = Math.max(...frames.slice(1).map((frame, index) =>
    Math.hypot(frame.b.x - frames[index].b.x, frame.b.y - frames[index].b.y)));
  assert.ok(maximumNeighborStep > 0 && maximumNeighborStep <= 24.01,
    `Neighbor movement stays smooth: ${maximumNeighborStep}`);
  const nodeKeys = [['node-attention', 'a'], ['node-bert', 'b'], ['node-resnet', 'sibling']];
  let finalState;
  let saved;
  const deadline = Date.now() + 12_000;
  const matchesSaved = () => nodeKeys.every(([id, key]) => {
    const record = saved.find(node => node.id === id);
    return record && Math.hypot(record.x - finalState[key].x, record.y - finalState[key].y) < 0.01;
  });
  do {
    await delay(100);
    finalState = await evaluate(snapshot);
    saved = await backend.call('database_select', {
      query: 'SELECT n.id,n.x,n.y,p.domain_id FROM board_nodes n JOIN papers p ON p.id=n.paper_id', values: [],
    });
  } while (Date.now() < deadline && !matchesSaved());
  assert.ok(matchesSaved(), 'Domain movement is saved after cooling');
  assert.ok(separate(finalState.frames), 'Domain regions settle without overlap');
  assertWrapping(finalState);
  for (const node of saved) {
    assert.equal(node.domain_id, node.id === 'node-bert' ? 'domain-b' : 'domain-a', 'Dragging preserves domain membership');
  }
  await writeFile(path.join(dataDirectory, 'whiteboard-domain-settled.png'), (await wc.capturePage()).toPNG());
  await reload();
  await until(`document.querySelectorAll('.whiteboard__domain-frame').length === 2`, 'restored domain regions');
  const restored = await evaluate(snapshot);
  for (const [, key] of nodeKeys) assert.deepEqual(restored[key], finalState[key], 'Reload preserves the separated layout');
  console.log('Whiteboard domains:', JSON.stringify({ expands: true, shrinks: true, maximumNeighborStep, separate: true, saved: true, restored: true }));
}
