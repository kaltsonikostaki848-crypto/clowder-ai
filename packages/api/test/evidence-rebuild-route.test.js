import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { evidenceRoutes } from '../dist/routes/evidence.js';

function createEvidenceStoreWithDb(db) {
  return {
    search: async () => [],
    health: async () => true,
    initialize: async () => {},
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
    getDb: () => db,
  };
}

describe('POST /api/evidence/rebuild', () => {
  const apps = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      await app.close();
    }
  });

  async function setup({ indexBuilder, db }) {
    const app = Fastify();
    apps.push(app);
    await app.register(evidenceRoutes, {
      evidenceStore: createEvidenceStoreWithDb(db),
      indexBuilder,
    });
    await app.ready();
    return app;
  }

  it('returns 409 when a rebuild request is already in flight', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let callCount = 0;

    const indexBuilder = {
      rebuild: async () => {
        callCount += 1;
        await gate;
        return { docsIndexed: 1, docsSkipped: 0, durationMs: 1 };
      },
      incrementalUpdate: async () => {},
      checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
      backfillEmbeddingsIfNeeded: async () => ({ backfilled: 0 }),
      isEmbedReady: () => false,
    };

    const db = {
      prepare: (sql) => ({
        get: () => {
          if (sql.includes('evidence_docs') && sql.includes('count')) return { c: 0 };
          if (sql.includes('edges') && sql.includes('count')) return { c: 0 };
          if (sql.includes('max(updated_at)')) return { t: null };
          if (sql.includes('evidence_vectors') && sql.includes('count')) return { c: 0 };
          return {};
        },
      }),
    };

    const app = await setup({ indexBuilder, db });

    const firstReq = app.inject({
      method: 'POST',
      url: '/api/evidence/rebuild',
      payload: { force: true },
      remoteAddress: '127.0.0.1',
    });

    await new Promise((r) => setTimeout(r, 5));

    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/evidence/rebuild',
      payload: { force: true },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(secondRes.statusCode, 409);
    assert.equal(secondRes.json().error, 'rebuild already in progress');

    release();
    const firstRes = await firstReq;
    assert.equal(firstRes.statusCode, 200);
    assert.equal(callCount, 1);
  });

  it('rejects non-localhost rebuild requests with 403', async () => {
    const indexBuilder = {
      rebuild: async () => ({ docsIndexed: 0, docsSkipped: 0, durationMs: 1 }),
      incrementalUpdate: async () => {},
      checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
      backfillEmbeddingsIfNeeded: async () => ({ backfilled: 0 }),
      isEmbedReady: () => false,
    };

    const db = {
      prepare: (sql) => ({
        get: () => {
          if (sql.includes('evidence_docs') && sql.includes('count')) return { c: 0 };
          if (sql.includes('edges') && sql.includes('count')) return { c: 0 };
          if (sql.includes('max(updated_at)')) return { t: null };
          if (sql.includes('evidence_vectors') && sql.includes('count')) return { c: 0 };
          return {};
        },
      }),
    };

    const app = await setup({ indexBuilder, db });

    const res = await app.inject({
      method: 'POST',
      url: '/api/evidence/rebuild',
      payload: { force: true },
      remoteAddress: '10.0.0.8',
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'rebuild only allowed from localhost');
  });
});

describe('GET /api/evidence/status vectors_count stability', () => {
  let app;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('returns vectors_count=0 when evidence_vectors table is missing', async () => {
    const db = {
      prepare: (sql) => ({
        get: () => {
          if (sql.includes('evidence_vectors') && sql.includes('count')) {
            throw new Error('no such table: evidence_vectors');
          }
          if (sql.includes('evidence_docs') && sql.includes('count')) return { c: 13 };
          if (sql.includes('edges') && sql.includes('count')) return { c: 8 };
          if (sql.includes('max(updated_at)')) return { t: '2026-04-16T00:00:00.000Z' };
          if (sql.includes('embedding_meta')) return { value: null };
          return {};
        },
      }),
    };

    const evidenceStore = createEvidenceStoreWithDb(db);

    app = Fastify();
    await app.register(evidenceRoutes, {
      evidenceStore,
      indexBuilder: {
        rebuild: async () => ({ docsIndexed: 0, docsSkipped: 0, durationMs: 1 }),
        incrementalUpdate: async () => {},
        checkConsistency: async () => ({ ok: true, docCount: 0, ftsCount: 0, mismatches: [] }),
        backfillEmbeddingsIfNeeded: async () => ({ backfilled: 0 }),
        isEmbedReady: () => true,
      },
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/evidence/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.backend, 'sqlite');
    assert.equal(body.healthy, true);
    assert.equal(body.docs_count, 13);
    assert.equal(body.vectors_count, 0);
  });
});
