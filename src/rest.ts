// The REST v3 API: repositories, branches, commits, contents, labels,
// issues, pull requests and git refs, under /api/v3. Shapes follow the
// GitHub API the suite's client expects: repos carry name/private/
// default_branch/description, issues carry number/title/body/state/labels,
// pull requests carry head/base ref+sha, and errors are always JSON
// {message} with the right status (401/404/405/409/422).

import { Forge, commentJson, issueJson, labelJson, pullJson, repoJson, type Repo } from './store.ts';
import { VIEWER, isRecord } from './util.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3 (decoded, without empty segments). */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  /** The request's origin (scheme://host) for absolute pagination links. */
  origin: string;
}

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function json(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function notFound(what = 'Not Found'): RestResponse {
  return err(404, what);
}

function repoOr404(forge: Forge, owner: string, name: string): Repo | RestResponse {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return notFound('Not Found');
  return repo;
}

function parseIntParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Paginate a list and build GitHub-style absolute Link headers. */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  origin: string,
  path: string,
): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(100, parseIntParam(query.get('per_page'), 30));
  const page = parseIntParam(query.get('page'), 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => `${origin}${path}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: slice, headers: { link: links.join(', ') } };
}

export function handleRest(forge: Forge, req: RestRequest): RestResponse {
  const [first, ...rest] = req.segments;

  // GET /api/v3/ — the API root.
  if (req.segments.length === 0) {
    if (req.method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, {}, { 'x-oauth-scopes': 'repo' });
  }

  if (first === 'meta' && req.segments.length === 1) {
    if (req.method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0' });
  }

  if (first === 'user') return handleUser(forge, req, rest);
  if (first === 'repos') return handleRepos(forge, req, rest);
  return notFound('Not Found');
}

function handleUser(forge: Forge, req: RestRequest, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      site_admin: false,
    });
  }
  if (rest[0] === 'repos' && rest.length === 1) {
    if (req.method === 'GET') {
      const repos = forge.listRepos(VIEWER.login);
      const { page, headers } = paginate(repos, req.query, req.origin, '/api/v3/user/repos');
      return json(200, page.map((repo) => repoJson(repo)), headers);
    }
    if (req.method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') return err(422, 'name is required');
      const isPrivate = body.private === true;
      const description = typeof body.description === 'string' ? body.description : '';
      const repo = forge.createRepo(VIEWER.login, name, isPrivate, description);
      if (repo === null) return err(422, 'Repository creation failed: name already exists on this account');
      return json(201, repoJson(repo));
    }
    return err(405, 'Method Not Allowed');
  }
  return notFound('Not Found');
}

function handleRepos(forge: Forge, req: RestRequest, rest: string[]): RestResponse {
  if (rest.length < 2) return notFound('Not Found');
  const [owner, name, ...tail] = rest;
  const repo = repoOr404(forge, owner, name);
  if (!('refs' in repo)) return repo as RestResponse;

  if (tail.length === 0) {
    if (req.method === 'GET') return json(200, repoJson(repo));
    if (req.method === 'PATCH') {
      const body = isRecord(req.body) ? req.body : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.privateRepo = body.private;
      return json(200, repoJson(repo));
    }
    if (req.method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return err(405, 'Method Not Allowed');
  }

  const [section, ...sub] = tail;
  switch (section) {
    case 'branches':
      return handleBranches(repo, req, sub);
    case 'commits':
      return handleCommits(forge, repo, req, sub);
    case 'contents':
      return handleContents(forge, repo, req, sub);
    case 'labels':
      return handleLabels(forge, repo, req, sub);
    case 'issues':
      return handleIssues(forge, repo, req, sub);
    case 'pulls':
      return handlePulls(forge, repo, req, sub);
    case 'git':
      return handleGitRefs(forge, repo, req, sub);
    default:
      return notFound('Not Found');
  }
}

function handleBranches(repo: Repo, req: RestRequest, sub: string[]): RestResponse {
  if (req.method !== 'GET') return err(405, 'Method Not Allowed');
  if (sub.length === 0) {
    const branches = repo.branchNames().map((name) => ({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`) as string },
    }));
    return json(200, branches);
  }
  const branch = sub.join('/');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return notFound('Branch not found');
  return json(200, { name: branch, commit: { sha } });
}

function handleCommits(forge: Forge, repo: Repo, req: RestRequest, sub: string[]): RestResponse {
  if (req.method !== 'GET' || sub.length !== 0) return err(405, 'Method Not Allowed');
  const ref = req.query.get('sha') ?? repo.defaultBranch;
  const commits = forge.listCommits(repo, ref);
  return json(
    200,
    commits.map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })),
  );
}

function handleContents(forge: Forge, repo: Repo, req: RestRequest, sub: string[]): RestResponse {
  const path = sub.join('/');
  if (path === '') return notFound('Not Found');
  if (req.method === 'GET') {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const found = forge.readPath(repo, ref, path);
    if (found === null) return notFound('Not Found');
    if (found.kind === 'file') {
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: found.data.toString('base64'),
        sha: found.entry.oid,
        size: found.data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    return json(
      200,
      found.entries.map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
        size: 0,
      })),
    );
  }
  if (req.method === 'PUT') {
    const body = isRecord(req.body) ? req.body : {};
    const message = typeof body.message === 'string' ? body.message : '';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    if (message === '' || contentB64 === '') return err(422, 'message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return err(422, 'content is not valid base64');
    }
    const existed = forge.readPath(repo, branch, path)?.kind === 'file';
    const result = forge.commitFile(repo, branch, path, content, message, sha);
    if ('error' in result) {
      if (result.error === 'stale') return err(409, 'sha does not match the current file');
      return notFound('Not Found');
    }
    return json(existed ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
  }
  if (req.method === 'DELETE') {
    const body = isRecord(req.body) ? req.body : {};
    const message = typeof body.message === 'string' ? body.message : '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const result = forge.commitFile(repo, branch, path, null, message, sha);
    if ('error' in result) {
      if (result.error === 'stale') return err(409, 'sha does not match the current file');
      return notFound('Not Found');
    }
    return json(200, { commit: { sha: result.commitSha, message } });
  }
  return err(405, 'Method Not Allowed');
}

function handleLabels(forge: Forge, repo: Repo, req: RestRequest, sub: string[]): RestResponse {
  if (sub.length !== 0) return notFound('Not Found');
  if (req.method === 'GET') {
    return json(200, [...repo.labels.values()].map((label) => labelJson(label)));
  }
  if (req.method === 'POST') {
    const body = isRecord(req.body) ? req.body : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return err(422, 'name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    const label = forge.createLabel(repo, name, color);
    return json(201, labelJson(label));
  }
  return err(405, 'Method Not Allowed');
}

function handleIssues(forge: Forge, repo: Repo, req: RestRequest, sub: string[]): RestResponse {
  if (sub.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, headers } = paginate(issues, req.query, req.origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return json(200, page.map((issue) => issueJson(repo, issue)), headers);
    }
    if (req.method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const title = typeof body.title === 'string' ? body.title : '';
      const issueBody = typeof body.body === 'string' ? body.body : '';
      if (title === '') return err(422, 'title is required');
      const labels = Array.isArray(body.labels)
        ? body.labels.filter((label): label is string => typeof label === 'string')
        : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `label ${JSON.stringify(label)} does not exist`);
      }
      const issue = forge.createIssue(repo, title, issueBody, labels);
      return json(201, issueJson(repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }
  const number = Number(sub[0]);
  if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
  const issue = repo.issueByNumber(number);
  if (issue === undefined) return notFound('Not Found');
  if (sub.length === 1) {
    if (req.method === 'GET') return json(200, issueJson(repo, issue));
    if (req.method === 'PATCH') {
      const body = isRecord(req.body) ? req.body : {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? issue.updatedAt : null;
      }
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((label): label is string => typeof label === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) return err(422, `label ${JSON.stringify(label)} does not exist`);
        }
        issue.labels = labels;
      }
      return json(200, issueJson(repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }
  if (sub[1] === 'comments' && sub.length === 2) {
    if (req.method === 'GET') {
      return json(200, issue.comments.map((comment) => commentJson(comment)));
    }
    if (req.method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return err(422, 'body is required');
      const comment = forge.createComment(issue, text);
      return json(201, commentJson(comment));
    }
    return err(405, 'Method Not Allowed');
  }
  return notFound('Not Found');
}

function handlePulls(forge: Forge, repo: Repo, req: RestRequest, sub: string[]): RestResponse {
  if (sub.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, headers } = paginate(pulls, req.query, req.origin, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return json(200, page.map((pull) => pullJson(repo, pull)), headers);
    }
    if (req.method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const title = typeof body.title === 'string' ? body.title : '';
      const pullBody = typeof body.body === 'string' ? body.body : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || head === '') return err(422, 'title and head are required');
      const headSha = repo.resolveRef(head);
      const baseSha = repo.resolveRef(base);
      if (headSha === null || baseSha === null) return err(422, 'head or base ref does not exist');
      if (headSha === baseSha) return err(422, 'No commits between base and head');
      const pull = forge.createPull(repo, title, pullBody, head, base);
      if (pull === null) return err(422, 'head or base ref does not exist');
      return json(201, pullJson(repo, pull));
    }
    return err(405, 'Method Not Allowed');
  }
  const number = Number(sub[0]);
  if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
  const pull = repo.pullByNumber(number);
  if (pull === undefined) return notFound('Not Found');
  if (sub.length === 1) {
    if (req.method === 'GET') return json(200, pullJson(repo, pull));
    if (req.method === 'PATCH') {
      const body = isRecord(req.body) ? req.body : {};
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      return json(200, pullJson(repo, pull));
    }
    return err(405, 'Method Not Allowed');
  }
  if (sub[1] === 'files' && sub.length === 2) {
    if (req.method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, forge.pullFiles(repo, pull));
  }
  if (sub[1] === 'merge' && sub.length === 2) {
    if (req.method !== 'PUT') return err(405, 'Method Not Allowed');
    if (pull.state !== 'open') return err(405, 'Pull request is already closed');
    const mergeSha = forge.mergePull(repo, pull);
    if (mergeSha === null) return err(405, 'Pull request cannot be merged: merge conflict');
    return json(200, { merged: true, sha: mergeSha, message: 'Pull request successfully merged' });
  }
  return notFound('Not Found');
}

function handleGitRefs(forge: Forge, repo: Repo, req: RestRequest, sub: string[]): RestResponse {
  if (sub[0] !== 'refs') return notFound('Not Found');
  if (sub.length === 1) {
    if (req.method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'ref and sha are required');
      if (!repo.store.has(sha)) return err(422, 'sha does not exist');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.setRef(ref, sha);
      return json(201, { ref, object: { sha } });
    }
    return err(405, 'Method Not Allowed');
  }
  const ref = `refs/${sub.slice(1).join('/')}`;
  if (req.method === 'GET') {
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound('Reference does not exist');
    return json(200, { ref, object: { sha } });
  }
  if (req.method === 'DELETE') {
    if (!repo.refs.has(ref)) return notFound('Reference does not exist');
    repo.deleteRef(ref);
    return { status: 204, body: null };
  }
  return err(405, 'Method Not Allowed');
}
