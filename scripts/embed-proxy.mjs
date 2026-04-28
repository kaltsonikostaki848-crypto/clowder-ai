#!/usr/bin/env node
// Cat Cafe embedding sidecar proxy — adapts EmbeddingService HTTP protocol
// (GET /health + POST /v1/embeddings with {input:[...]}) to a remote
// OpenAI-compatible embedding endpoint (DashScope / Bailian, etc.).
//
// Required env:
//   EMBED_PROXY_UPSTREAM_URL   e.g. https://dashscope.aliyuncs.com/compatible-mode/v1
//   EMBED_PROXY_UPSTREAM_KEY   bearer token for upstream
//   EMBED_PROXY_UPSTREAM_MODEL e.g. text-embedding-v4
//
// Optional env:
//   EMBED_PROXY_PORT           default 9880
//   EMBED_PROXY_HOST           default 127.0.0.1
//   EMBED_PROXY_DIM            default 768 (requested via MRL "dimensions")
//   EMBED_PROXY_BATCH          default 10  (upstream per-call cap)
//   EMBED_PROXY_TIMEOUT_MS     default 20000

import { createServer } from 'node:http';

const PORT = Number(process.env.EMBED_PROXY_PORT ?? 9880);
const HOST = process.env.EMBED_PROXY_HOST ?? '127.0.0.1';
const UPSTREAM_URL = (process.env.EMBED_PROXY_UPSTREAM_URL ?? '').replace(/\/+$/, '');
const UPSTREAM_KEY = process.env.EMBED_PROXY_UPSTREAM_KEY ?? '';
const UPSTREAM_MODEL = process.env.EMBED_PROXY_UPSTREAM_MODEL ?? 'text-embedding-v4';
const DIM = Number(process.env.EMBED_PROXY_DIM ?? 768);
const BATCH = Number(process.env.EMBED_PROXY_BATCH ?? 10);
const TIMEOUT_MS = Number(process.env.EMBED_PROXY_TIMEOUT_MS ?? 20000);

if (!UPSTREAM_URL || !UPSTREAM_KEY) {
  console.error('[embed-proxy] missing EMBED_PROXY_UPSTREAM_URL or EMBED_PROXY_UPSTREAM_KEY');
  process.exit(1);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

async function callUpstream(inputBatch) {
  const res = await fetch(`${UPSTREAM_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${UPSTREAM_KEY}`,
    },
    body: JSON.stringify({
      model: UPSTREAM_MODEL,
      input: inputBatch,
      dimensions: DIM,
      encoding_format: 'float',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upstream ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text);
  if (!Array.isArray(json.data)) {
    throw new Error(`upstream malformed response: ${text.slice(0, 200)}`);
  }
  return json.data;
}

async function embedAll(inputs) {
  const out = new Array(inputs.length);
  for (let offset = 0; offset < inputs.length; offset += BATCH) {
    const slice = inputs.slice(offset, offset + BATCH);
    const data = await callUpstream(slice);
    for (const item of data) {
      const idx = offset + Number(item.index ?? 0);
      out[idx] = item.embedding;
    }
  }
  return out.map((embedding, index) => ({ embedding, index }));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        model: UPSTREAM_MODEL,
        backend: `proxy:${new URL(UPSTREAM_URL).host}`,
        device: 'remote',
        dim: DIM,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      const body = await readJsonBody(req);
      const input = body.input;
      if (!Array.isArray(input) || input.length === 0) {
        sendJson(res, 400, { error: 'input must be non-empty array of strings' });
        return;
      }
      const sanitized = input.map((s) => (typeof s === 'string' ? s : String(s ?? '')));
      const data = await embedAll(sanitized);
      sendJson(res, 200, { data, model: UPSTREAM_MODEL });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[embed-proxy]', err?.message || err);
    sendJson(res, 502, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[embed-proxy] listening http://${HOST}:${PORT} → ${UPSTREAM_URL} (model=${UPSTREAM_MODEL}, dim=${DIM})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[embed-proxy] received ${sig}, shutting down`);
    server.close(() => process.exit(0));
  });
}
