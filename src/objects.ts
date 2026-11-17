// The git object model: SHA-1 object ids, blob/tree/commit/tag parsing and
// building, packfile reading (with full ofs/ref delta resolution, so real git
// clients' thin packs unpack) and writing (plain objects only — the suite's
// pack checks accept a delta-free pack), reachability walks with shallow and
// deepen support, ancestry, merge-base, and tree diffs for pull requests.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ZERO_OID } from './util.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** The object id of a type + raw bytes: sha1("<type> <len>\0" + data). */
export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** A git ident line: `Name <email> <unix-seconds> +0000`. */
export function identLine(identity: string, unixSeconds: number): string {
  return `${identity} ${unixSeconds} +0000`;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree entry (no space)');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree entry (no NUL)');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (oid.length !== 40) throw new Error('malformed tree entry (short oid)');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/**
 * Git's tree sort: entries sort by name, except directories sort as if their
 * name had a trailing slash. The on-disk mode for a directory is `40000`.
 */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface ParsedTag {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// The object store (one per repository)
// ---------------------------------------------------------------------------

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store an object, returning its id. */
  put(type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (from a pack). */
  putKnown(oid: string, object: GitObject): void {
    this.objects.set(oid, object);
  }

  size(): number {
    return this.objects.size;
  }
}

// ---------------------------------------------------------------------------
// Trees as flat file maps
// ---------------------------------------------------------------------------

export interface FileEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (recursively) into path -> file entry. Missing tree: empty. */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * Build tree objects for a flat file map, bottom-up, returning the root tree
 * oid. Intermediate trees are written into the store as they are built.
 */
export function buildTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, FileEntry>): string {
  interface DirNode {
    files: Map<string, FileEntry>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** The oid of the empty tree (well-known, constant). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function ensureEmptyTree(store: ObjectStore): string {
  if (!store.has(EMPTY_TREE_OID)) store.put('tree', Buffer.alloc(0));
  return EMPTY_TREE_OID;
}

// ---------------------------------------------------------------------------
// Reachability and negotiation
// ---------------------------------------------------------------------------

/** Peel a tag chain to the underlying non-tag object id. */
export function peelToNonTag(store: ObjectStore, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag' || seen.has(current)) return current;
    seen.add(current);
    current = parseTag(object.data).object;
  }
}

/**
 * Expand a set of objects into everything a pack must carry for them:
 * commits contribute their trees (recursively) and blobs, tags contribute
 * their target — but parents are NOT walked, so a depth-limited commit set
 * stays depth-limited. (The haves' closure, by contrast, does walk parents:
 * see reachableClosure.)
 */
export function expandObjects(store: ObjectStore, tips: readonly string[]): Set<string> {
  const found = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ZERO_OID || found.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    found.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '') queue.push(commit.tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return found;
}

/**
 * The full closure of objects reachable from a set of tips: commits (with
 * their parents), trees (recursively) and blobs, plus any tags in between.
 * `stopAt` commits are included themselves but their parents are not walked
 * (a shallow boundary the other side already holds).
 */
export function reachableClosure(
  store: ObjectStore,
  tips: readonly string[],
  stopAt: ReadonlySet<string> = new Set(),
): Set<string> {
  const found = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ZERO_OID || found.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    found.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '') queue.push(commit.tree);
      if (!stopAt.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return found;
}

export interface FetchPlan {
  /** Commits to include in the pack (already filtered against haves/depth). */
  commits: Set<string>;
  /** The new shallow boundary: included commits whose parents stay unsent. */
  shallow: string[];
  /** Old shallow commits whose parents are all now included. */
  unshallow: string[];
}

/**
 * Plan a fetch: which commits to send, given the wants, the haves, the
 * client's current shallow boundary, and an optional depth limit.
 *
 * Absolute depth (`deepen N` alone) counts generations from the wants:
 * depth 1 sends the wants only, depth 2 the wants plus their parents.
 * Relative depth (`deepen N` + `deepen-relative`) extends N generations
 * beyond the client's current shallow boundary: everything from the wants
 * down to the boundary, plus N more generations past it.
 *
 * A have that is not shallow is never sent and never walked past. A have
 * that IS shallow is not sent, but its parents are walked (that is what
 * deepening is for). The new boundary is every included commit with a
 * parent the client will not hold afterwards.
 */
export function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: ReadonlySet<string>,
  shallowHeld: ReadonlySet<string>,
  depth: number | null,
  relative = false,
): FetchPlan {
  const included = new Set<string>();
  const visited = new Map<string, number>(); // oid -> best (smallest) beyond-budget seen; -1 means "not past a boundary yet"
  // Tags themselves travel with their target; remember tag wants separately.
  const tagWants = new Set<string>();
  for (const want of wants) {
    const object = store.get(want);
    if (object !== undefined && object.type === 'tag') tagWants.add(want);
  }

  interface QueueEntry {
    oid: string;
    /** Edges from a want (absolute mode) or past a shallow boundary (relative; -1 = not past one yet). */
    depth: number;
  }
  const queue: QueueEntry[] = [];
  for (const want of wants) queue.push({ oid: peelToNonTag(store, want), depth: relative ? -1 : 0 });

  while (queue.length > 0) {
    const { oid, depth: at } = queue.shift() as QueueEntry;
    if (oid === ZERO_OID) continue;
    const best = visited.get(oid);
    if (best !== undefined && best <= at) continue;
    visited.set(oid, at);
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type !== 'commit') {
      if (!haves.has(oid)) included.add(oid);
      continue;
    }
    const isHave = haves.has(oid);
    const isShallowHeld = shallowHeld.has(oid);
    if (isHave && !isShallowHeld) {
      // Held in full: never sent, but the walk passes through — the shallow
      // boundary may live below the held commits (an --unshallow fetch's
      // want is itself held). Passing through is safe: everything below a
      // non-shallow have is held too, except past a shallow boundary, where
      // the have+shallow branch below applies the deepening rule.
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) queue.push({ oid: parent, depth: relative ? (at === -1 ? -1 : at + 1) : at + 1 });
      continue;
    }
    if (isHave && isShallowHeld) {
      // Held shallow: not sent. Its parents are walked only when the client
      // asked to deepen; a plain fetch leaves the boundary where it is.
      if (depth === null) continue;
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) {
        queue.push({ oid: parent, depth: relative ? 1 : at + 1 });
      }
      continue;
    }
    // Not a have: include it when it is inside the budget.
    if (relative) {
      if (at !== -1 && depth !== null && at > depth) continue;
    } else {
      const maxEdges = depth === null ? Number.POSITIVE_INFINITY : depth - 1;
      if (at > maxEdges) continue;
    }
    included.add(oid);
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      queue.push({ oid: parent, depth: relative ? (at === -1 ? -1 : at + 1) : at + 1 });
    }
  }

  // The new boundary: included commits with a parent the client will not
  // hold (neither sent in this fetch nor already held).
  const boundary = new Set<string>();
  for (const oid of included) {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.some((parent) => !included.has(parent) && !haves.has(parent))) boundary.add(oid);
  }

  const unshallow: string[] = [];
  for (const held of shallowHeld) {
    const object = store.get(held);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.length === 0) continue;
    const allCovered = commit.parents.every(
      (parent) => included.has(parent) || (haves.has(parent) && !shallowHeld.has(parent)),
    );
    if (allCovered) unshallow.push(held);
  }

  // Tag objects named by the wants travel in the pack too.
  for (const tag of tagWants) included.add(tag);

  return { commits: included, shallow: [...boundary].sort(), unshallow: unshallow.sort() };
}

/** True when `ancestor` is reachable from `commit` (or equal to it). */
export function isAncestor(store: ObjectStore, ancestor: string, commit: string): boolean {
  if (ancestor === commit) return true;
  const seen = new Set<string>();
  const queue = [commit];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    if (parsed.parents.includes(ancestor)) return true;
    for (const parent of parsed.parents) queue.push(parent);
  }
  return false;
}

/**
 * A merge base of two commits: the first common ancestor found by a
 * breadth-first walk from both sides (exact for the linear histories the
 * suite builds; a reasonable common ancestor otherwise).
 */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = new Map<string, number>();
  const queueA: Array<{ oid: string; depth: number }> = [{ oid: a, depth: 0 }];
  while (queueA.length > 0) {
    const { oid, depth } = queueA.shift() as { oid: string; depth: number };
    if (oid === ZERO_OID || fromA.has(oid)) continue;
    fromA.set(oid, depth);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push({ oid: parent, depth: depth + 1 });
  }
  const seenB = new Set<string>();
  const queueB: string[] = [b];
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const oid = queueB.shift() as string;
    if (oid === ZERO_OID || seenB.has(oid)) continue;
    seenB.add(oid);
    const depthA = fromA.get(oid);
    if (depthA !== undefined && depthA < bestDepth) {
      best = oid;
      bestDepth = depthA;
    }
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return best;
}

/** List commits reachable from a tip, newest first (topological-ish order). */
export function listCommits(store: ObjectStore, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_TYPE_TO_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TO_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/**
 * Write a packfile v2 holding plain (undeltified) objects. Deterministic
 * order: commits, then trees, then blobs, then tags, each sorted by oid.
 */
export function writePack(entries: readonly { oid: string; type: ObjectType; data: Buffer }[]): Buffer {
  const order: Record<ObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const sorted = [...entries].sort((a, b) => order[a.type] - order[b.type] || (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const entry of sorted) {
    const code = PACK_TYPE_TO_CODE[entry.type];
    const size = entry.data.length;
    const head: number[] = [];
    let remaining = size;
    let first = (code << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    head.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      head.push(byte);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and length. */
function inflateOne(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

/** Apply a git delta to a base buffer, returning the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint overruns the delta');
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} does not match base ${base.length}`);
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;
    if ((opcode & 0x80) !== 0) {
      // Copy from the base: offset/size bytes follow per the opcode's bits.
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy overruns the delta');
          copyOffset |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy overruns the delta');
          copySize |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy reads past the base');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      // Insert literal bytes.
      if (offset + opcode > delta.length) throw new Error('delta insert overruns the delta');
      out.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (produced !== targetSize) throw new Error(`delta produced ${produced} bytes, expected ${targetSize}`);
  return Buffer.concat(out);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile v2, resolving ofs-delta and ref-delta entries. Bases may
 * live in the pack itself or in the store the pack is applied to (thin packs
 * from real git clients); `resolveBase` is consulted for those. The trailer
 * checksum is verified. Every returned object is re-hashed to its id.
 */
export function readPack(
  pack: Buffer,
  resolveBase: (oid: string) => GitObject | undefined,
): ReadPackResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack lacks the PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(actual)) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    code: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  const end = pack.length - 20;
  for (let i = 0; i < count; i += 1) {
    if (offset >= end) throw new Error('pack ends before its declared object count');
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= end) throw new Error('pack object header overruns the pack');
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (code === 6) {
      // ofs-delta: a negative offset encoded big-endian base-128.
      if (offset >= end) throw new Error('ofs-delta offset overruns the pack');
      byte = pack[offset];
      offset += 1;
      let negative = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= end) throw new Error('ofs-delta offset overruns the pack');
        byte = pack[offset];
        offset += 1;
        negative = ((negative + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - negative;
      if (baseOffset < 12) throw new Error('ofs-delta base offset is out of range');
    } else if (code === 7) {
      if (offset + 20 > end) throw new Error('ref-delta base oid overruns the pack');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (PACK_CODE_TO_TYPE[code] === undefined) {
      throw new Error(`unknown pack object type code ${code}`);
    }
    const inflated = inflateOne(pack, offset);
    offset += inflated.consumed;
    raw.push({ offset: entryOffset, code, size, data: inflated.data, baseOffset, baseOid });
  }

  const byOffset = new Map<number, RawEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const resolved = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;

  const resolve = (entry: RawEntry, depth: number): GitObject => {
    if (depth > 1000) throw new Error('delta chain is too deep');
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let object: GitObject;
    if (entry.code === 6 || entry.code === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta names an unknown base offset');
        base = resolve(baseEntry, depth + 1);
      } else if (entry.baseOid !== undefined) {
        const inPack = [...resolved.values()].find((candidate) => objectId(candidate.type, candidate.data) === entry.baseOid);
        base = inPack ?? resolveBase(entry.baseOid);
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
      }
      if (base === undefined) throw new Error('delta entry has no base');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = PACK_CODE_TO_TYPE[entry.code];
      if (entry.data.length !== entry.size) throw new Error(`pack object size ${entry.data.length} does not match its header ${entry.size}`);
      object = { type, data: entry.data };
    }
    resolved.set(entry.offset, object);
    return object;
  };

  for (const entry of raw) {
    const object = resolve(entry, 0);
    objects.set(objectId(object.type, object.data), object);
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------
// Tree diffs (for pull-request file lists)
// ---------------------------------------------------------------------------

export interface DiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Count added/removed lines between two texts with an LCS diff. */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // A trailing newline makes split() yield a phantom empty line; drop it.
  if (oldText.endsWith('\n')) oldLines.pop();
  if (newText.endsWith('\n')) newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths, one row at a time (files here are small).
  let previous = new Array<number>(m + 1).fill(0);
  let current = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      current[j] = oldLines[i - 1] === newLines[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  const common = previous[m];
  return { additions: m - common, deletions: n - common };
}

/** Diff two trees (by oid) into per-file change records, sorted by path. */
export function diffTrees(store: ObjectStore, oldTreeOid: string, newTreeOid: string): DiffFile[] {
  const oldFiles = oldTreeOid === '' ? new Map<string, FileEntry>() : flattenTree(store, oldTreeOid);
  const newFiles = newTreeOid === '' ? new Map<string, FileEntry>() : flattenTree(store, newTreeOid);
  const paths = new Set<string>([...oldFiles.keys(), ...newFiles.keys()]);
  const out: DiffFile[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const blob = store.get(newEntry.oid);
      const text = blob === undefined ? '' : blob.data.toString('utf8');
      const { additions } = lineDiffCounts('', text);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const blob = store.get(oldEntry.oid);
      const text = blob === undefined ? '' : blob.data.toString('utf8');
      const { deletions } = lineDiffCounts(text, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const oldBlob = store.get(oldEntry.oid);
      const newBlob = store.get(newEntry.oid);
      const oldText = oldBlob === undefined ? '' : oldBlob.data.toString('utf8');
      const newText = newBlob === undefined ? '' : newBlob.data.toString('utf8');
      const { additions, deletions } = lineDiffCounts(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}
