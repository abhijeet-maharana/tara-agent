# Deploying with undo

`deploy/release/` deploys tara-agent and your projects' own services to the host, with automatic rollback.

```
<base>/releases/20261124-103122/   one folder per deploy (the newest 5 are kept)
<base>/releases/20261124-110405/
<base>/current -> releases/20261124-110405     what the systemd unit runs (WorkingDirectory)
<base>/releases.log                            every deploy and its result
```

## What a deploy does

1. **New release folder.** Dependencies are carried over from the live release as hard links, so nothing is downloaded unless the lockfile changed.
2. **Copy** the files listed in the repo's `.tara/deploy.json` from your machine straight into it (rsync). The host's own checkout of the repo is never used: other users (the run user) may be able to write it.
3. **Install, build, check.** `npm ci` only when the lockfile changed (otherwise the package's `prepare` script, as `npm ci` would). Then the `build` and `check` npm scripts. A failure stops here: nothing switched, the folder is deleted.
4. **Wait until it is safe to restart:** `waitFor` (e.g. no job of the project running) and, for tara-agent, a drain (no new runs start; wait until nothing runs).
5. **Switch** `current` to the new folder (one rename) and restart the unit.
6. **Health check.** When the health URL doesn't answer OK in time, `current` goes back to the release before, the unit restarts, and the deploy reports the rollback.

The release folders are read-only for everyone but the deploying user, so a service's own user and the Claude run user can read the code but never change what runs next.

## Commands

On your machine, in the project repo:

```sh
tara-deploy <service>                       # link deploy/release/tara-deploy.mjs into your PATH as tara-deploy
tara-deploy <service> --no-activate         # copy only
node deploy/release/tara-deploy.mjs tara-agent --config deploy/release/tara-agent.json --host <host>   # tara-agent itself
```

On the host:

```sh
tara-release list                  # releases per service, * = live
tara-release rollback <service>    # back to the last healthy release before the live one
```

## Set up

On the host:

```sh
sudo install -o root -g root -m 755 deploy/release/tara-release.mjs /usr/local/bin/tara-release
sudo cp examples/services.json /etc/tara-agent/services.json     # then edit
```

Then point each unit's `WorkingDirectory` at `<base>/current/...` and deploy once. `seedFrom` lets the first release reuse the dependencies of an older single copy.

In each project repo, `.tara/deploy.json`:

```json
{
  "host": "myhost",
  "services": {
    "shop-api": {
      "copy": [{ "from": "api/", "to": "shop/api/", "exclude": ["node_modules", ".env*"] }],
      "install": ["shop/api"],
      "build": ["build"],
      "check": ["typecheck"],
      "unitFile": "shop/api/shop-api.service"
    }
  }
}
```

`install` and `unitFile` are paths inside the release; `build` and `check` are npm script names. Nothing else from the repo is run.

## Database changes

A rollback switches the code back, not the data. When a release migrates a database and is then rolled back, the older code may refuse the newer schema (tara-agent says so at start). Restore the copy taken before the deploy ([backups.md](backups.md)) or deploy a fix forward.
