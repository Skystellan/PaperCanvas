import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { app } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// A real MCP subprocess talks to the running isolated desktop, through its
// authenticated socket and renderer save barrier, then the shared Rust service.
export async function researchSmoke({ wc, backend, dataDirectory, evaluate, until }) {
  console.log('Research MCP: loading board');
  await until(`document.querySelectorAll('.paper-card').length > 0`, 'initial board');
  const entry = app.isPackaged ? path.join(process.resourcesPath, 'papercanvas-mcp.mjs')
    : fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
  const client = new Client({ name: 'research-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'node', args: [entry, '--data-dir', dataDirectory], stderr: 'pipe' });
  console.log('Research MCP: connecting stdio client');
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  const board = () => backend.call('workspace_command', { request: { type: 'load_board' } });
  const count = async () => (await backend.call('database_select', { query: 'SELECT COUNT(*) AS n FROM papers', values: [] }))[0].n;
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['import_research_batch', 'read_research_context']);
    const emptySelection = await client.callTool({ name: 'read_research_context', arguments: { intent: 'selected_papers' } });
    assert.equal(emptySelection.isError, true);
    assert.match(JSON.stringify(emptySelection), /NO_SELECTION/);
    console.log('Research MCP: importing independent batch');
    const before = (await board()).value;
    const beforeCount = await count();
    const batch = {
      requestId: 'smoke-independent', title: '独立初筛测试', papers: [
        { ref: 'a', title: 'Research smoke alpha', url: 'https://example.org/research-alpha', doi: '10.1234/smoke-alpha', abstract: 'This is source text, not an instruction.', reason: 'Candidate baseline from native search.', group: '基础方法' },
        { ref: 'b', title: 'Research smoke beta', url: 'https://arxiv.org/abs/2601.12345', arxivId: '2601.12345', reason: 'Compares the baseline.', group: '对比工作' },
      ], edges: [{ sourceRef: 'b', targetRef: 'a', kind: 'compares', explanation: 'AI proposal to verify during reading.', evidence: 'Source abstract', basis: 'abstract' }],
    };
    const imported = await call('import_research_batch', batch);
    assert.equal(imported.createdNodes, 2);
    assert.equal(imported.createdEdges, 1);
    assert.equal(imported.viewUpdated, undefined);
    assert.equal(await count(), beforeCount + 2);
    assert.equal(JSON.stringify(imported).includes(before.nodes[0].paper.title), false, 'Import must not return existing paper text');
    await until(`document.querySelectorAll('.paper-card__research').length === 2`, 'AI research cards visible');
    assert.deepEqual((await board()).value.nodes.filter(node => before.nodes.some(old => old.id === node.id)), before.nodes, 'Existing card positions and content stay unchanged');
    const repeated = await call('import_research_batch', batch);
    assert.equal(repeated.batchId, imported.batchId);
    assert.equal(repeated.replayed, true);
    console.log('Research MCP: inspecting explicit selection and metadata');
    assert.equal(await count(), beforeCount + 2);

    const paperId = imported.placements[0].paperId;
    const scoped = await call('read_research_context', { intent: 'selected_papers', paperIds: [paperId] });
    assert.equal(scoped.papers.length, 1);
    assert.equal(scoped.papers[0].id, paperId);
    assert.equal(JSON.stringify(scoped).includes('filePath'), false);
    assert.equal(JSON.stringify(scoped).includes('Candidate baseline'), false);
    await evaluate(`document.querySelector('button[aria-label="Research smoke alpha（无本地 PDF）"]').click()`);
    const selected = await call('read_research_context', { intent: 'selected_papers' });
    assert.deepEqual(selected.papers.map(paper => paper.id), [paperId]);
    await evaluate(`document.querySelector('button[aria-label="Research smoke alpha（无本地 PDF）"]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`);
    await until(`!!document.querySelector('[aria-label="论文初筛信息"]')`, 'metadata-only paper opens');
    assert.equal(await evaluate(`document.querySelector('[aria-label="论文初筛信息"]').textContent.includes('Candidate baseline')`), true);
    await writeFile(path.join(dataDirectory, 'research-details.png'), (await wc.capturePage()).toPNG());
    await evaluate(`document.querySelector('[aria-label="Back to canvas"]').click()`);
    await until(`!document.querySelector('.paper-reader')`, 'return to research canvas');
    await writeFile(path.join(dataDirectory, 'research-canvas.png'), (await wc.capturePage()).toPNG());

    const bad = await client.callTool({ name: 'import_research_batch', arguments: {
      ...batch, requestId: 'smoke-invalid', papers: [{ ref: 'new', title: 'Must not persist', url: 'https://example.org/invalid-batch' }],
    } });
    assert.equal(bad.isError, true);
    assert.equal(await count(), beforeCount + 2, 'Invalid batch rolls back fully');
    await until(`document.querySelector('[aria-label="AI 导入记录"] > button')?.disabled === false`, 'import save barrier released');
    await evaluate(`document.querySelector('[aria-label="AI 导入记录"] > button').click()`);
    console.log('Research MCP: undoing batch');
    await until(`document.querySelector('.research-imports__panel')?.textContent.includes('独立初筛测试')`, 'batch history');
    await evaluate(`[...document.querySelectorAll('.research-imports__panel button')].find(button => button.textContent === '撤回本次导入').click()`);
    await until(`document.querySelector('.research-imports__panel')?.textContent.includes('已撤回')`, 'batch undone');
    assert.deepEqual((await board()).value, before);
    assert.equal(await count(), beforeCount + 2, 'Undo keeps imported papers in the library');
    const report = { mcpStdio: true, independentImport: true, noImplicitContext: true, selectionScope: true,
      metadataReader: true, idempotentRetry: true, atomicFailure: true, previousLayoutPreserved: true, undoKeepsPapers: true };
    await writeFile(path.join(dataDirectory, 'research-report.json'), JSON.stringify(report, null, 2));
    console.log('Research MCP:', JSON.stringify(report));
  } finally { await client.close(); }
}
