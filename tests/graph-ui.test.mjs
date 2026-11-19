import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { startGraphUiServer } from '../apps/graph-ui/dist/server.js';

test('graph-ui server serves HTML, DAG API, fork, accept, and handback artifacts', async () => {
  const runtime = await startGraphUiServer({ port: 0, forceDemo: true });
  try {
    const htmlRes = await fetch(runtime.url + '/');
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');
    const html = await htmlRes.text();
    assert.match(html, /<title>Siftable Graph<\/title>/);
    assert.equal(
      /window\.(prompt|confirm|alert)\s*\(/.test(html),
      false,
      'Webview-blocked browser dialogs must not be used',
    );
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'Expected inline script block');
    new vm.Script(scriptMatch[1]);

    const graphRes = await fetch(runtime.url + '/api/graph');
    assert.equal(graphRes.status, 200);
    const graphBody = await graphRes.json();
    assert.equal(graphBody.mode, 'demo');
    assert.ok(graphBody.data.nodes.length >= 10);
    assert.equal(graphBody.data.roots.length, 2);
    assert.ok(graphBody.data.counts.next > 0);

    // Filter to second root
    const secondRoot = graphBody.data.roots.find((r) => r.title.includes('Recovery'));
    assert.ok(secondRoot);
    const filteredRes = await fetch(
      `${runtime.url}/api/graph?rootId=${encodeURIComponent(secondRoot.id)}`,
    );
    const filtered = await filteredRes.json();
    assert.equal(filtered.data.nodes.length, 3);

    // Accept a needs_review leaf and confirm its parent unlocks!
    const l2 = graphBody.data.nodes.find((n) => n.title.includes('Batched SQL'));
    assert.equal(l2.uiState, 'needs_you');
    const detailRes = await fetch(`${runtime.url}/api/work/${l2.id}`);
    const detail = await detailRes.json();
    assert.equal(detail.data.artifacts.length, 1);

    const artRes = await fetch(
      `${runtime.url}/api/work/${l2.id}/artifacts/${detail.data.artifacts[0].id}`,
    );
    const art = await artRes.json();
    assert.match(art.data.content, /Handback Summary/);

    const acceptRes = await fetch(`${runtime.url}/api/work/${l2.id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'Verified batched SQL query' }),
    });
    assert.equal(acceptRes.status, 200);

    const afterAccept = await (await fetch(runtime.url + '/api/graph')).json();
    const m1 = afterAccept.data.nodes.find((n) => n.title.includes('Graph Query & Metrics'));
    assert.equal(m1.uiState, 'ready');
    assert.deepEqual(m1.waiting, { satisfied: 2, total: 2 });

    // Fork a ready leaf and verify it transitions to waiting 0/2
    const l6 = afterAccept.data.nodes.find((n) => n.title.includes('sidecar.json'));
    const forkRes = await fetch(`${runtime.url}/api/work/${l6.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: l6.revision,
        reason: 'Split plugin manifests',
        branches: [
          { title: 'Write sidecar.json manifest', description: '' },
          { title: 'Write mcp_config.json manifest', description: '' },
        ],
      }),
    });
    assert.equal(forkRes.status, 200);

    const afterFork = await (await fetch(runtime.url + '/api/graph')).json();
    const l6After = afterFork.data.nodes.find((n) => n.id === l6.id);
    assert.equal(l6After.uiState, 'waiting');
    assert.deepEqual(l6After.waiting, { satisfied: 0, total: 2 });
  } finally {
    await runtime.close();
  }
});
