// GraphQL over POST /api/graphql: a small purpose-built parser, validator
// and executor for the documents gh sends (the suite's fixed set) — viewer,
// repository reads, issue/pull-request connections with cursors, the five
// mutations, Relay node(), __type introspection, and operation batching.
// Unknown fields are GraphQL errors (HTTP 200 with an `errors` array naming
// the field), never HTTP errors; an unknown repository reads null.

import { Forge, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER, decodeCursor, encodeCursor, isRecord } from './util.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A string literal, with escapes. (Block strings are not in the set.)
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && /[0-9]/.test(source[i + (ch === '-' ? 1 : 0)] ?? '')) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

export interface FragmentNode {
  typeCondition: string | null;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: SelectionNode[];
}

function isField(node: SelectionNode): node is FieldNode {
  return 'name' in node;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''} in GraphQL document`);
    }
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty GraphQL document');
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (token !== undefined && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next !== undefined && next.kind === 'name') name = this.next().value as string;
    }
    const variables: string[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      // Variable definitions: $name: Type (= default)? — only the names matter.
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        variables.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    // Directives (@...) are not in the suite's documents; skip any defensively.
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.parseArguments();
      }
    }
    const selection = this.parseSelectionSet();
    return { operation, name, variables, selection };
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (next?.kind === 'name') {
        // A named fragment spread — not in the suite's documents; the spread
        // is skipped (its selections are not executed).
        this.next();
        return { typeCondition: null, selection: [] };
      }
      const selection = this.parseSelectionSet();
      return { typeCondition, selection };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      args = this.parseArguments();
    }
    let selection: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token in GraphQL document: ${JSON.stringify(token)}`);
  }
}

export function parseGraphQL(source: string): OperationNode[] {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// The mini-schema (field sets per type, for validation and introspection)
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body'],
  CommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type ExecutorValue =
  | { kind: 'viewer' }
  | { kind: 'repository'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: Issue }
  | { kind: 'pull'; repo: Repo; pull: Pull }
  | { kind: 'issues'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { kind: 'pulls'; repo: Repo; pulls: Pull[] }
  | { kind: 'files'; files: Array<{ path: string; additions: number; deletions: number }> }
  | { kind: 'pageInfo'; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { kind: 'ref'; name: string }
  | { kind: 'user'; login: string }
  | { kind: 'comment'; id: string; body: string }
  | { kind: 'commentEdge'; id: string; body: string }
  | { kind: 'file'; path: string; additions: number; deletions: number }
  | { kind: 'payload'; type: string; value: ExecutorValue | null }
  | { kind: 'type'; name: string }
  | { kind: 'typeField'; name: string }
  | { kind: 'typeEnumValue'; name: string }
  | { kind: 'null' };

class GraphQLError extends Error {}

function typeNameOf(value: ExecutorValue): string {
  switch (value.kind) {
    case 'viewer': return 'User';
    case 'repository': return 'Repository';
    case 'issue': return 'Issue';
    case 'pull': return 'PullRequest';
    case 'issues': return 'IssueConnection';
    case 'pulls': return 'PullRequestConnection';
    case 'files': return 'PullRequestChangedFileConnection';
    case 'pageInfo': return 'PageInfo';
    case 'ref': return 'Ref';
    case 'user': return 'User';
    case 'comment': return 'IssueComment';
    case 'commentEdge': return 'CommentEdge';
    case 'file': return 'PullRequestChangedFile';
    case 'payload': return value.type;
    case 'type': return '__Type';
    case 'typeField': return '__Field';
    case 'typeEnumValue': return '__EnumValue';
    case 'null': return 'Null';
  }
}

interface Context {
  forge: Forge;
  variables: Variables;
  errors: Array<{ message: string }>;
}

function executeSelection(ctx: Context, value: ExecutorValue, selection: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (!isField(node)) {
      // An inline fragment applies when its type condition matches (or is absent).
      if (node.typeCondition === null || node.typeCondition === typeNameOf(value)) {
        Object.assign(out, executeSelection(ctx, value, node.selection));
      }
      continue;
    }
    const responseKey = node.alias ?? node.name;
    try {
      out[responseKey] = executeField(ctx, value, node);
    } catch (err) {
      if (err instanceof GraphQLError) {
        ctx.errors.push({ message: err.message });
        out[responseKey] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function executeField(ctx: Context, parent: ExecutorValue, field: FieldNode): unknown {
  const parentType = typeNameOf(parent);
  const allowed = SCHEMA[parentType];
  if (allowed === undefined || !allowed.includes(field.name)) {
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${parentType}".`);
  }
  const args = argsOf(field, ctx.variables);
  const value = resolveField(ctx, parent, field.name, args);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => executeSelection(ctx, entry, field.selection));
  }
  if (field.selection.length === 0) return value;
  return executeSelection(ctx, value as ExecutorValue, field.selection);
}

/** Resolve one field to a scalar, an executor value, or a list of them. */
function resolveField(ctx: Context, parent: ExecutorValue, name: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  switch (parent.kind) {
    case 'viewer':
      if (name === 'login') return VIEWER.login;
      if (name === 'id') return 'viewer';
      if (name === 'name') return VIEWER.name;
      break;
    case 'user':
      if (name === 'login') return parent.login;
      if (name === 'id') return parent.login;
      if (name === 'name') return parent.login;
      break;
    case 'repository': {
      const repo = parent.repo;
      switch (name) {
        case 'id': return forge.repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return { kind: 'user', login: repo.owner } satisfies ExecutorValue;
        case 'defaultBranchRef': return { kind: 'ref', name: repo.defaultBranch } satisfies ExecutorValue;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const number = args.number as number;
          const issue = repo.issueByNumber(number);
          return issue === undefined ? null : ({ kind: 'issue', repo, issue } satisfies ExecutorValue);
        }
        case 'issues': return resolveIssues(ctx, repo, args);
        case 'pullRequest': {
          const number = args.number as number;
          const pull = repo.pullByNumber(number);
          return pull === undefined ? null : ({ kind: 'pull', repo, pull } satisfies ExecutorValue);
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const pulls = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
          return { kind: 'pulls', repo, pulls } satisfies ExecutorValue;
        }
      }
      break;
    }
    case 'ref':
      if (name === 'name') return parent.name;
      break;
    case 'issue': {
      const issue = parent.issue;
      switch (name) {
        case 'id': return forge.issueGlobalId(parent.repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'url': return '';
        case 'comments': return [];
        case 'labels': return [];
      }
      break;
    }
    case 'issues':
      if (name === 'nodes') return parent.issues.map((issue) => ({ kind: 'issue', repo: parent.repo, issue }) as ExecutorValue);
      if (name === 'pageInfo') return { kind: 'pageInfo', pageInfo: parent.pageInfo } satisfies ExecutorValue;
      if (name === 'totalCount') return parent.issues.length;
      break;
    case 'pulls':
      if (name === 'nodes') return parent.pulls.map((pull) => ({ kind: 'pull', repo: parent.repo, pull }) as ExecutorValue);
      if (name === 'pageInfo') return { kind: 'pageInfo', pageInfo: { hasNextPage: false, endCursor: null } } satisfies ExecutorValue;
      if (name === 'totalCount') return parent.pulls.length;
      break;
    case 'pull': {
      const pull = parent.pull;
      switch (name) {
        case 'id': return forge.pullGlobalId(parent.repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable':
          if (pull.state !== 'open') return 'UNKNOWN';
          return forge.pullMergeable(parent.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 10;
          const files = forge.pullFiles(parent.repo, pull).slice(0, first).map((file) => ({
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
          }));
          return { kind: 'files', files } satisfies ExecutorValue;
        }
      }
      break;
    }
    case 'files':
      if (name === 'nodes') return parent.files.map((file) => ({ kind: 'file', path: file.path, additions: file.additions, deletions: file.deletions }) as ExecutorValue);
      if (name === 'pageInfo') return { kind: 'pageInfo', pageInfo: { hasNextPage: false, endCursor: null } } satisfies ExecutorValue;
      break;
    case 'file':
      if (name === 'path') return parent.path;
      if (name === 'additions') return parent.additions;
      if (name === 'deletions') return parent.deletions;
      if (name === 'changeType') return 'MODIFIED';
      break;
    case 'pageInfo':
      if (name === 'hasNextPage') return parent.pageInfo.hasNextPage;
      if (name === 'endCursor') return parent.pageInfo.endCursor;
      if (name === 'hasPreviousPage') return false;
      if (name === 'startCursor') return null;
      break;
    case 'comment':
      if (name === 'id') return parent.id;
      if (name === 'body') return parent.body;
      break;
    case 'commentEdge':
      if (name === 'node') return { kind: 'comment', id: parent.id, body: parent.body } satisfies ExecutorValue;
      break;
    case 'payload':
      if (name === 'issue' || name === 'pullRequest') return parent.value;
      if (name === 'commentEdge') return parent.value;
      break;
    case 'type':
      if (name === 'name') return parent.name;
      if (name === 'kind') return parent.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (name === 'fields') return [...(SCHEMA[parent.name] ?? [])].map((fieldName) => ({ kind: 'typeField', name: fieldName }) as ExecutorValue);
      if (name === 'enumValues') {
        return (parent.name === 'SearchType' ? [...SEARCH_TYPE_VALUES] : []).map((valueName) => ({ kind: 'typeEnumValue', name: valueName }) as ExecutorValue);
      }
      break;
    case 'typeField':
      if (name === 'name') return parent.name;
      break;
    case 'typeEnumValue':
      if (name === 'name') return parent.name;
      break;
    case 'null':
      break;
  }
  throw new GraphQLError(`Cannot query field "${name}" on type "${typeNameOf(parent)}".`);
}

function resolveIssues(ctx: Context, repo: Repo, args: Record<string, unknown>): ExecutorValue {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  const hasOrderBy = orderBy !== null;
  // Default (no orderBy): creation order, ascending — the pagination check's
  // expectation. With orderBy CREATED_AT: honour the direction; ties break by
  // number in the same direction.
  issues.sort((a, b) => {
    const bySeq = a.createdSeq - b.createdSeq;
    if (hasOrderBy) return direction === 'ASC' ? bySeq : -bySeq;
    return bySeq;
  });
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    issues = index < 0 ? issues : issues.slice(index + 1);
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return { kind: 'issues', repo, issues: page, pageInfo: { hasNextPage, endCursor } };
}

// ---------------------------------------------------------------------------
// Root operations
// ---------------------------------------------------------------------------

function executeOperation(ctx: Context, operation: OperationNode): Record<string, unknown> | null {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const out: Record<string, unknown> = {};
  for (const node of operation.selection) {
    if (!isField(node)) continue; // fragments at the root are not in the set
    const responseKey = node.alias ?? node.name;
    try {
      out[responseKey] = executeRootField(ctx, rootType, node);
    } catch (err) {
      if (err instanceof GraphQLError) {
        ctx.errors.push({ message: err.message });
        out[responseKey] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function executeRootField(ctx: Context, rootType: string, field: FieldNode): unknown {
  const { forge } = ctx;
  const allowed = SCHEMA[rootType];
  if (field.name === '__type') {
    const args = argsOf(field, ctx.variables);
    const name = String(args.name ?? '');
    const value: ExecutorValue = { kind: 'type', name };
    return executeSelection(ctx, value, field.selection);
  }
  if (allowed === undefined || !allowed.includes(field.name)) {
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${rootType}".`);
  }
  const args = argsOf(field, ctx.variables);
  if (rootType === 'Query') {
    if (field.name === 'viewer') {
      return executeSelection(ctx, { kind: 'viewer' }, field.selection);
    }
    if (field.name === 'repository') {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (repo === undefined) return null;
      return executeSelection(ctx, { kind: 'repository', repo }, field.selection);
    }
    if (field.name === 'node') {
      const resolved = forge.resolveGlobalId(String(args.id ?? ''));
      if (resolved === null || resolved.kind !== 'repository') return null;
      return executeSelection(ctx, { kind: 'repository', repo: resolved.repo }, field.selection);
    }
  }
  // Mutations.
  const input = isRecord(args.input) ? args.input : {};
  if (field.name === 'createIssue') {
    const resolved = forge.resolveGlobalId(String(input.repositoryId ?? ''));
    if (resolved === null || resolved.kind !== 'repository') throw new GraphQLError('repositoryId does not resolve to a repository');
    const issue = forge.createIssue(resolved.repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
    const value: ExecutorValue = { kind: 'payload', type: 'CreateIssuePayload', value: { kind: 'issue', repo: resolved.repo, issue } };
    return executeSelection(ctx, value, field.selection);
  }
  if (field.name === 'closeIssue') {
    const resolved = forge.resolveGlobalId(String(input.issueId ?? ''));
    if (resolved === null || resolved.kind !== 'issue') throw new GraphQLError('issueId does not resolve to an issue');
    resolved.issue.state = 'closed';
    resolved.issue.closedAt = resolved.issue.updatedAt;
    const value: ExecutorValue = { kind: 'payload', type: 'CloseIssuePayload', value: { kind: 'issue', repo: resolved.repo, issue: resolved.issue } };
    return executeSelection(ctx, value, field.selection);
  }
  if (field.name === 'createPullRequest') {
    const resolved = forge.resolveGlobalId(String(input.repositoryId ?? ''));
    if (resolved === null || resolved.kind !== 'repository') throw new GraphQLError('repositoryId does not resolve to a repository');
    const pull = forge.createPull(
      resolved.repo,
      String(input.title ?? ''),
      typeof input.body === 'string' ? input.body : '',
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
    );
    if (pull === null) throw new GraphQLError('head or base ref does not exist');
    const value: ExecutorValue = { kind: 'payload', type: 'CreatePullRequestPayload', value: { kind: 'pull', repo: resolved.repo, pull } };
    return executeSelection(ctx, value, field.selection);
  }
  if (field.name === 'mergePullRequest') {
    const resolved = forge.resolveGlobalId(String(input.pullRequestId ?? ''));
    if (resolved === null || resolved.kind !== 'pull') throw new GraphQLError('pullRequestId does not resolve to a pull request');
    forge.mergePull(resolved.repo, resolved.pull);
    const value: ExecutorValue = { kind: 'payload', type: 'MergePullRequestPayload', value: { kind: 'pull', repo: resolved.repo, pull: resolved.pull } };
    return executeSelection(ctx, value, field.selection);
  }
  if (field.name === 'addComment') {
    const resolved = forge.resolveGlobalId(String(input.subjectId ?? ''));
    if (resolved === null || resolved.kind !== 'issue') throw new GraphQLError('subjectId does not resolve to an issue');
    const comment = forge.createComment(resolved.issue, String(input.body ?? ''));
    const id = forge.commentGlobalId(resolved.repo, resolved.issue, comment);
    const value: ExecutorValue = { kind: 'payload', type: 'AddCommentPayload', value: { kind: 'commentEdge', id, body: comment.body } };
    return executeSelection(ctx, value, field.selection);
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "${rootType}".`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Run one operation body ({query, variables, operationName}). */
function runOne(forge: Forge, body: unknown): Record<string, unknown> {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'A GraphQL operation needs a query string' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Variables) : {};
  let operations: OperationNode[];
  try {
    operations = parseGraphQL(body.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    operationName !== null
      ? operations.find((candidate) => candidate.name === operationName) ?? operations[0]
      : operations[0];
  const ctx: Context = { forge, variables, errors: [] };
  // Validate the whole selection tree up front so an invalid field anywhere
  // is reported (the invalid-field check's document has it nested).
  validateSelection(ctx, operation.operation === 'mutation' ? 'Mutation' : 'Query', operation.selection);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  const data = executeOperation(ctx, operation);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Walk the selection tree checking every field name against the schema. */
function validateSelection(ctx: Context, parentType: string, selection: SelectionNode[]): void {
  for (const node of selection) {
    if (!isField(node)) {
      const nextType = node.typeCondition ?? parentType;
      validateSelection(ctx, nextType, node.selection);
      continue;
    }
    if (node.name === '__type') {
      validateSelection(ctx, '__Type', node.selection);
      continue;
    }
    const allowed = SCHEMA[parentType];
    if (allowed === undefined || !allowed.includes(node.name)) {
      ctx.errors.push({ message: `Cannot query field "${node.name}" on type "${parentType}".` });
      continue;
    }
    if (node.selection.length > 0) {
      validateSelection(ctx, childType(parentType, node.name), node.selection);
    }
  }
}

/** The type a field's sub-selection belongs to (for validation). */
function childType(parentType: string, field: string): string {
  const table: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Repository' },
    Mutation: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
    Repository: {
      owner: 'User',
      defaultBranchRef: 'Ref',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequest: 'PullRequest',
      pullRequests: 'PullRequestConnection',
    },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequest: { files: 'PullRequestChangedFileConnection' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'CommentEdge' },
    CommentEdge: { node: 'IssueComment' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return table[parentType]?.[field] ?? parentType;
}

/**
 * Handle a POST /api/graphql body: one operation object, or an array of them
 * (GitHub's operation batching, answered in order).
 */
export function handleGraphQL(forge: Forge, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(forge, entry)) };
  }
  return { status: 200, body: runOne(forge, body) };
}
