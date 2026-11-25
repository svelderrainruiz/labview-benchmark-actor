#Requires -Version 5.1
<#
.SYNOPSIS
  Reviewer-workstation provisioner for labview-benchmark-actor (#108).

.DESCRIPTION
  Uses the labview-benchmark-actor golden box `actor/win11-labview2026` (Windows 11 + LabVIEW 2026 +
  VS Code + Node + git + LabVIEW fixtures). It adds ONLY the labview-benchmark-actor bits:
    1. the extension .vsix, from the gated `ext-v*` GitHub Release;
    2. the `lbabus` CLI (self-contained win-x64) from the pinned svelderrainruiz/lbabus Release (SHA-256 checked);
    3. a scratch workspace so the reviewer can immediately run Write/Show/Check.
  Idempotent-ish and safe to re-run. WIN validates this on real Windows (WinRM).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Step([string]$m) { Write-Host "[reviewer] $m" }

$repo      = $env:REVIEWER_REPO
$extTag    = $env:REVIEWER_EXT_TAG
$lbabusTag = $env:REVIEWER_LBABUS_TAG
Step "repo=$repo ext-tag=$extTag lbabus-tag=$lbabusTag"

# 0) Prereqs. The VirtualBox golden box (actor/win11-labview2026) ships VS Code + gh, but the VMware
#    cleanroom box (vihs/labview-cleanroom) and BYO reviewer boxes may ship NEITHER the tools NOR winget
#    (confirmed live: the cleanroom box has no `code` and no App Installer/winget). So self-install with a
#    winget-free direct download from the official vendor URLs, falling back to winget only if present.
function Refresh-MachinePath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
function Install-VSCodeDirect {
  $exe = Join-Path $env:TEMP 'vscode-system-setup.exe'
  Step "Downloading VS Code system installer (update.code.visualstudio.com)"
  Invoke-WebRequest -Uri 'https://update.code.visualstudio.com/latest/win32-x64/stable' -OutFile $exe -UseBasicParsing
  Step "Installing VS Code silently"
  $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/NORESTART','/MERGETASKS=!runcode,addtopath' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "VS Code installer exited $($p.ExitCode)." }
}
function Install-GhDirect {
  Step "Resolving latest GitHub CLI Windows msi"
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/cli/cli/releases/latest' -Headers @{ 'User-Agent' = 'lba-reviewer' }
  $asset = $rel.assets | Where-Object { $_.name -like '*windows_amd64.msi' } | Select-Object -First 1
  if (-not $asset) { throw "No windows_amd64.msi asset in the cli/cli latest release." }
  $msi = Join-Path $env:TEMP $asset.name
  Step "Downloading $($asset.name)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msi -UseBasicParsing
  Step "Installing GitHub CLI silently"
  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i',"`"$msi`"",'/quiet','/norestart' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "gh msi exited $($p.ExitCode)." }
}
function Install-NodeDirect {
  Step "Resolving latest Node.js LTS x64 msi (nodejs.org)"
  $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -Headers @{ 'User-Agent' = 'lba-reviewer' }
  $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
  if (-not $lts) { throw "No Node.js LTS release found in the dist index." }
  $ver = $lts.version
  $msi = Join-Path $env:TEMP "node-$ver-x64.msi"
  Step "Downloading Node.js $ver x64 msi"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/node-$ver-x64.msi" -OutFile $msi -UseBasicParsing
  Step "Installing Node.js silently"
  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i',"`"$msi`"",'/quiet','/norestart' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Node.js msi exited $($p.ExitCode)." }
}
function Install-GitDirect {
  Step "Resolving latest Git for Windows 64-bit installer"
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'lba-reviewer' }
  $asset = $rel.assets | Where-Object { $_.name -like 'Git-*-64-bit.exe' } | Select-Object -First 1
  if (-not $asset) { throw "No 64-bit Git for Windows installer in the latest release." }
  $exe = Join-Path $env:TEMP $asset.name
  Step "Downloading $($asset.name)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing
  Step "Installing Git for Windows silently"
  $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-','/SUPPRESSMSGBOXES','/MERGETASKS=!runcode' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Git for Windows installer exited $($p.ExitCode)." }
}
function Ensure-Tool([string]$Command, [string]$WingetId, [string]$Label, [scriptblock]$DirectInstall) {
  if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
  # winget is BEST-EFFORT: an imaged/golden Windows can have winget present but its sources broken
  # (0x8a15000f "Data required by the source is missing"). Try it, but ALWAYS fall back to the winget-free
  # direct download when the tool is still not on PATH -- never fail the reviewer just because winget's sources are.
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Step "Installing $Label via winget ($WingetId)"
    try {
      winget install --id $WingetId --exact --source winget --accept-package-agreements --accept-source-agreements --silent
    } catch {
      Step "winget install of $Label errored ($($_.Exception.Message)); will fall back to direct download"
    }
    Refresh-MachinePath
  }
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    Step "$Label not on PATH (winget absent or its sources failed); installing via direct download"
    & $DirectInstall
    Refresh-MachinePath
  }
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Label install did not put '$Command' on PATH. Inspect the install output and re-run."
  }
}
Ensure-Tool 'code' 'Microsoft.VisualStudioCode' 'VS Code'    { Install-VSCodeDirect }
Ensure-Tool 'gh'   'GitHub.cli'                 'GitHub CLI' { Install-GhDirect }
# node + git are prerequisites of the verify-before-install step (Assert-ReleaseProvenance runs the Node
# transparency-log verifier over a checkout of this repo). The VirtualBox golden box ships them, but the
# VMware cleanroom box (vihs/labview-cleanroom) and BYO boxes may ship NEITHER -- self-install them the same
# winget-free way. Additive + idempotent: Ensure-Tool no-ops when the command is already on PATH.
Ensure-Tool 'node' 'OpenJS.NodeJS.LTS'          'Node.js'    { Install-NodeDirect }
Ensure-Tool 'git'  'Git.Git'                    'Git'        { Install-GitDirect }
Step "VS Code: $((code --version)[0]); gh: $((gh --version)[0]); node: $(node --version); git: $((git --version))"

# Authenticate gh non-interactively. The labview-benchmark-actor repo is INTERNAL (private): the gated
# ext-v* Releases are NOT world-readable, so a headless guest cannot use gh unauthenticated
# (`gh api`/`gh release download` abort with "run gh auth login"). The token is handed off as a FILE (the
# Vagrant file provisioner does NOT echo contents; passing it via the shell provisioner `env:` would leak
# it -- Vagrant echoes the full env-prefixed command when a step fails). Read the file, delete it
# immediately (keep the token only in this process env), then expose it as GH_TOKEN; env vars remain a
# fallback. Fail fast with guidance when no token is available; no credentials are persisted to guest disk.
$tokenFile = 'C:\Windows\Temp\lba-gh-token'
$reviewerToken = $null
if (Test-Path $tokenFile) {
  $reviewerToken = (Get-Content -Raw $tokenFile -ErrorAction SilentlyContinue)
  if ($reviewerToken) { $reviewerToken = $reviewerToken.Trim() }
  Remove-Item $tokenFile -Force -ErrorAction SilentlyContinue
}
if (-not $reviewerToken) { $reviewerToken = $env:REVIEWER_GH_TOKEN }
if (-not $reviewerToken) { $reviewerToken = $env:GH_TOKEN }
if (-not $reviewerToken) {
  throw "No GitHub token in the guest. $repo is INTERNAL, so its gated ext-v* Releases need auth. On the HOST, write a token to reviewer-workstation/.gh-token before provisioning (e.g. Set-Content reviewer-workstation/.gh-token (gh auth token)) then re-run: VAGRANT_CWD=reviewer-workstation vagrant provision. The token needs contents:read on $repo (SSO-authorized for SSO orgs)."
}
$env:GH_TOKEN = $reviewerToken
Step "GitHub token present; gh authenticates non-interactively for the private-release downloads."

# Resolve the newest tag with a given prefix, or honor an explicit tag.
function Resolve-Tag([string]$prefix, [string]$tag) {
  if ($tag -and $tag -ne 'latest') { return $tag }
  # Filter release tags in PowerShell -- NOT gh's inline --jq: its nested quotes get mangled through the
  # WinRM `powershell -OutputFormat Text -file` bridge, so jq would see startswith(ext-v) unquoted and abort
  # with "function not defined: v/0". ConvertFrom-Json + Where-Object is quote-safe and equivalent.
  $releases = gh api "repos/$repo/releases?per_page=100" | ConvertFrom-Json
  $match = $releases | Where-Object { $_.tag_name -like "$prefix*" } | Select-Object -First 1
  if (-not $match) { throw "No ${prefix}* release found in $repo (has the gated $prefix release been cut yet?)." }
  return $match.tag_name
}

# Install the extension into the INTERACTIVE console user's VS Code profile -- NOT the WinRM 'vagrant'
# profile provisioning runs as -- or the human reviewer never sees it (#121). Extensions are per-user; the
# profile FOLDER can differ from the username (e.g. user 'vitech' -> 'C:\Users\VI-Tech'), so resolve the
# real profile path from the user's SID via Win32_UserProfile. Falls back to the provisioning profile only
# when no one is logged on at the console.
function Install-ExtensionForInteractiveUser([string]$VsixPath) {
  $extDirArgs = @()
  $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
  if ($consoleUser) {
    try {
      $sid = (New-Object System.Security.Principal.NTAccount($consoleUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
      $profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath
      if ($profilePath) {
        $extDir = Join-Path $profilePath '.vscode\extensions'
        New-Item -ItemType Directory -Force -Path $extDir | Out-Null
        $extDirArgs = @('--extensions-dir', $extDir)
        Step "target profile: $consoleUser -> $extDir"
      }
    } catch {
      Step "WARN could not resolve console-user profile ($consoleUser): $($_.Exception.Message)"
    }
  } else {
    Step 'WARN no interactive console user detected; installing into the provisioning profile.'
  }
  code --install-extension $VsixPath @extDirArgs --force
}

# Verify-before-install (ADR-0022 / LBA-REQ-031, closing the reviewer-workstation clause of LBA-REQ-025): the
# release corroboration provenance MUST verify before the .vsix is installed. Download the release's provenance
# bundle and run the dependency-free Node verifier (experiments/acg-transparency/verify-release-inclusion.mjs),
# which admits install only when >= quorumMin witnesses each have an enrolled-witness-signed attestation that is
# INCLUDED in the Ed25519-signed Merkle transparency log. A non-zero exit BLOCKS the install (fail-closed). Set
# REVIEWER_ALLOW_UNATTESTED=1 ONLY to provision from a pre-provenance release.
function Assert-ReleaseProvenance([string]$ExtTag, [string]$WorkDir) {
  gh release download $ExtTag --repo $repo --pattern '*.provenance.json' --dir $WorkDir --clobber 2>$null
  $prov = Get-ChildItem $WorkDir -Filter '*.provenance.json' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $prov) {
    if ($env:REVIEWER_ALLOW_UNATTESTED -eq '1') {
      Step "WARN: release $ExtTag carries no *.provenance.json and REVIEWER_ALLOW_UNATTESTED=1 -> installing UNATTESTED."
      return
    }
    throw "verify-before-install BLOCKED: release $ExtTag carries no *.provenance.json corroboration bundle. Cut the release with an attached provenance bundle, or set REVIEWER_ALLOW_UNATTESTED=1 to override (NOT recommended)."
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "verify-before-install BLOCKED: 'node' is not on PATH; the reviewer box needs Node to verify the corroboration provenance."
  }
  $srcDir = $env:REVIEWER_REPO_DIR
  if (-not $srcDir) { $srcDir = Join-Path $env:TEMP 'lba-actor-src' }
  if (Test-Path (Join-Path $srcDir '.git')) {
    Step "Updating verifier source at $srcDir"
    git -C $srcDir fetch --depth 1 origin | Out-Null
    git -C $srcDir reset --hard origin/HEAD | Out-Null
  } else {
    Step "Cloning verifier source ($repo) to $srcDir"
    gh repo clone $repo $srcDir -- --depth 1
  }
  $verifier = Join-Path $srcDir 'experiments\acg-transparency\verify-release-inclusion.mjs'
  if (-not (Test-Path $verifier)) { throw "verify-before-install BLOCKED: verifier not found at $verifier." }
  Step "Running verify-before-install over $($prov.Name)"
  & node $verifier --provenance $prov.FullName
  if ($LASTEXITCODE -ne 0) { throw "verify-before-install BLOCKED: the corroboration provenance for $ExtTag did not verify (exit $LASTEXITCODE). The .vsix will NOT be installed." }
  Step "verify-before-install: provenance verified; proceeding to install."
}

# cosign KEYLESS verify-before-install (LBA-REQ-025 / ADR-0016, NETWORK-GATED): verify the .vsix's own keyless
# signature -- a Fulcio certificate bound to the extension-release.yml workflow identity + a public rekor entry,
# attached to the Release by the hardened release lane -- BEFORE installing it. Needs network (the sigstore TUF
# root + rekor). A failed OR absent signature BLOCKS the install (fail-closed). Set REVIEWER_ALLOW_UNSIGNED=1
# ONLY to install a pre-hardening release that predates artifact keyless-signing.
# The Fulcio cert identity binds to the ref the signing workflow ran on. The live release is keyless-signed by
# the canonical repository's extension-release.yml on workflow_dispatch from refs/heads/main (the release
# runbook; 1.5.2's certificate names refs/heads/main), and the maintainer then cuts the immutable release from that
# signed artifact. Accept that main-ref identity, the earlier develop-ref identity, or an ext-v* tag identity. The
# repo + workflow-file + OIDC-issuer pin is the real trust anchor, and the workflow's own fail-closed bidirectional
# WIN<->LINUX agreement gate is what authorizes the signature.
$KeylessIdentityRegexp = '^https://github\.com/svelderrainruiz/labview-benchmark-actor/\.github/workflows/extension-release\.yml@refs/(tags/ext-v|heads/(main|develop)$)'
$KeylessOidcIssuer = 'https://token.actions.githubusercontent.com'

function Ensure-Cosign {
  if (Get-Command cosign -ErrorAction SilentlyContinue) { return }
  Step "Installing cosign (sigstore) via direct download"
  New-Item -ItemType Directory -Force -Path 'C:\lba-bin' | Out-Null
  $exe = 'C:\lba-bin\cosign.exe'
  Invoke-WebRequest -Uri 'https://github.com/sigstore/cosign/releases/latest/download/cosign-windows-amd64.exe' -OutFile $exe -UseBasicParsing
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if ($machinePath -notlike '*C:\lba-bin*') { [Environment]::SetEnvironmentVariable('Path', "$machinePath;C:\lba-bin", 'Machine') }
  $env:Path = "$env:Path;C:\lba-bin"
  if (-not (Get-Command cosign -ErrorAction SilentlyContinue)) { throw "cosign install did not put 'cosign' on PATH." }
}

function Assert-VsixKeylessSignature([string]$ExtTag, [string]$Vsix, [string]$WorkDir) {
  gh release download $ExtTag --repo $repo --pattern '*.vsix.sigstore' --dir $WorkDir --clobber 2>$null
  $sig = Get-ChildItem $WorkDir -Filter '*.vsix.sigstore' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sig) {
    if ($env:REVIEWER_ALLOW_UNSIGNED -eq '1') {
      Step "WARN: release $ExtTag carries no *.vsix.sigstore keyless signature and REVIEWER_ALLOW_UNSIGNED=1 -> installing UNVERIFIED."
      return
    }
    throw "keyless verify-before-install BLOCKED: release $ExtTag carries no *.vsix.sigstore keyless signature. Cut the release with the hardened extension-release workflow, or set REVIEWER_ALLOW_UNSIGNED=1 to override (NOT recommended)."
  }
  Ensure-Cosign
  Step "cosign verify-blob: verifying the .vsix keyless signature ($($sig.Name))"
  & cosign verify-blob --bundle $sig.FullName --certificate-identity-regexp $KeylessIdentityRegexp --certificate-oidc-issuer $KeylessOidcIssuer $Vsix
  if ($LASTEXITCODE -ne 0) { throw "keyless verify-before-install BLOCKED: the .vsix keyless signature did not verify (exit $LASTEXITCODE). The .vsix will NOT be installed." }
  Step "cosign verify-blob: the .vsix keyless signature verified (pinned Fulcio identity + public rekor). Proceeding."
}

# 1) Extension .vsix from the ext-v* Release.
$extResolved = Resolve-Tag 'ext-v' $extTag
$dir = Join-Path $env:TEMP 'lba-ext'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# Remove any .vsix left by a PRIOR provisioning (a different ext version) first: otherwise
# `Get-ChildItem -Filter '*.vsix' | Select-Object -First 1` sorts by name and can pick a STALE
# lower-versioned .vsix, making cosign verify THIS release's signature against the wrong file
# (digest mismatch -> fail-closed BLOCK). Clean, then select the single freshly-downloaded .vsix.
Get-ChildItem $dir -Filter '*.vsix' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Step "Downloading extension .vsix from $extResolved"
gh release download $extResolved --repo $repo --pattern '*.vsix' --dir $dir --clobber
$vsix = Get-ChildItem $dir -Filter '*.vsix' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $vsix) { throw "No .vsix asset in release $extResolved." }
Assert-ReleaseProvenance -ExtTag $extResolved -WorkDir $dir
Assert-VsixKeylessSignature -ExtTag $extResolved -Vsix $vsix.FullName -WorkDir $dir
Step "Installing extension $($vsix.Name) into the interactive reviewer's profile"
Install-ExtensionForInteractiveUser $vsix.FullName

# 2) lbabus CLI (self-contained win-x64) from the pinned svelderrainruiz/lbabus Release. The tag and the SHA-256 of
#    the win-x64 binary come from release-components.json (lbabusRelease) via the Vagrantfile; fail closed on a mismatch.
$lbabusSha = $env:REVIEWER_LBABUS_SHA256
if ($lbabusTag -notmatch '^v\d+\.\d+\.\d+$' -or $lbabusSha -notmatch '^[0-9a-f]{64}$') {
  throw "REVIEWER_LBABUS_TAG ('$lbabusTag') and REVIEWER_LBABUS_SHA256 must carry the lbabus pin from release-components.json."
}
$binDir = 'C:\lba-bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Step "Downloading lbabus $lbabusTag from svelderrainruiz/lbabus"
$lbDownload = Join-Path $binDir 'lbabus.download'
Remove-Item $lbDownload -Force -ErrorAction SilentlyContinue
$lbAsset = "lbabus-$($lbabusTag.Substring(1))-win-x64.exe"
gh release download $lbabusTag --repo svelderrainruiz/lbabus --pattern $lbAsset --output $lbDownload --clobber
if ($LASTEXITCODE -ne 0) { throw "lbabus $lbabusTag download failed ($LASTEXITCODE)." }
$lbActual = (Get-FileHash $lbDownload -Algorithm SHA256).Hash.ToLowerInvariant()
if ($lbActual -ne $lbabusSha) {
  Remove-Item $lbDownload -Force
  throw "lbabus $lbAsset SHA-256 mismatch: pinned $lbabusSha, downloaded $lbActual."
}
Move-Item $lbDownload (Join-Path $binDir 'lbabus.exe') -Force
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($machinePath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$machinePath;$binDir", 'Machine')
}
Step "lbabus installed at $binDir\lbabus.exe (added to Machine PATH)"

# 3) Scratch workspace so the reviewer can open a folder and run Write/Show/Check immediately.
$ws = 'C:\lba-review'
New-Item -ItemType Directory -Force -Path $ws | Out-Null
Set-Content -Path (Join-Path $ws 'README.txt') -Encoding ASCII -Value @'
labview-benchmark-actor reviewer workspace.

1. Open this folder in VS Code (the extension is already installed).
2. Follow docs/testing/reviewer-manual-test-plan.md via the Command Palette
   (Ctrl+Shift+P -> "LabVIEW Benchmark Actor: ...").
3. Bus + capabilities commands need "gh auth login" first (reviewer-supplied).
4. End-to-end LabVIEW (TC-09) uses 32-bit LabVIEW 2026 host-native headless;
   see the golden-box docs.
'@
Step "Scratch workspace at $ws"
Step "DONE. Open VS Code with:  code C:\lba-review  (the extension is installed)."
