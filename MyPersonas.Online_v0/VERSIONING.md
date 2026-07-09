# Versioning — MyPersonas repos

All MyPersonas repos (site, Personas app, extensions) version the same way:
**one canonical source tree per repo, releases as annotated git tags.**
Old versions are older tags — immutable, no parallel version folders.

## Version number scheme

`v<major>[.<roadmap>][<hotfix letter>]` — e.g. `v0`, `v0.5`, `v1`, `v1.5`, `v1.5b`

- **Major (`v0` → `v1`)** — a major milestone is reached.
- **Roadmap (`.x`, e.g. `v1` → `v1.5`)** — a roadmap item for the current
  major version is accomplished.
- **Hotfix letter (`v1.5` → `v1.5a` → `v1.5b`)** — a bug fix addressing an issue
  introduced by a recent change. Letters advance alphabetically.

## How to cut a release

```
git tag -a v1.5b -m "hotfix: <what it fixes>"
git push origin v1.5b
```

For repos with downloadable artifacts, create a GitHub Release from the tag and
attach the build output (e.g. `Concept-1.5b.zip` produced by `git archive`).

## Folder naming

The local working-copy folder carries the current **major line** only, e.g.
`MyPersonas.Online_v0`, `Concept_v0`, `Personas_v0`. The folder is renamed only on
a major version change. Point-releases and hotfixes never create new folders —
they are tags within the same tree.

## Discovery

Consumers (the site's extensions catalog, download pages) resolve versions from
GitHub Releases (or a generated `releases.json`) — never by scanning folders.
