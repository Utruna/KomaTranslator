# Construit le paquet de l'extension à partager : dist\komatranslator-<version>.zip
#  - Chrome / Brave / Opera / Edge : dézipper puis "Charger l'extension non empaquetée"
#  - Firefox : ce zip est celui à faire signer (tools\sign_firefox.bat) pour obtenir un .xpi installable
# La police perso extension\fonts\font.* (licence non redistribuable) est exclue.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root "extension"
$version = (Get-Content (Join-Path $ext "manifest.json") -Raw | ConvertFrom-Json).version
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$zip = Join-Path $dist "komatranslator-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, "Create")
try {
    Get-ChildItem $ext -Recurse -File | Where-Object { $_.Name -notlike "font.*" } | ForEach-Object {
        # chemins avec "/" (obligatoire pour Firefox)
        $rel = $_.FullName.Substring($ext.Length + 1).Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $rel, "Optimal") | Out-Null
    }
} finally { $archive.Dispose() }

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Cree : $zip ($size Mo)"
