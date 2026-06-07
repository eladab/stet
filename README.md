# stet

*stet* (proofreader's mark: "let it stand") — interactive git staging in the browser.
A single-file, zero-dependency local web app: review your working tree diff, stage/unstage/discard
files, hunks, or individual lines, write commits, and compare your branch against its base
(optionally including uncommitted work) — with word-level diff highlighting, expandable
context, fuzzy file filtering, and vim-style keybindings.

## Install

Requires Node.js ≥ 18 and git.

```sh
./install.sh            # builds dist/stet and copies it to ~/.local/bin/stet
```

## Update

```sh
stet --update           # git pull in your checkout, rebuild, reinstall
stet --version          # show the installed build (commit + date)
```

`--update` uses the source checkout the binary was built from (`git pull --ff-only`
+ `install.sh`), reinstalling over the running binary's location. If you've deleted
the checkout, clone it again and run `./install.sh`.

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

## Vim

```vim
" :Stet or <leader>s — open stet for the repo of the current file
function! s:Stet() abort
  let l:dir = empty(expand('%:p:h')) ? getcwd() : expand('%:p:h')
  if has('nvim')
    call jobstart(['stet', l:dir])
  elseif exists('*job_start')
    call job_start(['stet', l:dir])
  else
    silent execute '!stet ' . shellescape(l:dir)
    redraw!
  endif
endfunction
command! Stet call s:Stet()
nnoremap <silent> <leader>s :Stet<CR>

" Reload buffers when stet discards change files on disk
set autoread
augroup stet_checktime
  autocmd!
  autocmd FocusGained,BufEnter,CursorHold,CursorHoldI * silent! checktime
augroup END
```

## Security

Binds 127.0.0.1 only; every API call requires a per-instance random token; mutating
endpoints are POST with an origin check; git is always invoked via argument arrays
(no shell), and file paths are validated against traversal.

## Development

```sh
node src/server.mjs --fg    # run from source (UI served from src/ on disk)
node build.mjs              # emit dist/stet single-file executable
```
