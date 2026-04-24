# Oyster workspace

This is your Oyster workspace. You're looking at it in Finder / Explorer; when Oyster is running you see the same content rendered as a surface at **http://localhost:4444**.

Your files live under `spaces/`, organised by space. Read, edit, or back them up any time — they're plain files.

---

## Layout

| Folder | What's in it |
|---|---|
| `spaces/` | Your work, one folder per space (e.g. `spaces/home/`, `spaces/tokinvest/`) |
| `apps/` | Installed apps — the builtins that ship with Oyster + anything you install |
| `db/` | Oyster's registry and memory databases. Don't edit by hand |
| `backups/` | Automatic snapshots |
| `.opencode/`, `opencode.json` | AI engine config |

---

## Common paths

- A tokinvest invoice → `spaces/tokinvest/invoices/<name>.md`
- A note in home → `spaces/home/<name>.md`
- An AI-generated app → `spaces/<space>/<app>/`
- The registry DB → `db/oyster.db`

---

## Shortcut commands (in Oyster's chat bar)

| Command | What it does |
|---|---|
| `#<space>` | Switch to a space (e.g. `#tokinvest`) |
| `/s <space>` | Same as above |
| `/new <label>` | Create a new space |
| `/help` | List available commands |

Or just ask your AI: *"switch to tokinvest"*, *"show me the wordle app"*, *"set up Oyster for me"*.

---

## Moving things

Use Oyster (the agent or the UI) for moves and renames — the database stays in sync with the filesystem. Finder-only moves aren't reconciled yet.

---

## Learn more

- Open Oyster and look for the **"Where are my files?"** tile for live paths tailored to your install.
- Source & issues: [github.com/mattslight/oyster](https://github.com/mattslight/oyster)
