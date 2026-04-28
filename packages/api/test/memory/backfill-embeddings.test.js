import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

class ToggleEmbedding {
  constructor() {
    this._ready = false;
  }

  setReady(next) {
    this._ready = next;
  }

  isReady() {
    return this._ready;
  }

  async load() {}

  async embed(texts) {
    return texts.map(() => new Float32Array([0.11, 0.22, 0.33, 0.44]));
  }

  getModelInfo() {
    return { modelId: 'test-toggle', modelRev: 'v1', dim: 4 };
  }

  dispose() {}
}

describe('IndexBuilder.backfillEmbeddingsIfNeeded', () => {
  let tmpDir;
  let docsDir;
  let store;
  let IndexBuilder;
  let VectorStore;
  let ensureVectorTable;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f102-backfill-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });

    const memoryMod = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const idxMod = await import('../../dist/domains/memory/IndexBuilder.js');
    const vecMod = await import('../../dist/domains/memory/VectorStore.js');
    const schemaMod = await import('../../dist/domains/memory/schema.js');

    IndexBuilder = idxMod.IndexBuilder;
    VectorStore = vecMod.VectorStore;
    ensureVectorTable = schemaMod.ensureVectorTable;

    store = new memoryMod.SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function makeBuilderWithEmbed({ ready = false } = {}) {
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 4);
    const vectorStore = new VectorStore(db, 4);
    const embedding = new ToggleEmbedding();
    embedding.setReady(ready);
    const builder = new IndexBuilder(store, docsDir, { embedding, vectorStore });
    return { builder, embedding, vectorStore };
  }

  function writeDoc(id, title = `Feature ${id}`) {
    writeFileSync(
      join(docsDir, 'features', `${id}.md`),
      `---\nfeature_ids: [${id}]\ndoc_kind: spec\n---\n\n# ${title}\n\ncontent for ${id}.\n`,
    );
  }

  it('returns skipped=no-embed-deps when embed deps missing', async () => {
    const builder = new IndexBuilder(store, docsDir);
    const result = await builder.backfillEmbeddingsIfNeeded();
    assert.deepEqual(result, { backfilled: 0, skipped: 'no-embed-deps' });
  });

  it('returns skipped=not-ready when embedding service is not ready', async () => {
    writeDoc('F100');
    const { builder } = await makeBuilderWithEmbed({ ready: false });
    await builder.rebuild({ force: true });

    const result = await builder.backfillEmbeddingsIfNeeded();
    assert.deepEqual(result, { backfilled: 0, skipped: 'not-ready' });
  });

  it('returns skipped=no-docs when there are no evidence docs', async () => {
    const { builder } = await makeBuilderWithEmbed({ ready: true });
    const result = await builder.backfillEmbeddingsIfNeeded();
    assert.deepEqual(result, { backfilled: 0, skipped: 'no-docs' });
  });

  it('returns skipped=already-populated when vectors already exist', async () => {
    writeDoc('F101');
    const { builder, vectorStore } = await makeBuilderWithEmbed({ ready: true });
    await builder.rebuild({ force: true });
    assert.ok(vectorStore.count() > 0);

    const result = await builder.backfillEmbeddingsIfNeeded();
    assert.deepEqual(result, { backfilled: 0, skipped: 'already-populated' });
  });

  it('backfills vectors after initial rebuild when service becomes ready', async () => {
    writeDoc('F102A', 'Feature A');
    writeDoc('F102B', 'Feature B');

    const { builder, embedding, vectorStore } = await makeBuilderWithEmbed({ ready: false });

    const rebuildResult = await builder.rebuild({ force: true });
    assert.equal(rebuildResult.docsIndexed, 2);
    assert.equal(vectorStore.count(), 0, 'vectors should stay empty while embedding is not ready');

    embedding.setReady(true);
    const result = await builder.backfillEmbeddingsIfNeeded();

    assert.equal(result.backfilled, 2);
    assert.equal(result.skipped, undefined);
    assert.equal(vectorStore.count(), 2);
  });

  it('isEmbedReady reflects embedding readiness state', async () => {
    const { builder, embedding } = await makeBuilderWithEmbed({ ready: false });
    assert.equal(builder.isEmbedReady(), false);
    embedding.setReady(true);
    assert.equal(builder.isEmbedReady(), true);
  });
});
