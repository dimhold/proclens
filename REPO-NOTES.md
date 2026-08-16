# Repo notes

Settings to apply when this repository is published on GitHub. Not shipped in the npm package.

## Name

`proclens`

## Description (one line, for the repo header)

> Identify look-alike node/python/agent processes: full command line, working directory, the ports they hold, and which one is the orphan holding your port.

## Topics

```
cli
process
process-management
ports
lsof
netstat
developer-tools
devtools
dev-server
port
kill
cross-platform
nodejs
typescript
zero-dependencies
mcp
```

## Settings

- Website: leave empty until there is a docs page.
- Issues: on. Discussions: off for now.
- Wiki, Projects: off.
- Releases: tag `v0.1.0` when publishing to npm.
- Social preview: `assets/hero.svg` rasterised to PNG at 1280x640.

## Publishing checklist

1. `npm run typecheck && npm test && npm run build`
2. `npm pack --dry-run` should ship `dist/`, `README.md`, `LICENSE` and nothing else.
3. Smoke test the packed tarball on each OS: `npx ./proclens-0.1.0.tgz --explain`.
4. Tag and publish.

## Things left undone

- No CI workflow committed here yet. Add one before the first external contribution, running typecheck, tests and build on Linux, macOS and Windows, since the collectors differ per platform and only fixtures are exercised off-platform.
- `main()` in `cli.ts` calls `inspect()` with the live collector and is not covered end to end. The pieces it composes (parse, buildSnapshot, filter, render, kill) are each tested against fixtures; a full `main()` test would need a collector seam threaded through.
- Linux start times assume USER_HZ is 100. True on mainstream kernels, stated in the platform notes, not read from `sysconf`.
- The role rules are a heuristic, not a registry. New tools need a token added to `classify.ts`.
