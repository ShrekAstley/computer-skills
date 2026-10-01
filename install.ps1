<#
.SYNOPSIS
  Computer Skills installer for Windows (Claude Code, OpenCode, Cursor).

.EXAMPLE
  .\install.ps1                      # Claude Code via its plugin installer
  .\install.ps1 -Target cursor -Project
  .\install.ps1 -Target all
  .\install.ps1 -Uninstall -Target opencode

  # Remote:
  irm https://raw.githubusercontent.com/shrekastley/computer-skills/main/install.ps1 | iex
#>
[CmdletBinding()]
param(
  [ValidateSet('claude', 'opencode', 'cursor', 'all')] [string]$Target = 'claude',
  [switch]$Project,
  [switch]$Copy,
  [switch]$Uninstall,
  [string]$Repo = $(if ($env:COMPUTER_SKILLS_REPO) { $env:COMPUTER_SKILLS_REPO } else { 'shrekastley/computer-skills' }),
  [string]$Ref = $(if ($env:COMPUTER_SKILLS_REF) { $env:COMPUTER_SKILLS_REF } else { 'main' })
)
$ErrorActionPreference = 'Stop'
$Plugin = 'computer-skills'
$StateHome = if ($env:COMPUTER_SKILLS_HOME) { $env:COMPUTER_SKILLS_HOME } else { Join-Path $HOME '.computer-skills' }
$Runtime = Join-Path $StateHome 'runtime'
$Scope = if ($Project) { 'project' } else { 'user' }

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }

function Test-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw 'Node.js >= 18 is required (https://nodejs.org, or: winget install OpenJS.NodeJS.LTS).' }
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 18) { throw "Node.js >= 18 is required (found $(& node --version))." }
}

$script:Src = $null
function Get-Source {
  if ($script:Src) { return $script:Src }
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
  if ($here -and (Test-Path (Join-Path $here 'skills/computer-skills/SKILL.md'))) { $script:Src = $here; return $here }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("cs-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Say "Fetching $Repo@$Ref"
  if (Get-Command git -ErrorAction SilentlyContinue) {
    git clone -q --depth 1 --branch $Ref "https://github.com/$Repo.git" (Join-Path $tmp 'src')
    $script:Src = Join-Path $tmp 'src'
  } else {
    $zip = Join-Path $tmp 'src.zip'
    Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/$Ref.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $tmp
    $script:Src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
  }
  return $script:Src
}

function Install-Runtime {
  $src = Get-Source
  Say "Installing runtime into $Runtime"
  if (Test-Path $Runtime) { Remove-Item -Recurse -Force $Runtime }
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  foreach ($p in 'bin', 'src', 'examples', 'package.json') { Copy-Item -Recurse -Force (Join-Path $src $p) $Runtime }
}

function Register-Client($client) {
  & node (Join-Path $Runtime 'bin/computer-skills.js') install-config --target $client --scope $Scope --server-path (Join-Path $Runtime 'bin/computer-skills.js')
}

function Copy-Into($from, $to) {
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  Copy-Item -Recurse -Force (Join-Path $from '*') $to
  Write-Host "    + $to"
}

function Install-Claude {
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if ($claude -and -not $Copy) {
    $srcArg = $Repo
    if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '.claude-plugin'))) { $srcArg = $PSScriptRoot }
    Say "Installing with Claude Code's plugin installer (scope: $Scope)"
    try { & claude plugin marketplace add $srcArg } catch { Warn 'marketplace add reported an error (it may already exist); continuing' }
    & claude plugin install "$Plugin@$Plugin" --scope $Scope
    if ($LASTEXITCODE -ne 0) { throw "Plugin install failed. In Claude Code run: /plugin marketplace add $Repo  then  /plugin install $Plugin@$Plugin" }
    Say 'Done. Restart Claude Code; check /mcp and run /computer-skills:computer-doctor.'
  } else {
    if (-not $Copy) { Warn "'claude' CLI not found; registering the MCP server and copying the skill instead." }
    Install-Runtime
    $src = Get-Source
    $root = if ($Project) { Join-Path (Get-Location) '.claude' } else { Join-Path $HOME '.claude' }
    Copy-Into (Join-Path $src 'skills/computer-skills') (Join-Path $root 'skills/computer-skills')
    Copy-Into (Join-Path $src 'agents') (Join-Path $root 'agents')
    Copy-Into (Join-Path $src 'commands') (Join-Path $root 'commands')
    Register-Client 'claude'
    Say 'Done. Restart Claude Code.'
  }
}

function Install-OpenCode {
  Install-Runtime
  $src = Get-Source
  $root = if ($Project) { Join-Path (Get-Location) '.opencode' } else { Join-Path $HOME '.config/opencode' }
  Say "Installing for OpenCode into $root"
  Copy-Into (Join-Path $src 'skills/computer-skills') (Join-Path $root 'skills/computer-skills')
  Copy-Into (Join-Path $src 'adapters/opencode/agents') (Join-Path $root 'agents')
  Register-Client 'opencode'
  Say 'Done. Restart OpenCode.'
}

function Install-Cursor {
  Install-Runtime
  $src = Get-Source
  $root = if ($Project) { Join-Path (Get-Location) '.cursor' } else { Join-Path $HOME '.cursor' }
  Say "Installing for Cursor into $root"
  Copy-Into (Join-Path $src 'skills/computer-skills') (Join-Path $root 'skills/computer-skills')
  Copy-Into (Join-Path $src 'adapters/cursor/agents') (Join-Path $root 'agents')
  if ($Project) { Copy-Into (Join-Path $src 'adapters/cursor/rules') (Join-Path $root 'rules') }
  else { Warn 'Cursor rules are project-scoped; re-run with -Project inside a repo to add the rule.' }
  Register-Client 'cursor'
  Say 'Done. Restart Cursor and enable the computer-skills server under Settings -> MCP.'
}

function Uninstall-Target($t) {
  switch ($t) {
    'claude' {
      if (Get-Command claude -ErrorAction SilentlyContinue) {
        & claude plugin uninstall "$Plugin@$Plugin" --scope $Scope 2>$null
        & claude plugin marketplace remove $Plugin 2>$null
        & claude mcp remove computer-skills --scope user 2>$null
      }
      $root = if ($Project) { Join-Path (Get-Location) '.claude' } else { Join-Path $HOME '.claude' }
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $root 'skills/computer-skills'), (Join-Path $root 'agents/computer-operator.md'), (Join-Path $root 'agents/app-explorer.md'), (Join-Path $root 'commands/computer-doctor.md'), (Join-Path $root 'commands/computer-workflows.md'), (Join-Path $root 'commands/operate.md')
    }
    'opencode' {
      $root = if ($Project) { Join-Path (Get-Location) '.opencode' } else { Join-Path $HOME '.config/opencode' }
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $root 'skills/computer-skills'), (Join-Path $root 'agents/computer-operator.md'), (Join-Path $root 'agents/app-explorer.md')
      Warn 'Remove the "computer-skills" entry under "mcp" in opencode.json manually.'
    }
    'cursor' {
      $root = if ($Project) { Join-Path (Get-Location) '.cursor' } else { Join-Path $HOME '.cursor' }
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $root 'skills/computer-skills'), (Join-Path $root 'agents/computer-operator.md'), (Join-Path $root 'agents/app-explorer.md'), (Join-Path $root 'rules/computer-skills.mdc')
      Warn "Remove the computer-skills entry from $root\mcp.json manually."
    }
  }
}

$targets = if ($Target -eq 'all') { @('claude', 'opencode', 'cursor') } else { @($Target) }
if ($Uninstall) { foreach ($t in $targets) { Uninstall-Target $t }; Say 'Uninstalled.'; return }
Test-Node
foreach ($t in $targets) {
  switch ($t) { 'claude' { Install-Claude } 'opencode' { Install-OpenCode } 'cursor' { Install-Cursor } }
}
Say "Diagnostics: node `"$Runtime\bin\computer-skills.js`" doctor"
