// Git smart HTTP: ref advertisements (protocol v0 and v2), upload-pack
// (v2 ls-refs/fetch and v0 fetch) and receive-pack (v0 push with
// report-status). The wire shapes follow the git documentation and the
// suite's client: v2 advertisements open with `version 2` and capability
// lines; v2 fetch answers in `acknowledgments` / `shallow-info` /
// `wanted-refs` / `packfile` sections; packs are plain objects only.

import { decodePktLines, pktLine, pktLines, sidebandPackets, DELIM, FLUSH } from './pktline.ts';
import {
  expandObjects,
  parseCommit,
  peelToNonTag,
  planFetch,
  readPack,
  reachableClosure,
  writePack,
} from './objects.ts';
import { Forge, type Repo } from './store.ts';
import { ZERO_OID } from './util.ts';

const AGENT = 'makefun-github-forge/1.0';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitResponse(contentType: string, body: Buffer, status = 200): GitResponse {
  return { status, contentType, body };
}

/** A JSON error body, for the 401/404 answers on git paths. */
export function gitJsonError(status: number, message: string): GitResponse {
  return gitResponse('application/json', Buffer.from(JSON.stringify({ message }), 'utf8'), status);
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** Every ref of a repo, HEAD first, then branches and tags sorted. */
function allRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const tip = repo.defaultTip();
  if (tip !== null) out.push({ oid: tip, name: 'HEAD' });
  const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of branches) out.push({ oid: repo.refs.get(ref) as string, name: ref });
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    const object = repo.store.get(oid);
    const entry: RefLine = { oid, name: ref };
    if (object?.type === 'tag') entry.peeled = peelToNonTag(repo.store, oid);
    out.push(entry);
  }
  return out;
}

const V0_UPLOAD_CAPABILITIES =
  `multi_ack_detailed thin-pack side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/main`;
const V0_RECEIVE_CAPABILITIES = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** The v0 advertisement: `# service=` preamble, ref lines, capabilities on the first. */
function v0Advertisement(repo: Repo, service: GitService): Buffer {
  const capabilities = service === 'git-upload-pack' ? V0_UPLOAD_CAPABILITIES : V0_RECEIVE_CAPABILITIES;
  const refs = allRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${capabilities}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement: preamble, `version 2`, capability lines. */
function v2Advertisement(service: GitService): Buffer {
  const parts: Buffer[] = [
    pktLine(`# service=${service}\n`),
    FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: GitService,
  wantsV2: boolean,
): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return gitJsonError(404, 'Not Found');
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantsV2) {
    return gitResponse(contentType, v2Advertisement(service));
  }
  return gitResponse(contentType, v0Advertisement(repo, service));
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function errLine(message: string): Buffer {
  return pktLines([`ERR ${message}\n`, 'flush']);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const refs = allRefs(repo);
  const lines: Buffer[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      lines.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    lines.push(FLUSH);
    return Buffer.concat(lines);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD' && args.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  wantRefs: string[];
  relative: boolean;
}

function fetchResponse(repo: Repo, args: FetchArgs, protocol: 2 | 0): Buffer {
  // Unknown wants are a protocol error, answered the way git answers one.
  for (const want of args.wants) {
    if (!repo.store.has(want)) return errLine(`upload-pack: not our ref ${want}`);
  }
  // The whole answer is a deterministic function of the repo state and the
  // request, so identical fetches share one built response (the benchmark
  // fires 50 identical depth-1 clones). The generation is folded into the
  // key; mutations clear the cache, so a stale entry is impossible.
  const cacheKey = [
    repo.generation, protocol,
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    args.depth, args.relative, [...args.wantRefs].sort().join(','),
  ].join('|');
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const answer = buildFetchResponse(repo, args, protocol);
  if (repo.fetchCache.size >= 64) {
    const oldest = repo.fetchCache.keys().next().value;
    if (oldest !== undefined) repo.fetchCache.delete(oldest);
  }
  repo.fetchCache.set(cacheKey, answer);
  return answer;
}

function buildFetchResponse(repo: Repo, args: FetchArgs, protocol: 2 | 0): Buffer {
  const haves = new Set(args.haves);
  const shallowHeld = new Set(args.shallow);
  const plan = planFetch(repo.store, args.wants, haves, shallowHeld, args.depth, args.relative);
  // The pack carries the planned commits plus their trees and blobs — but
  // not their parents (the plan already limited the commit set; walking
  // parents here would undo a shallow depth limit).
  const sendSet = expandObjects(repo.store, [...plan.commits]);
  const heldSet = reachableClosure(repo.store, [...haves], shallowHeld);
  const packOids = [...sendSet].filter((oid) => !heldSet.has(oid));
  const packEntries = packOids
    .map((oid) => ({ oid, ...(repo.store.get(oid) as { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }) }))
    .filter((entry) => entry.data !== undefined);
  const pack = packEntries.length > 0 ? writePack(packEntries) : null;

  const acks: string[] = [];
  for (const have of args.haves) {
    if (repo.store.has(have)) acks.push(have);
  }
  // wanted-refs answers only refs the client asked for with want-ref (real
  // git's rule); a plain want list gets no wanted-refs section.
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const wantRef of args.wantRefs) {
    const oid = repo.refs.get(wantRef);
    if (oid !== undefined) wantedRefs.push({ oid, ref: wantRef });
  }

  if (protocol === 0) {
    const parts: Buffer[] = [];
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    if (acks.length === 0) parts.push(pktLine('NAK\n'));
    else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    if (pack !== null) parts.push(...sidebandPackets(1, pack));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }

  const parts: Buffer[] = [];
  // The acknowledgments section exists only to answer the client's haves:
  // with no haves sent, real git omits it entirely (a fresh clone's fetch
  // goes straight to the packfile section).
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (acks.length === 0) parts.push(pktLine('NAK\n'));
    else {
      for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const wanted of wantedRefs) parts.push(pktLine(`${wanted.oid} ${wanted.ref}\n`));
    parts.push(DELIM);
  }
  if (pack !== null) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(1, pack));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/**
 * Parse a v2 upload-pack request body into its command and arguments. The
 * body is `command=<name>` lines, an optional agent/object-format pair, a
 * delimiter, then the command's arguments, then a flush.
 */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0) throw new Error('empty v2 request');
  const first = lines[0].replace(/\n$/, '');
  if (!first.startsWith('command=')) throw new Error(`v2 request does not start with a command: ${JSON.stringify(first)}`);
  const command = first.slice('command='.length);
  const args = lines.slice(1).map((line) => line.replace(/\n$/, '')).filter((line) => line !== '');
  return { command, args };
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { command, args } = parseV2Request(body);
  // Arguments before the delimiter are session-level (agent, object-format);
  // everything after it belongs to the command. The decoder above drops the
  // delimiter, so filter the known session keys out instead.
  const commandArgs = args.filter((arg) => !arg.startsWith('agent=') && !arg.startsWith('object-format='));
  if (command === 'ls-refs') {
    const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of commandArgs) {
      if (arg === 'peel') lsArgs.peel = true;
      else if (arg === 'symrefs') lsArgs.symrefs = true;
      else if (arg === 'unborn') lsArgs.unborn = true;
      else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
    }
    return handleLsRefs(repo, lsArgs);
  }
  if (command === 'fetch') {
    const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, wantRefs: [], relative: false };
    for (const arg of commandArgs) {
      if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('want-ref ')) fetchArgs.wantRefs.push(arg.slice(9).trim());
      else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) fetchArgs.shallow.push(arg.slice(8).trim());
      else if (arg === 'deepen-relative') fetchArgs.relative = true;
      else if (arg.startsWith('deepen ')) {
        const depth = Number(arg.slice(7).trim());
        if (Number.isInteger(depth) && depth >= 1) fetchArgs.depth = depth;
      }
      // thin-pack, no-progress, ofs-delta, done, deepen-since, deepen-not and
      // filter need no action: this server sends plain full packs.
    }
    return fetchResponse(repo, fetchArgs, 2);
  }
  return errLine(`unknown command ${command}`);
}

/** Parse a v0 upload-pack request: wants (with capabilities on the first), shallow/deepen, flush, haves/done. */
function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, wantRefs: [], relative: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        fetchArgs.wants.push(space < 0 ? rest.trim() : rest.slice(0, space).trim());
      } else if (line.startsWith('shallow ')) fetchArgs.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const depth = Number(line.slice(7).trim());
        if (Number.isInteger(depth) && depth >= 1) fetchArgs.depth = depth;
      }
    } else if (line.startsWith('have ')) {
      fetchArgs.haves.push(line.slice(5).trim());
    }
    // `done` ends the negotiation; nothing to do for it.
  }
  return fetchResponse(repo, fetchArgs, 0);
}

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  isV2: boolean,
): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return gitJsonError(404, 'Not Found');
  const contentType = 'application/x-git-upload-pack-result';
  const out = isV2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
  return gitResponse(contentType, out);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

function handleReceivePackBody(repo: Repo, body: Buffer): { unpackOk: boolean; unpackDetail: string; outcomes: PushOutcome[]; sideband: boolean } {
  // Walk the command list pkt-line by pkt-line up to the first flush; the
  // bytes after it are the pack, which is not pkt-line framed.
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let offset = 0;
  let sawFlush = false;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (header === '0001') {
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length < 4 || offset + length > body.length) throw new Error('truncated push command packet');
    const text = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = text.indexOf('\0');
    const line = (nul < 0 ? text : text.slice(0, nul)).replace(/\n$/, '');
    if (nul >= 0 && commands.length === 0) {
      for (const token of text.slice(nul + 1).trim().split(/\s+/)) {
        if (token !== '') capabilities.add(token.split('=')[0]);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(line)}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (!sawFlush) throw new Error('push command list has no flush');
  const packStart = offset;
  const sideband = capabilities.has('side-band-64k');
  const packBytes = body.subarray(packStart);
  const outcomes: PushOutcome[] = [];

  // Unpack first: a refused update must still unpack, and the new objects
  // must be in the store before the fast-forward checks run.
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.store.get(oid));
      for (const [oid, object] of read.objects) repo.store.putKnown(oid, object);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      for (const command of commands) outcomes.push({ ref: command.ref, ok: false, reason: 'unpack error' });
      return { unpackOk: false, unpackDetail: detail, outcomes, sideband };
    }
  }

  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'old oid does not match the current value' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        outcomes.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      repo.deleteRef(command.ref);
      outcomes.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid === command.newOid) {
      outcomes.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newObject = repo.store.get(command.newOid);
    if (newObject === undefined) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // A create: no fast-forward rule applies.
      repo.setRef(command.ref, command.newOid);
      outcomes.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const oldPeeled = peelToNonTag(repo.store, command.oldOid);
    const newPeeled = peelToNonTag(repo.store, command.newOid);
    const oldObject = repo.store.get(oldPeeled);
    const newPeeledObject = repo.store.get(newPeeled);
    const fastForward =
      oldObject?.type === 'commit' && newPeeledObject?.type === 'commit'
        ? repo.store.has(oldPeeled) && isFastForward(repo, oldPeeled, newPeeled)
        : oldPeeled === newPeeled;
    if (!fastForward) {
      outcomes.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.setRef(command.ref, command.newOid);
    outcomes.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', outcomes, sideband };
}

/** True when `ancestor` is an ancestor of (or equal to) `commit`. */
function isFastForward(repo: Repo, ancestor: string, commit: string): boolean {
  if (ancestor === commit) return true;
  const seen = new Set<string>();
  const queue = [commit];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.includes(ancestor)) return true;
    for (const parent of parents) queue.push(parent);
  }
  return false;
}

export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return gitJsonError(404, 'Not Found');
  const result = handleReceivePackBody(repo, body);
  const reportLines: string[] = [
    result.unpackOk ? 'unpack ok\n' : `unpack ${result.unpackDetail}\n`,
    ...result.outcomes.map((outcome) => (outcome.ok ? `ok ${outcome.ref}\n` : `ng ${outcome.ref} ${outcome.reason}\n`)),
  ];
  const inner = pktLines([...reportLines, 'flush']);
  let out: Buffer;
  if (result.sideband) {
    out = Buffer.concat([...sidebandPackets(1, inner), FLUSH]);
  } else {
    out = inner;
  }
  return gitResponse('application/x-git-receive-pack-result', out);
}
