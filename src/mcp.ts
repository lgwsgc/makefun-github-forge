// Model Context Protocol over POST /mcp (JSON-RPC 2.0): the modern
// 2026-07-28 era (`server/discover`, per-request revision in `_meta` and the
// `MCP-Protocol-Version` header, no session) and the legacy handshake era
// (`initialize` + `notifications/initialized`). Six github-mcp-server tools
// plus one extra, all backed by the same store as REST and GraphQL, so a
// repository or issue created over MCP is the same object over REST.

import { Forge, issueJson, pullJson, repoJson } from './store.ts';
import { VIEWER, isRecord } from './util.ts';

const SERVER_NAME = 'makefun-github-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISION = '2025-11-25';

export interface McpRequest {
  /** The raw request body text (kept raw so a parse error can answer -32700). */
  rawBody: string;
  /** The MCP-Protocol-Version request header, when present. */
  protocolVersionHeader: string | null;
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner login (the authenticated user).' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'get_issue',
    description: 'Read one issue by owner, repository and number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
];

/** The tools/list answer. Built from a constant, so it is byte-identical on every call. */
function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

interface ToolOutcome {
  ok: boolean;
  /** The value for structuredContent (and the text block). */
  value: unknown;
  /** A tool-level failure message (answered with isError:true). */
  message?: string;
}

function toolText(value: unknown): string {
  return JSON.stringify(value);
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { ok: false, value: null, message: `unknown tool ${name}` };
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, value: null, message: `missing required argument ${required}` };
    }
  }
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? '');
  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo(
        VIEWER.login,
        String(args.name ?? ''),
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      if (repo === null) return { ok: false, value: null, message: 'Repository creation failed: name already exists on this account' };
      return { ok: true, value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, value: null, message: 'Not Found' };
      return { ok: true, value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, value: null, message: 'Not Found' };
      const issue = forge.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, value: null, message: 'Not Found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return { ok: true, value: issues.map((issue) => issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, value: null, message: 'Not Found' };
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = repo.resolveRef(head);
      const baseSha = repo.resolveRef(base);
      if (headSha === null || baseSha === null) return { ok: false, value: null, message: 'head or base ref does not exist' };
      if (headSha === baseSha) return { ok: false, value: null, message: 'No commits between base and head' };
      const pull = forge.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base);
      if (pull === null) return { ok: false, value: null, message: 'head or base ref does not exist' };
      return { ok: true, value: pullJson(repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, value: null, message: 'Not Found' };
      const number = Number(args.pull_number);
      const pull = repo.pullByNumber(number);
      if (pull === undefined) return { ok: false, value: null, message: 'Not Found' };
      if (pull.state !== 'open') return { ok: false, value: null, message: 'Pull request is already closed' };
      const mergeSha = forge.mergePull(repo, pull);
      if (mergeSha === null) return { ok: false, value: null, message: 'Pull request cannot be merged: merge conflict' };
      return { ok: true, value: { merged: true, sha: mergeSha, ...pullJson(repo, pull) } };
    }
    case 'get_issue': {
      const repo = forge.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, value: null, message: 'Not Found' };
      const issue = repo.issueByNumber(Number(args.issue_number));
      if (issue === undefined) return { ok: false, value: null, message: 'Not Found' };
      return { ok: true, value: issueJson(repo, issue) };
    }
    default:
      return { ok: false, value: null, message: `unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const DISCOVER_RESULT: Record<string, unknown> = {
  protocolVersion: MODERN_REVISION,
  supportedVersions: [MODERN_REVISION, LEGACY_REVISION],
  serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  capabilities: { tools: {} },
  _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_REVISION },
};

export function handleMcp(forge: Forge, req: McpRequest): McpResponse {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (req.protocolVersionHeader !== null && req.protocolVersionHeader !== '') {
    headers['mcp-protocol-version'] = req.protocolVersionHeader;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.rawBody);
  } catch {
    return {
      status: 400,
      headers,
      body: JSON.stringify(rpcError(null, -32700, 'Parse error')),
    };
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return { status: 400, headers, body: JSON.stringify(rpcError(null, -32600, 'Invalid Request')) };
  }
  const id: JsonRpcId = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  const isNotification = parsed.id === undefined;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const method = parsed.method;

  if (method.startsWith('notifications/')) {
    // A notification has no answer; 202 says it was received.
    return { status: 202, headers, body: '' };
  }

  switch (method) {
    case 'server/discover':
      return { status: 200, headers, body: JSON.stringify(rpcResult(id, DISCOVER_RESULT)) };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : LEGACY_REVISION;
      const chosen = requested === LEGACY_REVISION || requested === '2025-06-18' || requested === '2025-03-26' || requested === '2024-11-05'
        ? requested
        : LEGACY_REVISION;
      return {
        status: 200,
        headers,
        body: JSON.stringify(rpcResult(id, {
          protocolVersion: chosen,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        })),
      };
    }
    case 'ping':
      return { status: 200, headers, body: JSON.stringify(rpcResult(id, {})) };
    case 'tools/list':
      return { status: 200, headers, body: JSON.stringify(rpcResult(id, toolsListResult())) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const known = TOOLS.some((tool) => tool.name === name);
      if (!known) {
        return { status: 200, headers, body: JSON.stringify(rpcError(id, -32601, `unknown tool ${name}`)) };
      }
      const outcome = callTool(forge, name, args);
      if (!outcome.ok) {
        // A missing required argument is invalid params (-32602); a tool that
        // ran and failed reports isError with its message.
        if (typeof outcome.message === 'string' && outcome.message.startsWith('missing required argument')) {
          return { status: 200, headers, body: JSON.stringify(rpcError(id, -32602, outcome.message)) };
        }
        return {
          status: 200,
          headers,
          body: JSON.stringify(rpcResult(id, {
            content: [{ type: 'text', text: outcome.message ?? 'tool failed' }],
            isError: true,
          })),
        };
      }
      return {
        status: 200,
        headers,
        body: JSON.stringify(rpcResult(id, {
          content: [{ type: 'text', text: toolText(outcome.value) }],
          structuredContent: outcome.value,
        })),
      };
    }
    default:
      if (isNotification) return { status: 202, headers, body: '' };
      return { status: 200, headers, body: JSON.stringify(rpcError(id, -32601, `Method not found: ${method}`)) };
  }
}
