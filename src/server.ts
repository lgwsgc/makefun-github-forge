// The HTTP server: one node:http server routing every surface — /healthz,
// the git smart-HTTP paths, REST v3, GraphQL and MCP — with bearer auth on
// every surface except /healthz, a request id on every reply, and JSON
// errors everywhere (never HTML, never a crash: a handler that throws
// answers 500 JSON and the process keeps serving).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, gitJsonError, type GitService } from './git-http.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { nextRequestId } from './util.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ServerOptions {
  /** The bearer token to accept. Empty means dev mode: any non-empty token. */
  token: string;
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  if (expected === '') return true; // dev mode: any non-empty bearer token
  return presented === expected;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...extraHeaders });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

export function createForgeServer(forge: Forge, options: ServerOptions): Server {
  const server = createServer((req, res) => {
    void handleRequest(forge, options, req, res).catch((err) => {
      // A handler that throws must never take the process down: answer 500
      // JSON (the suite's repo-survives-errors check depends on this). The
      // 500 carries a request id too — the protocol check wants one on every
      // reply, including the ones that fail before a handler runs.
      try {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) }, { 'x-github-request-id': nextRequestId() });
        } else res.end();
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  return server;
}

async function handleRequest(forge: Forge, options: ServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const baseHeaders = { 'x-github-request-id': requestId };
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  // GET /healthz — the boot probe, unauthenticated.
  if (pathname === '/healthz') {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
    return sendJson(res, 200, { ok: true }, baseHeaders);
  }

  // Everything else needs a valid bearer token.
  if (!isAuthorized(req, options.token)) {
    return sendJson(res, 401, { message: 'Bad credentials' }, baseHeaders);
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs and /{owner}/{repo}.git/git-*.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const endpoint = gitMatch[3];
    if (endpoint === 'info/refs') {
      if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
      const service = url.searchParams.get('service') as GitService | null;
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return sendJson(res, 400, { message: 'unknown service' }, baseHeaders);
      }
      const wantsV2 = req.headers['git-protocol'] === 'version=2';
      const out = handleInfoRefs(forge, owner, repoName, service, wantsV2);
      return sendRaw(res, out.status, out.contentType, out.body, baseHeaders);
    }
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
    const body = await readBody(req);
    try {
      if (endpoint === 'git-upload-pack') {
        const isV2 = req.headers['git-protocol'] === 'version=2';
        const out = handleUploadPack(forge, owner, repoName, body, isV2);
        return sendRaw(res, out.status, out.contentType, out.body, baseHeaders);
      }
      const out = handleReceivePack(forge, owner, repoName, body);
      return sendRaw(res, out.status, out.contentType, out.body, baseHeaders);
    } catch (err) {
      // A malformed git request is a 400, and the server stays up.
      const out = gitJsonError(400, err instanceof Error ? err.message : String(err));
      return sendRaw(res, out.status, out.contentType, out.body, baseHeaders);
    }
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname === '/api/v3/' || pathname.startsWith('/api/v3/')) {
    const tail = pathname === '/api/v3' || pathname === '/api/v3/' ? '' : pathname.slice('/api/v3/'.length);
    const segments = tail === '' ? [] : decodeSegments(`/${tail}`);
    let parsedBody: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          parsedBody = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 400, { message: 'Problems parsing JSON' }, baseHeaders);
        }
      }
    }
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const restReq: RestRequest = { method, segments, query: url.searchParams, body: parsedBody, origin };
    const out = handleRest(forge, restReq);
    if (out.status === 204) {
      res.writeHead(204, baseHeaders);
      return res.end();
    }
    return sendJson(res, out.status, out.body, { ...baseHeaders, ...(out.headers ?? {}) });
  }

  // GraphQL.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
    const raw = await readBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { message: 'Problems parsing JSON' }, baseHeaders);
    }
    const out = handleGraphQL(forge, parsedBody);
    return sendJson(res, out.status, out.body, baseHeaders);
  }

  // MCP.
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      // A legacy session close, best-effort: nothing is held, so it is done.
      res.writeHead(204, baseHeaders);
      return res.end();
    }
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
    const raw = await readBody(req);
    const out = handleMcp(forge, {
      rawBody: raw.toString('utf8'),
      protocolVersionHeader: typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : null,
    });
    if (out.status === 202 || out.body === '') {
      res.writeHead(out.status, { ...baseHeaders, ...out.headers });
      return res.end(out.body);
    }
    return sendRaw(res, out.status, 'application/json', Buffer.from(out.body, 'utf8'), { ...baseHeaders, ...out.headers });
  }

  return sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
}
