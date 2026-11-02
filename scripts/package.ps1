param([string]$OutputDirectory = 'output')
$ErrorActionPreference = 'Stop'
function FileSha256([string]$Path) {
  $hasher = [Security.Cryptography.SHA256]::Create()
  $inputStream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($hasher.ComputeHash($inputStream))).Replace('-', '') }
  finally { $inputStream.Dispose(); $hasher.Dispose() }
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$out = [IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
if (!$out.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Build output must stay inside the repository.'
}
$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid release version.' }
$stage = Join-Path $out ('package-' + $version)
$folder = Join-Path $stage 'cortico-world-natural-voice'
$archive = Join-Path $out ('Coopanion-Natural-Voice-' + $version + '.zip')
$tarball = Join-Path $out ($pkg.name + '-' + $version + '.tgz')
foreach ($target in @($stage, $archive, $tarball)) {
  if (Test-Path -LiteralPath $target) { throw 'Build target exists. Use a clean checkout or a new -OutputDirectory.' }
}
New-Item -ItemType Directory -Path $out -Force | Out-Null
Push-Location $root
try {
  if ($env:npm_execpath -and (Test-Path -LiteralPath $env:npm_execpath)) {
    $nodeCommand = if ($env:npm_node_execpath) { $env:npm_node_execpath } else { 'node' }
    $packOutput = & $nodeCommand $env:npm_execpath pack --json --pack-destination $out
  } else {
    $packOutput = & npm pack --json --pack-destination $out
  }
  if ($LASTEXITCODE -ne 0) { throw 'npm pack failed.' }
  $manifest = @(([string]::Join([Environment]::NewLine, $packOutput)) | ConvertFrom-Json)[0]
} finally { Pop-Location }
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$sourcePrefix = $root.TrimEnd('\') + '\'
$destPrefix = $folder.TrimEnd('\') + '\'
foreach ($entry in $manifest.files) {
  $relative = $entry.path.Replace('\', '/')
  if ($relative -match '(^|/)(\.env(?:\..*)?|node_modules|scratch|output|tests|scripts|docs)(/|$)' -or $relative -match '(^|/)\.\.(/|$)') {
    throw 'Development or unsafe data in npm manifest.'
  }
  $source = [IO.Path]::GetFullPath((Join-Path $root $relative))
  $dest = [IO.Path]::GetFullPath((Join-Path $folder $relative))
  if (!$source.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or !$dest.StartsWith($destPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Package path escaped the repository or staging directory.'
  }
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($dest)) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $dest
}
Compress-Archive -LiteralPath $folder -DestinationPath $archive -CompressionLevel Optimal
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
$sha = [Security.Cryptography.SHA256]::Create()
$names = @()
try {
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if ($name -match '[^\x20-\x7e]' -or !$name.StartsWith('cortico-world-natural-voice/') -or $name.Contains('../')) { throw 'Unsafe archive path.' }
    if ($name.EndsWith('/')) { continue }
    $relative = $name.Substring('cortico-world-natural-voice/'.Length)
    if ($relative -notin $manifest.files.path) { throw 'Unexpected archive entry.' }
    $stream = $entry.Open()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') } finally { $stream.Dispose() }
    $expected = FileSha256 (Join-Path $root $relative)
    if ($actual -ne $expected) { throw ('Source hash mismatch: ' + $relative) }
    $names += $relative
  }
} finally { $zip.Dispose(); $sha.Dispose() }
if ($names.Count -ne $manifest.files.Count) { throw 'Archive file count mismatch.' }
foreach ($required in @('package.json', 'src/index.js', 'src/native/PcmPlayer.cs', 'src/player-stream.js', 'src/providers/aliyun-stream.js', 'web/client.js', 'describe.json', 'LICENSE', 'NOTICE.md')) {
  if ($required -notin $names) { throw ('Missing runtime file: ' + $required) }
}
$checksums = @($archive, $tarball) | ForEach-Object {
  (FileSha256 $_).ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($_)
}
[IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS.txt'), [string]::Join("`n", $checksums) + "`n", (New-Object Text.UTF8Encoding($false)))
$result = @{ version = $version; files = $names.Count; sourceHashesMatch = $true; archive = $archive; tarball = $tarball }
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'package-verification.json') -Encoding UTF8
$result | ConvertTo-Json
