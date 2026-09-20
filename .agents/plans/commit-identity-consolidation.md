# Commit-identity consolidation plan

**Goal:** rewrite the zmrng commit history so authorship reads as one clean
identity (`zmchrist <TiosVida@pm.me>`), so a recruiter browsing the repo sees
your name on every commit and GitHub links them to your contribution graph.

**Why:** 53 of 188 commits are authored as the literal git default
`Your Name <your.email@example.com>`, plus an alias split (`TioVida` vs
`TiosVida`) and two foreign identities. None of the `Your Name` commits link to
your GitHub profile or graph.

> ⚠️ **This rewrites history.** Every commit SHA after the first rewritten
> commit changes. It is safe here because zmrng is solo and you control the only
> clone + remote — but it is irreversible once you force-push and GC. Do the
> backup step. Get Q1/Q2 answered before running.

## Identity inventory (from `git log`)

| Commits | Author | Action |
|--------:|--------|--------|
| 130 | `zmchrist <TiosVida@pm.me>` | keep (canonical) |
| 53 | `Your Name <your.email@example.com>` | → canonical |
| 3 | `Zebucity <charles@coviin.com>` | **Q1** — decide |
| 2 | `Pheme-Bot <Pheme-Bot@users.noreply.github.com>` | **Q2** — decide |
| 1 | `zmchrist <TioVida@pm.me>` | → canonical (alias normalize) |

## Decisions (locked)
- **Q1 — Zebucity / charles@coviin.com** (#123, #116, #117): **real other
  person. LEAVE UNTOUCHED** — rewriting would misattribute their work.
- **Q2 — Pheme-Bot** (coding-gate adoption, PR template): **your automation
  bleed → fold into you.**

The committed `.mailmap.consolidate` encodes this: rewrite `Your Name` +
Pheme-Bot into canonical, normalize the `TioVida` alias, Zebucity untouched.
Expected post-rewrite identity count: **186 you + 3 Zebucity** (dry-run verified).

## Procedure

### 0. Preconditions
```bash
# HEAD should match origin/main (push or stash anything in flight first).
git status
# Install the tool (not currently present).
brew install git-filter-repo
```

### 1. Backup (non-negotiable)
```bash
cd ~/Developer/Projects
git clone --mirror https://github.com/zmchrist/zmrng.git zmrng-backup.git
# Also keep the local working copy untouched until the rewrite is verified.
```

### 2. Dry-run the identity map on a throwaway clone
```bash
git clone ~/Developer/Projects/zmrng /tmp/zmrng-rewrite
cd /tmp/zmrng-rewrite
cp ~/Developer/Projects/zmrng/.mailmap.consolidate /tmp/mailmap
git filter-repo --mailmap /tmp/mailmap
git log --format='%an <%ae>' | sort | uniq -c | sort -rn   # verify: one identity
```

### 3. Apply to the real repo
```bash
cd ~/Developer/Projects/zmrng
git filter-repo --mailmap .mailmap.consolidate
# filter-repo removes 'origin' by design; re-add it:
git remote add origin https://github.com/zmchrist/zmrng.git
```

### 4. Verify
```bash
git log --format='%an <%ae>' | sort | uniq -c | sort -rn   # expect 1 (or 1+2+3 if Q1/Q2 left out)
npm ci && npm run typecheck && npm run lint && npm test && npm run build
```

### 5. Force-push (after backup + verify)
```bash
git push --force-with-lease --all origin
git push --force-with-lease --tags origin
```

### 6. Cleanup
```bash
rm .mailmap.consolidate          # not needed in the public tree
# delete the backup mirror only after the remote is confirmed good
```

## Rollback
If anything looks wrong before step 5, discard `/tmp/zmrng-rewrite` and the real
repo is untouched. After step 5, restore from `zmrng-backup.git`:
```bash
cd ~/Developer/Projects/zmrng-backup.git
git push --force --mirror https://github.com/zmchrist/zmrng.git
```

## Notes
- The 130 "committer = GitHub" rows are normal PR-merge commits; filter-repo
  rewrites the *author* (what the graph keys on), which is correct.
- `--mailmap` only touches identities; it does not alter commit messages, so the
  Claude co-author trailers remain. Stripping those is a separate `--message-callback`
  pass if you decide to (tracked separately — not in this plan).
