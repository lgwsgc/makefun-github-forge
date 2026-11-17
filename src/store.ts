// The forge's in-memory state: repositories (each with its own git object
// store and refs), issues, pull requests, labels and comments, plus the
// operations the REST, GraphQL and MCP surfaces share — creating repos,
// committing files through the contents API, branching, and squash-merging
// pull requests with three-way conflict detection.

import {
  ObjectStore,
  buildCommit,
  buildTreeFromFiles,
  diffTrees,
  ensureEmptyTree,
  flattenTree,
  identLine,
  isAncestor,
  listCommits,
  mergeBase,
  objectId,
  parseCommit,
  peelToNonTag,
  type DiffFile,
  type FileEntry,
} from './objects.ts';
import { DEFAULT_BRANCH, VIEWER, ZERO_OID, gitIdentity, globalId, tickIso, tickSeconds } from './util.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  privateRepo: boolean;
  description: string;
  defaultBranch: string;
  readonly store = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  nextNumber = 1;
  readonly createdAt: string;
  updatedAt: string;
  /**
   * Fetch-response cache: the bytes of a fetch answer are a deterministic
   * function of the repo state and the request, so identical fetches (the
   * benchmark's 50 concurrent clones) share one built pack. Any mutation
   * bumps the generation and drops the cache.
   */
  generation = 0;
  readonly fetchCache = new Map<string, Buffer>();

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.privateRepo = isPrivate;
    this.description = description;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdAt = tickIso();
    this.updatedAt = this.createdAt;
    ensureEmptyTree(this.store);
  }

  /** Record a mutation: invalidate every cached fetch response. */
  touch(): void {
    this.generation += 1;
    this.fetchCache.clear();
  }

  /** Set a ref (bumping the generation only when the value changes). */
  setRef(ref: string, oid: string): void {
    if (this.refs.get(ref) !== oid) {
      this.refs.set(ref, oid);
      this.touch();
    }
  }

  /** Delete a ref (bumping the generation only when it existed). */
  deleteRef(ref: string): boolean {
    if (!this.refs.delete(ref)) return false;
    this.touch();
    return true;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The default branch's ref name. */
  get defaultRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** The default branch's tip, or null when the repo is unborn. */
  defaultTip(): string | null {
    return this.refs.get(this.defaultRef) ?? null;
  }

  /** Resolve a branch name, full ref, or oid to a commit oid (peeling tags). */
  resolveRef(ref: string): string | null {
    if (ref === 'HEAD') {
      const tip = this.defaultTip();
      return tip === null ? null : peelToNonTag(this.store, tip);
    }
    const direct = this.refs.get(ref) ?? this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`);
    if (direct !== undefined) return peelToNonTag(this.store, direct);
    if (/^[0-9a-f]{40}$/i.test(ref) && this.store.has(ref.toLowerCase())) return peelToNonTag(this.store, ref.toLowerCase());
    return null;
  }

  /** Branch names (short), sorted. */
  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  issueByNumber(number: number): Issue | undefined {
    return this.issues.find((issue) => issue.number === number);
  }

  pullByNumber(number: number): Pull | undefined {
    return this.pulls.find((pull) => pull.number === number);
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;
  private sequence = 0;

  private nextSeq(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo = new Repo(this.nextRepoId, owner, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  // -------------------------------------------------------------------------
  // Labels, issues, comments
  // -------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    const issue: Issue = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: tickIso(),
      updatedAt: '',
      createdSeq: this.nextSeq(),
      closedAt: null,
    };
    issue.updatedAt = issue.createdAt;
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createComment(issue: Issue, body: string): Comment {
    const comment: Comment = {
      id: this.nextCommentId,
      body,
      authorLogin: VIEWER.login,
      createdAt: tickIso(),
      updatedAt: '',
      createdSeq: this.nextSeq(),
    };
    comment.updatedAt = comment.createdAt;
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = repo.resolveRef(headRef);
    const baseSha = repo.resolveRef(baseRef);
    if (headSha === null || baseSha === null) return null;
    const pull: Pull = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body,
      headRef,
      baseRef,
      headSha,
      baseSha,
      state: 'open',
      merged: false,
      mergeSha: null,
      mergedAt: null,
      createdAt: tickIso(),
      updatedAt: '',
      createdSeq: this.nextSeq(),
    };
    pull.updatedAt = pull.createdAt;
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** The files a pull request changes (base tip tree vs head tip tree). */
  pullFiles(repo: Repo, pull: Pull): DiffFile[] {
    const headTip = repo.resolveRef(pull.headRef) ?? pull.headSha;
    const baseTip = repo.resolveRef(pull.baseRef) ?? pull.baseSha;
    const headCommit = headTip === null ? undefined : repo.store.get(headTip);
    const baseCommit = baseTip === null ? undefined : repo.store.get(baseTip);
    const headTree = headCommit?.type === 'commit' ? parseCommit(headCommit.data).tree : '';
    const baseTree = baseCommit?.type === 'commit' ? parseCommit(baseCommit.data).tree : '';
    return diffTrees(repo.store, baseTree, headTree);
  }

  /**
   * Three-way merge check for a squash merge: compare the merge base against
   * the base tip and the head tip. A path changed on both sides to different
   * content is a conflict. Returns the merged file map, or null on conflict.
   */
  private threeWayMerge(repo: Repo, pull: Pull): Map<string, FileEntry> | null {
    const headTip = repo.resolveRef(pull.headRef) ?? pull.headSha;
    const baseTip = repo.resolveRef(pull.baseRef) ?? pull.baseSha;
    if (headTip === null || baseTip === null) return null;
    const base = mergeBase(repo.store, baseTip, headTip);
    const treeOf = (tip: string | null): string => {
      if (tip === null) return '';
      const object = repo.store.get(tip);
      return object?.type === 'commit' ? parseCommit(object.data).tree : '';
    };
    const baseFiles = flattenTree(repo.store, treeOf(base));
    const oursFiles = flattenTree(repo.store, treeOf(baseTip));
    const theirsFiles = flattenTree(repo.store, treeOf(headTip));
    const merged = new Map<string, FileEntry>(oursFiles);
    const paths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const path of paths) {
      const ancestor = baseFiles.get(path);
      const ours = oursFiles.get(path);
      const theirs = theirsFiles.get(path);
      const ancestorOid = ancestor?.oid ?? null;
      const oursOid = ours?.oid ?? null;
      const theirsOid = theirs?.oid ?? null;
      if (oursOid === theirsOid) continue; // both sides agree (or both deleted)
      if (ancestorOid === oursOid) {
        // Only theirs changed: take theirs (or delete it).
        if (theirs === undefined) merged.delete(path);
        else merged.set(path, theirs);
        continue;
      }
      if (ancestorOid === theirsOid) continue; // only ours changed: keep ours
      return null; // both changed differently: conflict
    }
    return merged;
  }

  /** True when the pull request would merge cleanly (open and conflict-free). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    return this.threeWayMerge(repo, pull) !== null;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose parent
   * is the base tip and whose tree is the three-way merge result. Returns the
   * merge commit sha, or null on conflict.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open') return null;
    const mergedFiles = this.threeWayMerge(repo, pull);
    if (mergedFiles === null) return null;
    const baseTip = repo.resolveRef(pull.baseRef) ?? pull.baseSha;
    if (baseTip === null) return null;
    const treeOid = buildTreeFromFiles(repo.store, mergedFiles);
    const seconds = tickSeconds();
    const ident = identLine(gitIdentity(), seconds);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const commitOid = repo.store.put(
      'commit',
      buildCommit({ tree: treeOid, parents: [baseTip], author: ident, committer: ident, message }),
    );
    repo.setRef(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeSha = commitOid;
    pull.mergedAt = tickIso();
    pull.updatedAt = pull.mergedAt;
    return commitOid;
  }

  // -------------------------------------------------------------------------
  // Contents (file commits through the REST API)
  // -------------------------------------------------------------------------

  /** The commit a contents operation starts from: the branch tip, or the
   *  default branch tip when the branch does not exist yet (GitHub creates
   *  it from the default branch), or null for a root commit in an unborn repo. */
  private contentsParent(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? repo.defaultTip();
  }

  /**
   * Create a commit that sets (or removes) one file on a branch. `sha` is the
   * blob sha the caller believes the file currently has: when given and it
   * does not match, the write is stale (409). Returns the commit and the new
   * blob sha, or an error kind.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
    expectedSha?: string,
  ): { commitSha: string; contentSha: string | null } | { error: 'stale' | 'missing' | 'no-branch' } {
    const parent = this.contentsParent(repo, branch);
    const parentTree = parent === null ? '' : parseCommit(repo.store.get(parent)!.data).tree;
    const files = parent === null ? new Map<string, FileEntry>() : flattenTree(repo.store, parentTree);
    const current = files.get(path);
    if (expectedSha !== undefined) {
      if (current === undefined || current.oid.toLowerCase() !== expectedSha.toLowerCase()) return { error: 'stale' };
    }
    if (content === null) {
      if (current === undefined) return { error: 'missing' };
      files.delete(path);
    } else {
      const blobOid = repo.store.put('blob', content);
      files.set(path, { mode: current?.mode ?? '100644', oid: blobOid });
    }
    const treeOid = buildTreeFromFiles(repo.store, files);
    const seconds = tickSeconds();
    const ident = identLine(gitIdentity(), seconds);
    const commitOid = repo.store.put(
      'commit',
      buildCommit({
        tree: treeOid,
        parents: parent === null ? [] : [parent],
        author: ident,
        committer: ident,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    );
    repo.setRef(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = tickIso();
    const newEntry = content === null ? undefined : files.get(path);
    return { commitSha: commitOid, contentSha: newEntry?.oid ?? null };
  }

  /** Read one file (or list one directory) at a ref. */
  readPath(
    repo: Repo,
    ref: string,
    path: string,
  ): { kind: 'file'; entry: FileEntry; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string }> } | null {
    const tip = repo.resolveRef(ref);
    if (tip === null) return null;
    const commitObject = repo.store.get(tip);
    if (commitObject?.type !== 'commit') return null;
    const treeOid = parseCommit(commitObject.data).tree;
    const files = flattenTree(repo.store, treeOid);
    const file = files.get(path);
    if (file !== undefined) {
      const blob = repo.store.get(file.oid);
      if (blob === undefined) return null;
      return { kind: 'file', entry: file, data: blob.data };
    }
    // A directory: everything under `path/`, grouped one level down.
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { name: string; path: string; type: 'file' | 'dir'; oid: string }>();
    for (const [filePath, entry] of files) {
      if (prefix !== '' && !filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { name: rest, path: filePath, type: 'file', oid: entry.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          children.set(dirName, { name: dirName, path: `${prefix}${dirName}`, type: 'dir', oid: '' });
        }
      }
    }
    if (children.size === 0) return null;
    // Directory entries need their tree oid: resolve from the tree itself.
    const dirEntries = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of dirEntries) {
      if (entry.type === 'dir') entry.oid = this.treeOidAtPath(repo.store, treeOid, entry.path) ?? entry.oid;
    }
    return { kind: 'dir', entries: dirEntries };
  }

  private treeOidAtPath(store: ObjectStore, treeOid: string, path: string): string | null {
    if (path === '') return treeOid;
    const parts = path.split('/');
    let current = treeOid;
    for (const part of parts) {
      const object = store.get(current);
      if (object?.type !== 'tree') return null;
      const found = parseTree(object.data).find((entry) => entry.name === part && entry.mode === '40000');
      if (found === undefined) return null;
      current = found.oid;
    }
    return current;
  }

  /** Commits on a ref, newest first, with their messages. */
  listCommits(repo: Repo, ref: string): Array<{ sha: string; message: string }> {
    const tip = repo.resolveRef(ref);
    if (tip === null) return [];
    return listCommits(repo.store, tip).map((sha) => {
      const object = repo.store.get(sha);
      const raw = object?.type === 'commit' ? parseCommit(object.data).message : '';
      // The API presents the message without its trailing newline (the git
      // object keeps it, as git does).
      return { sha, message: raw.replace(/\n+$/, '') };
    });
  }

  /** True when `ancestor` is an ancestor of `commit` in this repo. */
  isAncestor(repo: Repo, ancestor: string, commit: string): boolean {
    return isAncestor(repo.store, ancestor, commit);
  }

  // -------------------------------------------------------------------------
  // Global ids (GraphQL)
  // -------------------------------------------------------------------------

  repoGlobalId(repo: Repo): string {
    return globalId('Repository', `${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
    return globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`);
  }

  /** Resolve a global id back to its object (repository, issue, pull). */
  resolveGlobalId(id: string): { kind: 'repository'; repo: Repo } | { kind: 'issue'; repo: Repo; issue: Issue } | { kind: 'pull'; repo: Repo; pull: Pull } | null {
    const parsed = (() => {
      try {
        const decoded = Buffer.from(id, 'base64url').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon <= 0) return null;
        return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
      } catch {
        return null;
      }
    })();
    if (parsed === null) return null;
    if (parsed.type === 'Repository') {
      const slash = parsed.key.indexOf('/');
      if (slash < 0) return null;
      const repo = this.getRepo(parsed.key.slice(0, slash), parsed.key.slice(slash + 1));
      return repo === undefined ? null : { kind: 'repository', repo };
    }
    if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
      const hash = parsed.key.lastIndexOf('#');
      const slash = parsed.key.indexOf('/');
      if (hash < 0 || slash < 0 || slash > hash) return null;
      const repo = this.getRepo(parsed.key.slice(0, slash), parsed.key.slice(slash + 1, hash));
      if (repo === undefined) return null;
      const number = Number(parsed.key.slice(hash + 1));
      if (!Number.isInteger(number)) return null;
      if (parsed.type === 'Issue') {
        const issue = repo.issueByNumber(number);
        return issue === undefined ? null : { kind: 'issue', repo, issue };
      }
      const pull = repo.pullByNumber(number);
      return pull === undefined ? null : { kind: 'pull', repo, pull };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// REST serialization
// ---------------------------------------------------------------------------

export function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.privateRepo,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(VIEWER.login, VIEWER.id),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.authorLogin, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  // head/base shas are the frozen creation-time tips: stable across reads and
  // across the base branch moving on merge.
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.headRef, sha: pull.headSha, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, repo: repoJson(repo) },
    user: userJson(VIEWER.login, VIEWER.id),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
  };
}
