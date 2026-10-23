# kita-version-check

DSH version and update check in the left sidebar: a global panel entry that
compares the RUNNING deployment's version against the npm registry dist-tags,
opening a version page with a manual refresh.

The entry is a `sidebar.panellist` icon next to Plugins / Schedules and the page
is the `main` panel registered under the same id. Why not the sidebar foot: that
slot is a 256px `flex-wrap: nowrap` row, and the restart entry claims its full
width, so a second full-width action there pushes the restart button out of the
column. A global panel icon is the additive seat the sidebar reserves for exactly
this kind of page.

Two halves, one store:

| Half | Responsibility |
|---|---|
| host (`lib/index.js`) | resolves the running version from the process itself, queries and caches the registry, serves `/kita-version-check/{state,refresh}` |
| client (`lib/client.js`) | `sidebar.panellist` icon entry + the `main` version page (same id), rendered from the host snapshot |

## Why the version comes from the process

A version string in configuration goes stale the moment the deployment is
switched, and a stale answer is worse than no answer: it would report another
environment's release. The host half therefore walks, most trustworthy first:

1. `config.dshPackageJson` when it is set explicitly;
2. `process.argv[1]` upwards (`<env>/node_modules/@deepseek-ai/dsh/lib/bin.js`);
3. `<envs>\<active-env.txt env>>/env/node_modules/@deepseek-ai/dsh/package.json`;
4. the profile / home `node_modules` copies;
5. `createRequire(import.meta.url).resolve`.

Every candidate must parse as JSON and carry `name === config.packageName`, so
an unrelated `package.json` on the walk cannot be mistaken for the runtime. The
deployment name shown next to the version ("alpha-022") is read from
`active-env.txt`; an unresolved deployment reports `resolved: false` rather than
guessing.

## Routes

| Route | Method | Answer |
|---|---|---|
| `/kita-version-check/state` | GET | cached snapshot; loads once when empty |
| `/kita-version-check/refresh` | POST | forces a registry query, then the same snapshot |

Both refuse cross-site callers (mismatched `Origin` or
`Sec-Fetch-Site: cross-site`) with 403. The cache lives in memory and is
mirrored to `<home>/storages/kita-version-check.json`, so a restart does not
re-query and a page load never waits on the network twice.

## Update verdict

`dist-tags` are compared with SemVer 2.0.0 precedence implemented locally
(a release outranks its prereleases, numeric prerelease identifiers compare
numerically, build metadata is ignored), so no dependency is added for it. Each
channel reports `relation`: `newer` / `equal` / `older` / `unknown`. The panel
lists every channel, the five most recent releases, and one verdict line.

The plugin deliberately offers no "upgrade" button: upgrading means a rehearsal
environment plus the replayed patch chain, never an in-place install against a
running dsh web.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `registry` | `https://registry.npmjs.org` | registry base URL (an intranet mirror is a deployment value) |
| `packageName` | `@deepseek-ai/dsh` | package whose dist-tags answer "what is upstream" |
| `channels` | `[latest, next, alpha]` | dist-tags compared against the running version |
| `refreshIntervalMinutes` | `60` | how long a registry answer stays fresh |
| `requestTimeoutMs` | `20000` | per-request network budget |
| `proxyUrl` | `''` | explicit `http://host:port` proxy |
| `useEnvironmentProxy` | `true` | try `HTTPS_PROXY` / `HTTP_PROXY` after a direct attempt fails |
| `dshHome` | `''` | absolute dsh home (default `$DSH_HOME`) |
| `envsDir` | `''` | directory holding `active-env.txt` (default two levels above the home) |
| `dshPackageJson` | `''` | explicit running-DSH `package.json` |
| `versionListLimit` | `8` | how many recent releases to return |

Node's `fetch` does not honour `*_PROXY`, so the proxy path is a real HTTP
`CONNECT` tunnel; the direct request is tried first and every attempt's failure
is reported in one error line.

## Assembly (four places, plus one link)

```
plugins-src/kita-version-check/           <- this package (production source)
profiles/web/pnpm-workspace.yaml          <- "  - plugins-src/kita-version-check"
profiles/web/package.json                 <- "kita-version-check": "workspace:*"
profiles/web/cordis.patch.yml             <- insert: [{ id, name: kita-version-check }]
profiles/web/node_modules/kita-version-check -> junction to the source directory
```

**A new client entry changes the boot graph, so dsh web must be restarted**; a
hard refresh alone will not surface the sidebar entry. Editing the bundle while
the entry set is unchanged only needs a hard refresh.

## Verification

Both scripts run offline and do not touch dsh:

```
node scripts/verify-host.mjs    # 47 checks: SemVer matrix, version resolution,
                                # cache + disk mirror, 403 fence, CONNECT proxy
node scripts/smoke-client.cjs   # 51 checks: bundle registration, the two seats,
                                # store prime/open/refresh, both renders
```

`verify-host.mjs` runs the real plugin against a local fake registry and a local
CONNECT proxy, so it exercises the same code path the deployment uses. It needs
`@deepseek-ai/schemastery` resolvable from this package (link it into
`node_modules/` once when running from the monorepo).
