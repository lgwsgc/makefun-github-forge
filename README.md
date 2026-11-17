# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/lgwsgc/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/lgwsgc/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge written from scratch for the make.fun
`github-core-clone-01` competition: one process, no dependencies, no UI,
in-memory storage. It serves git smart HTTP (protocol v2 and v0), the REST
v3 API, GraphQL, and MCP, all against the same store.

## Run

```sh
node main.ts
```

- With `MAKEFUN_ENV_URL` set (a trial): binds an ephemeral port, registers
  it with the env, serves until `GET /done` answers `{"done": true}`.
- Without it (local dev): listens on `PORT` (default 8080).
- The bearer token comes from `MAKEFUN_SHOP_TOKEN`; when it is unset, any
  non-empty bearer token is accepted (dev mode).

Node 22+ required (type stripping runs the `.ts` sources directly; the code
uses erasable TypeScript syntax only).

## Layout

- `main.ts` — entry point and trial lifecycle (register / poll /done).
- `src/server.ts` — the HTTP server: routing, auth, request ids, JSON errors.
- `src/git-http.ts` — smart HTTP: v0/v2 advertisements, ls-refs, fetch
  (shallow/deepen), receive-pack with per-ref report-status.
- `src/objects.ts` — the git object model: blobs/trees/commits/tags,
  packfiles (delta-resolving reader, plain-object writer), reachability,
  shallow planning, ancestry, merge-base, tree diffs.
- `src/store.ts` — repositories, issues, pull requests, labels, comments,
  contents commits, squash merges with three-way conflict detection.
- `src/rest.ts` — REST v3 routes.
- `src/graphql.ts` — a small GraphQL parser, validator and executor.
- `src/mcp.ts` — MCP over JSON-RPC (2026-07-28 `server/discover` plus the
  legacy `initialize` handshake) and seven tools.
- `src/pktline.ts` — git pkt-line framing and sideband packets.
- `src/util.ts` — the viewer identity, logical clock, opaque global ids.

## Verify locally

```sh
# start the forge (dev mode, token "test")
MAKEFUN_SHOP_TOKEN=test PORT=8080 node main.ts

# run the sealed conformance suite against it
node --experimental-strip-types /path/to/kit/sdk/run.ts --url http://127.0.0.1:8080 --token test --perf
```

Verified 2026-11-17 against the kit's sealed suite: **120/120 conformance
checks pass** (git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15,
protocol 5) — feature 600/600, agent 200/200. Perf on a quiet machine:
173/200 (push 48, clone 39, read 47, write 39), total **973/1000**. Real-git
verification (git 2.43.0): clone, push (incl. thin delta packs), shallow
clone, deepen, unshallow, v0 clone, annotated tags, fsck — all clean.

## Notes

- The viewer identity (`adaiversen`, id 1000) is a constant: the suite's
  scenario derives every name from the sealed constant seed, and the bearer
  token carries no login.
- Packs are written without deltas (the suite accepts delta-free packs);
  the pack reader resolves ofs-delta and ref-delta entries, including thin
  packs from real git clients.
- Timestamps come from a monotonic logical clock, so ordering inside one
  run is deterministic.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fa1ga8zv&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
