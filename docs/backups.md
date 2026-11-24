# Backups

tara-agent has two layers of backup.

| Layer | What | Where | Set up with |
|---|---|---|---|
| **Daily copy** | The state database only, checked with `quick_check` | Same machine (`backup.dir`) | Built in, always on |
| **Off-site backup** | Any SQLite databases, files and folders on the host, checked, encrypted, uploaded | An S3-compatible store (R2, S3, B2) | `deploy/backup/tara-backup.mjs` + a timer |

The daily copy protects against a bad migration or a damaged database. The off-site backup protects against losing the machine.

## Off-site backup

Each night `tara-backup run`:

1. **Copies each database** with `VACUUM INTO` from a read-only connection. The copy is consistent, includes the WAL, and is taken while the owner keeps writing. Each copy gets `integrity_check` and row counts per table.
2. **Packs each file or folder** into its own tar.gz, with its own excludes (e.g. browser caches).
3. **Encrypts everything with [age](https://age-encryption.org)** to your public key. The private key is never on the host, so a stolen disk or a leaked bucket can't open the backups.
4. **Uploads** with the AWS CLI and checks the upload (size and sha256). Old copies are pruned, always keeping the newest few.
5. **Writes a status file** (no secrets). With `backup.offsite.statusFile` set in the host config, the Health page shows **Off-site backup** and **Restore test** checks.

A failing item doesn't stop the others: the run uploads what it has and shows red. Large databases that change slowly can go in weekly (`"every": "week"`).

## Restore test

A backup counts once it has been restored. `deploy/backup/restore-test.sh <ssh host>` runs on a machine that holds the private key:

1. asks the host for a one-hour download link to the newest good archive
2. downloads it, checks its sha256, decrypts and unpacks it
3. checks every database (`integrity_check`, row counts) and file against the archive's manifest
4. reports the result back to the host, where the Health page shows it

Run it monthly (`deploy/backup/restore-test.plist` for launchd on a Mac). The Health check turns amber after `restoreTestDays` (35) without a passed test.

## Set up

On a machine that will hold the key (not the host):

```sh
age-keygen -o ~/.config/tara-backup/age-key.txt     # prints the public key (age1…)
```

**Keep a second copy of the key file somewhere else** (a password manager). Without it the backups can't be opened.

On the host:

```sh
sudo apt install age            # plus the AWS CLI, Node 22.13+
sudo install -o root -g root -m 755 deploy/backup/tara-backup.mjs /usr/local/sbin/tara-backup
sudo install -m 600 /dev/null /etc/tara-agent/backup.env   # AWS_ACCESS_KEY_ID=… / AWS_SECRET_ACCESS_KEY=…
sudo cp examples/backup.json /etc/tara-agent/backup.json   # then edit: recipients, remote, items
sudo cp deploy/systemd/tara-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tara-backup.timer
sudo systemctl start tara-backup && sudo tara-backup status
```

Install the root-owned copy and run that, never the checkout's file: other users (the run user) may be able to write the checkout.

Then add to the host config:

```yaml
backup:
  offsite:
    statusFile: /var/lib/tara-backup/status.json
```

## Restore for real

```sh
age -d -i age-key.txt <host>-<time>.tar.gz.age | tar -xzf - -C restore/
node deploy/backup/tara-backup.mjs verify restore/      # check before you use it
```

Databases are in `restore/sqlite/<name>`, ready to copy into place with the owning service stopped. Files are in `restore/files/<name>.tar.gz`, stored with their full path: `tar -xzf … -C /` puts them back where they were.
