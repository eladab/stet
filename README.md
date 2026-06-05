# stet

*stet* (proofreader's mark: "let it stand") — interactive git staging in the browser.
A single-file, zero-dependency local web app: review your working tree diff, stage/unstage/discard
files or hunks, write commits, and compare your branch against its base — with vim-style keybindings.

## Install

Requires Node.js ≥ 18 and git.

```sh
./install.sh            # builds dist/stet and copies it to ~/.local/bin/stet
```

## Use

```sh
stet                    # open UI for the repo containing the cwd (detached)
stet ~/code/myrepo      # any path inside a repo works
stet --fg               # foreground: prints STET_URL=..., Ctrl+C stops
stet --no-open          # don't auto-open the browser
stet --port 7777        # fixed port (default: ephemeral)
stet --idle 600         # shut down after 10 min without browser contact (default 120s, 0 = never)
```

The UI heartbeats the server every 2s; closing the tab (or the whole browser)
stops the heartbeat and the server exits on its own after `--idle` seconds.

Press `?` in the UI for keyboard shortcuts. Quit with the ⏻ button or `q`.

## Security

Binds 127.0.0.1 only; every API call requires a per-instance random token; mutating
endpoints are POST with an origin check; git is always invoked via argument arrays
(no shell), and file paths are validated against traversal.

## Development

```sh
node src/server.mjs --fg    # run from source (UI served from src/ on disk)
node build.mjs              # emit dist/stet single-file executable
```
