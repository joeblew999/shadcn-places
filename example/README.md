# example

A bare consumer project whose only job is to prove the registry item installs and
compiles — the way a stranger's project would, not the way this repository does.

```bash
cd example
bun install
bun run install-picker   # shadcn add, from the deployed registry URL
bun run check            # tsc against a consumer's own components and @/ alias
```

`src/components/` is gitignored: it is written by `shadcn add` and it is the thing
under test. Committing it would test a file we wrote rather than a file the
installer produced.

## Why this exists

`shadcn add` silently wrote four dependencies and skipped the component itself
for a day. It exited zero and printed a success. The demo worked, the API worked,
and the repository's checks verified a file path that existed *here* rather than
the item served over the wire.

The lesson generalised: a registry item is the one artefact never compiled by the
project that publishes it, so the only honest test is to install it somewhere else.
