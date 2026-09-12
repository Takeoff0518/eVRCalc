<#
  eVRCalc backend build script (Windows PowerShell)

  Usage:
    .\build.ps1                     # build for the current platform
    .\build.ps1 linux-amd64         # cross-compile for Linux x86_64
    .\build.ps1 linux-arm64         # Linux aarch64
    .\build.ps1 linux-armv7         # 32-bit ARM
    .\build.ps1 windows-amd64
    .\build.ps1 all                 # all of the above
    .\build.ps1 clean               # remove dist\

  Output goes to server\dist\ with a platform suffix in the filename,
  ready to scp to the target machine.

  NOTE ON ENCODING: this file is deliberately ASCII-only. Windows PowerShell
  5.1 reads BOM-less files as ANSI/GBK, so Chinese text here would be mangled
  into syntax errors. The Chinese documentation lives in build.sh, README.md
  and DEPLOY.md instead.

  NOTE ON MODULES: the build needs the dependency sources. If
  proxy.golang.org is unreachable, set $env:GOPROXY="https://goproxy.cn,direct"
  beforehand; or run `go mod vendor` once and builds become fully offline.
#>

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Target = 'native',

  [string]$Version = $(if ($env:VERSION) { $env:VERSION } else { '1.0.0' })
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$outDir = if ($env:OUT_DIR) { $env:OUT_DIR } else { 'dist' }

# Keep the Go build cache inside the repo when the default location is not
# writable. On this machine C:\Users\<user>\AppData\Local\go-build is blocked
# (sandbox / security software), which makes every go build fail with
# "failed to initialize build cache ... Access is denied". Harmless elsewhere.
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $env:GOCACHE) { $env:GOCACHE = Join-Path $repoRoot '.gocache' }
if (-not $env:GOTMPDIR) { $env:GOTMPDIR = Join-Path $repoRoot '.gotmp' }
foreach ($d in @($env:GOCACHE, $env:GOTMPDIR)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# -trimpath             strip local absolute paths (reproducible, no path leak)
# -s -w                 drop symbol table and DWARF (about 30% smaller)
# -X main.buildVersion  inject the version so --version is not hard-coded
$ldflags = "-s -w -X main.buildVersion=$Version"

function Build-One {
  param(
    [string]$GoOs,
    [string]$GoArch,
    [string]$GoArm = '',
    [string]$Label
  )

  $out = Join-Path $outDir "evrcalc-server-$Label"
  $armNote = if ($GoArm) { " GOARM=$GoArm" } else { '' }
  Write-Host "  -> $Label  (GOOS=$GoOs GOARCH=$GoArch$armNote)"

  # Environment variables do NOT persist across statements in a pipeline,
  # so set them, build, then restore - all inside one scope.
  $savedGoOs = $env:GOOS; $savedGoArch = $env:GOARCH
  $savedGoArm = $env:GOARM; $savedCgo = $env:CGO_ENABLED
  try {
    if ($GoOs) { $env:GOOS = $GoOs }
    if ($GoArch) { $env:GOARCH = $GoArch }
    if ($GoArm) { $env:GOARM = $GoArm }
    $env:CGO_ENABLED = '0'
    & go build -trimpath -ldflags $ldflags -o $out .
    if ($LASTEXITCODE -ne 0) { throw "go build failed for $Label" }
  }
  finally {
    $env:GOOS = $savedGoOs; $env:GOARCH = $savedGoArch
    $env:GOARM = $savedGoArm; $env:CGO_ENABLED = $savedCgo
  }

  $size = (Get-Item $out).Length
  Write-Host ("     {0}  ({1:N0} KB)" -f $out, ($size / 1KB))
}

function Build-Named {
  param([string]$Name)
  switch ($Name) {
    'linux-amd64'   { Build-One -GoOs linux   -GoArch amd64 -Label 'linux-amd64' }
    'linux-arm64'   { Build-One -GoOs linux   -GoArch arm64 -Label 'linux-arm64' }
    'linux-armv7'   { Build-One -GoOs linux   -GoArch arm   -GoArm 7 -Label 'linux-armv7' }
    'linux-386'     { Build-One -GoOs linux   -GoArch 386   -Label 'linux-386' }
    'windows-amd64' { Build-One -GoOs windows -GoArch amd64 -Label 'windows-amd64.exe' }
    'darwin-arm64'  { Build-One -GoOs darwin  -GoArch arm64 -Label 'darwin-arm64' }
    'darwin-amd64'  { Build-One -GoOs darwin  -GoArch amd64 -Label 'darwin-amd64' }
    default {
      throw ("Unknown target: {0}`nAvailable: linux-amd64 linux-arm64 linux-armv7 linux-386 windows-amd64 darwin-arm64 darwin-amd64 all clean" -f $Name)
    }
  }
}

$allTargets = @(
  'linux-amd64', 'linux-arm64', 'linux-armv7', 'linux-386',
  'windows-amd64', 'darwin-arm64', 'darwin-amd64'
)

if ($Target -eq 'clean') {
  Remove-Item -Recurse -Force $outDir -ErrorAction SilentlyContinue
  Write-Host "Removed $outDir\"
}
else {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  if ($Target -eq 'all') {
    Write-Host "Building all targets (version $Version)"
    foreach ($t in $allTargets) { Build-Named $t }
  }
  elseif ($Target -eq 'native') {
    Write-Host "Building for the current platform (version $Version)"
    Build-One -Label 'native'
  }
  else {
    Write-Host "Building $Target (version $Version)"
    Build-Named $Target
  }
}

Write-Host ''
Write-Host 'Done. Artifacts:'
Get-ChildItem $outDir -ErrorAction SilentlyContinue |
  Select-Object Name, @{ n = 'Size'; e = { "{0:N2} MB" -f ($_.Length / 1MB) } } |
  Format-Table -AutoSize
