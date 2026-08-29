<#
  zmrng Windows setup wizard.

  Walks a fresh Windows machine through everything needed to run the zmrng dev
  server: checks prerequisites, installs npm dependencies, writes local config,
  confirms Claude Code + GitHub CLI auth, then launches the server and web dev
  servers in two windows and opens the app in your browser.

  Safe to re-run. Never uses admin rights, never touches anything outside this
  repo (except `npm install` and opening download pages / login flows you drive).

  Run it by double-clicking `setup.cmd`, or directly:
    powershell -ExecutionPolicy Bypass -File setup.ps1
#>

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# ---------------------------------------------------------------------------
# Presentation helpers
# ---------------------------------------------------------------------------
$script:Step = 0
$script:TotalSteps = 7

function Write-Head($text) {
  Write-Host ''
  Write-Host ("=" * 68) -ForegroundColor DarkCyan
  Write-Host "  $text" -ForegroundColor Cyan
  Write-Host ("=" * 68) -ForegroundColor DarkCyan
}

function Write-Stage($text) {
  $script:Step++
  Write-Host ''
  Write-Host ("[{0}/{1}] {2}" -f $script:Step, $script:TotalSteps, $text) -ForegroundColor White
}

function Write-Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [WARN] $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "  [X]    $text" -ForegroundColor Red }
function Write-Info($text) { Write-Host "         $text" -ForegroundColor Gray }

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Pause-Continue($text) {
  Write-Host ''
  Write-Host "  $text" -ForegroundColor Yellow
  Read-Host "  Press Enter when ready to continue" | Out-Null
}

function Open-Url($url) {
  try { Start-Process $url | Out-Null } catch { Write-Info "Open this URL manually: $url" }
}

# ---------------------------------------------------------------------------
Write-Head "zmrng setup wizard (Windows)"
Write-Info "This gets the dev server running. Follow the prompts; re-run any time."
Write-Info ""
Write-Info "First time? Two things to expect:"
Write-Info "  - You must have EXTRACTED the zip to a real folder (not run it from"
Write-Info "    inside the zip preview). If you double-clicked from inside the zip,"
Write-Info "    close this, Extract All to e.g. C:\Projects\zmrng, and run it there."
Write-Info "  - A blue 'Windows protected your PC' pop-up is normal (SmartScreen):"
Write-Info "    click 'More info' then 'Run anyway'."

# Guard: refuse to run from a zip-preview temp dir. When you double-click a file
# inside a zip in Explorer, it extracts to a read-only %TEMP%\Temp<N>_<name>.zip
# folder; npm install and config writes fail there in confusing ways. Detect that
# and stop with a clear instruction instead of failing three stages in.
$here = $PSScriptRoot
$tempRoot = [System.IO.Path]::GetTempPath()
if ($here.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or ($here -match '\.zip\\')) {
  Write-Host ''
  Write-Bad "You're running this from inside the zip (a temporary folder)."
  Write-Info "Windows extracted the zip read-only, so install/config will fail here."
  Write-Info "Fix: right-click the downloaded .zip -> Extract All -> choose a real"
  Write-Info "folder (e.g. C:\Projects\zmrng), then double-click setup.cmd in THAT folder."
  Write-Host ''
  Read-Host "  Press Enter to exit" | Out-Null
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Node.js 20.11 - 22.x
# ---------------------------------------------------------------------------
Write-Stage "Checking Node.js (need 20.11 - 22.x)"

$REQUIRED_MAJOR = 20
$REQUIRED_MINOR = 11
$MAX_MAJOR      = 23

$nodeOk = $false
if (Test-Command node) {
  $raw = (node --version) -replace '^v', ''
  $parts = $raw.Split('.')
  $maj = [int]$parts[0]
  $min = [int]$parts[1]
  if ($maj -lt $REQUIRED_MAJOR) { $nodeOk = $false }
  elseif ($maj -eq $REQUIRED_MAJOR -and $min -lt $REQUIRED_MINOR) { $nodeOk = $false }
  elseif ($maj -ge $MAX_MAJOR) { $nodeOk = $false }
  else { $nodeOk = $true }

  if ($nodeOk) {
    Write-Ok "Node $raw"
  } else {
    Write-Bad "Node $raw found, but zmrng needs 20.11 - 22.x."
  }
} else {
  Write-Bad "Node.js not found."
}

if (-not $nodeOk) {
  Write-Info "Install Node 22 with nvm-windows (recommended):"
  Write-Info "  1. Install nvm-windows: https://github.com/coreybutler/nvm-windows/releases"
  Write-Info "  2. Open a NEW terminal, then run:  nvm install 22  &&  nvm use 22"
  Write-Info "Or install Node 22 LTS directly from https://nodejs.org"
  Open-Url "https://github.com/coreybutler/nvm-windows/releases"
  Write-Host ''
  Write-Warn "Install Node, then re-run this wizard (double-click setup.cmd)."
  Read-Host "  Press Enter to exit" | Out-Null
  exit 1
}

# ---------------------------------------------------------------------------
# 2. Git
# ---------------------------------------------------------------------------
Write-Stage "Checking Git"
if (Test-Command git) {
  Write-Ok ((git --version) -replace 'git version ', 'git ')
} else {
  Write-Bad "Git not found."
  Write-Info "Install Git for Windows: https://git-scm.com/download/win"
  Open-Url "https://git-scm.com/download/win"
  Pause-Continue "Install Git, then press Enter (or re-run the wizard after)."
}

# ---------------------------------------------------------------------------
# 3. Native build toolchain (better-sqlite3 / node-pty)
# ---------------------------------------------------------------------------
Write-Stage "Checking native build toolchain (for better-sqlite3 / node-pty)"
$hasPython = (Test-Command python) -or (Test-Command python3)
$hasCl     = Test-Command cl        # MSVC compiler, present when C++ Build Tools installed

if ($hasPython) { Write-Ok "Python found" } else { Write-Warn "Python not found on PATH" }
if ($hasCl)     { Write-Ok "MSVC compiler (cl.exe) found" } else { Write-Warn "MSVC C++ compiler not detected" }

if (-not ($hasPython -and $hasCl)) {
  Write-Info "npm install compiles two native modules. Prebuilt binaries cover most"
  Write-Info "setups, so this MAY still work. If npm install fails on better-sqlite3"
  Write-Info "or node-pty, install these and re-run:"
  Write-Info "  - Python 3:  https://www.python.org/downloads/windows/"
  Write-Info "  - Visual Studio Build Tools -> 'Desktop development with C++':"
  Write-Info "    https://visualstudio.microsoft.com/visual-cpp-build-tools/"
} else {
  Write-Ok "Build toolchain looks ready"
}

# ---------------------------------------------------------------------------
# 4. Install dependencies
# ---------------------------------------------------------------------------
Write-Stage "Installing npm dependencies"
Write-Info "Running npm install (compiles native modules; this can take a few minutes)..."
try {
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install exited with code $LASTEXITCODE" }
  Write-Ok "Dependencies installed"
} catch {
  Write-Bad "npm install failed."
  Write-Info $_.Exception.Message
  Write-Info "Most common cause: missing Python / C++ Build Tools (see step 3 above)."
  Write-Info "Install those, then re-run this wizard."
  Read-Host "  Press Enter to exit" | Out-Null
  exit 1
}

# ---------------------------------------------------------------------------
# 5. Local configuration (.env + repo registry)
# ---------------------------------------------------------------------------
Write-Stage "Writing local configuration"

if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Ok ".env created from .env.example (defaults are sane)"
} else {
  Write-Ok ".env already present, left untouched"
}

# Warn if ANTHROPIC_API_KEY is set in this shell (zmrng strips it, but it signals confusion).
if ($env:ANTHROPIC_API_KEY) {
  Write-Warn "ANTHROPIC_API_KEY is set in your environment."
  Write-Info "zmrng strips it from workers on purpose so they use your Claude subscription."
  Write-Info "You can leave it set, but unsetting it avoids confusion."
}

$reposPath = Join-Path 'config' 'repos.json'
if (Test-Path $reposPath) {
  Write-Ok "config/repos.json already present, left untouched"
} else {
  Write-Info "Which git repos should zmrng be able to work on?"
  Write-Info "Enter the full path to each repo folder, one at a time."
  Write-Info "Example:  C:\Projects\my-app"
  Write-Info "Leave blank and press Enter when done (you can add more later in the app)."

  $repos = @()
  while ($true) {
    $p = Read-Host "  Repo path (blank to finish)"
    if ([string]::IsNullOrWhiteSpace($p)) { break }
    $p = $p.Trim().Trim('"')
    if (-not (Test-Path $p)) {
      Write-Warn "Path not found: $p  (skipped)"
      continue
    }
    if (-not (Test-Path (Join-Path $p '.git'))) {
      Write-Warn "Not a git repo (no .git folder): $p  (skipped)"
      continue
    }
    $name = Split-Path $p -Leaf
    $repos += [ordered]@{
      id            = $name
      label         = $name
      path          = ($p -replace '\\', '/')
      defaultBranch = 'main'
    }
    Write-Ok "Added '$name'"
  }

  if ($repos.Count -gt 0) {
    $json = ConvertTo-Json @($repos) -Depth 5
    # Write UTF-8 WITHOUT a BOM. Windows PowerShell 5.1's `Set-Content -Encoding
    # UTF8` prepends a BOM, which makes the server's JSON.parse throw (it reads
    # the file as utf8 and does not strip a BOM), silently dropping the registry.
    $abs = Join-Path $PSScriptRoot (Join-Path 'config' 'repos.json')
    [System.IO.File]::WriteAllText($abs, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "Wrote config/repos.json with $($repos.Count) repo(s)"
  } else {
    Write-Info "No repos entered. zmrng will auto-discover repos and add itself."
    Write-Info "You can add repos from the app's setup wizard after it launches."
  }
}

# ---------------------------------------------------------------------------
# 6. GitHub CLI auth
# ---------------------------------------------------------------------------
Write-Stage "Checking GitHub CLI (opens PRs)"
if (Test-Command gh) {
  $ghAuthed = $false
  try { gh auth status 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $ghAuthed = $true } } catch {}
  if ($ghAuthed) {
    Write-Ok "gh installed and authenticated"
  } else {
    Write-Warn "gh installed but not logged in."
    Write-Info "zmrng opens PRs via 'gh pr create'. Log in now so that works."
    $ans = Read-Host "  Run 'gh auth login' now? (Y/n)"
    if ($ans -notmatch '^[Nn]') { gh auth login }
  }
} else {
  Write-Warn "gh not found. zmrng opens PRs via 'gh pr create' - without it, PR creation fails."
  Write-Info "Install: https://cli.github.com  then run 'gh auth login'."
  Open-Url "https://cli.github.com"
  Write-Info "(The app still boots without gh; PR creation just won't work yet.)"
}

# ---------------------------------------------------------------------------
# 7. Claude Code auth
# ---------------------------------------------------------------------------
Write-Stage "Checking Claude Code CLI (does the actual work)"
if (Test-Command claude) {
  $credsPath = Join-Path $env:USERPROFILE '.claude\.credentials.json'
  if (Test-Path $credsPath) {
    Write-Ok "claude installed and logged in (credentials found)"
  } else {
    Write-Warn "claude installed but no login credentials found."
    Write-Info "Log in with your Claude subscription (Max recommended for real coding tasks)."
    Write-Info "Run 'claude' once in a terminal and complete the login flow, then re-run this wizard."
  }
} else {
  Write-Bad "claude not found. zmrng spawns it to do the actual work - required."
  Write-Info "Install per Anthropic's docs: https://docs.claude.com/en/docs/claude-code"
  Write-Info "Then run 'claude' once and log in with your Claude subscription."
  Write-Info "Do NOT set ANTHROPIC_API_KEY - zmrng uses your subscription login."
  Open-Url "https://docs.claude.com/en/docs/claude-code"
}

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
Write-Head "Setup complete - launching zmrng"
Write-Info "Starting the server (port 4500) and web (port 5174) in two windows."
Write-Info "Keep both windows open while you use zmrng. Close them to stop it."

$launch = Read-Host "  Launch zmrng now? (Y/n)"
if ($launch -match '^[Nn]') {
  Write-Host ''
  Write-Info "Skipped. To start later, run in two terminals:"
  Write-Info "  npm run dev:server"
  Write-Info "  npm run dev:web"
  Write-Info "Then open http://localhost:5174"
  Read-Host "  Press Enter to exit" | Out-Null
  exit 0
}

# Two separate windows so we don't depend on Git Bash for the combined `npm run dev`.
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'title zmrng server && npm run dev:server' -WorkingDirectory $PSScriptRoot
Start-Sleep -Seconds 2
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'title zmrng web && npm run dev:web' -WorkingDirectory $PSScriptRoot

Write-Info "Waiting for the web server to come up..."
Start-Sleep -Seconds 6
Open-Url "http://localhost:5174"

Write-Host ''
Write-Ok "zmrng is starting. Open http://localhost:5174 if the browser didn't."
Write-Info "First launch may show a setup panel in the app to finish adding repos."
Read-Host "  Press Enter to close this wizard (the two zmrng windows stay open)" | Out-Null
