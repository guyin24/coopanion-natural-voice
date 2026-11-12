param(
  [Parameter(Mandatory=$true)][string]$Tag,
  [Parameter(Mandatory=$true)][string]$ExpectedCommit,
  [Parameter(Mandatory=$true)][string]$Repository,
  [string]$AssetDirectory = 'output'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($Tag -ne "v$version" -or $ExpectedCommit -notmatch '^[a-f0-9]{40}$') { throw 'Release tag or commit is invalid.' }
$tagCommit = & git rev-parse "${Tag}^{commit}"
if ($LASTEXITCODE -ne 0 -or $tagCommit -ne $ExpectedCommit) { throw 'Release tag does not match the checked commit.' }
$requiredNames = @("Coopanion-Natural-Voice-Market-$version.zip", "Coopanion-Natural-Voice-Full-$version.zip", "cortico-world-natural-voice-$version.tgz", 'SHA256SUMS.txt')
$existingJson = & gh release view $Tag --repo $Repository --json isDraft,assets 2>$null
if ($LASTEXITCODE -eq 0) {
  $existing = $existingJson | ConvertFrom-Json
  if ($existing.isDraft) { throw 'Existing release is still a draft; inspect it before retrying.' }
  foreach ($name in $requiredNames) {
    if (!($existing.assets | Where-Object { $_.name -eq $name -and $_.state -eq 'uploaded' })) { throw 'Existing release is incomplete; inspect it before retrying.' }
  }
  Write-Output "Release $Tag is already published; preserving its verified assets."
  exit 0
}
$assets = @($requiredNames | ForEach-Object {
  $path = Join-Path $AssetDirectory $_
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw ('Missing release asset: ' + $_) }
  (Resolve-Path -LiteralPath $path).Path
})
& gh release create $Tag @assets --repo $Repository --verify-tag --title "Natural Voice $Tag" --notes-file (Join-Path $PSScriptRoot "../docs/releases/$Tag.md")
if ($LASTEXITCODE -ne 0) { throw 'Release publication failed.' }
