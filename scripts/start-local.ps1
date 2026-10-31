$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeDirectory = Join-Path $repoRoot '.local-tools\node24'
$podmanDirectory = 'C:\Program Files\RedHat\Podman'
$supabaseCli = Join-Path $repoRoot '.local-tools\supabase\supabase.exe'
$podman = Join-Path $podmanDirectory 'podman.exe'
$npm = Join-Path $nodeDirectory 'npm.cmd'
$node = Join-Path $nodeDirectory 'node.exe'

foreach ($requiredPath in @($node, $npm, $podman, $supabaseCli, (Join-Path $repoRoot 'supabase\config.toml'), (Join-Path $repoRoot 'apps\web\.env.local'))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required local file not found: $requiredPath"
    }
}

$env:PATH = "$nodeDirectory;$podmanDirectory;$env:PATH"
$env:NODE_OPTIONS = '--use-system-ca'

$nodeVersion = (& $node --version).Trim()
if ($nodeVersion -notmatch '^v24\.') {
    throw "Node.js 24 is required. Found: $nodeVersion"
}

Set-Location -LiteralPath $repoRoot

$machineState = (& $podman machine inspect --format '{{.State}}' podman-machine-default 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Could not inspect Podman machine podman-machine-default.'
}
if ($machineState -ne 'running') {
    Write-Host 'Starting local Podman machine...'
    & $podman machine start podman-machine-default | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not start Podman machine.'
    }
}

Write-Host 'Starting local Supabase (optional analytics services excluded)...'
# The CLI prints local keys in its success summary; suppress output to avoid displaying credentials.
$supabaseStdout = Join-Path $env:TEMP "supabase-start-$PID.out"
$supabaseStderr = Join-Path $env:TEMP "supabase-start-$PID.err"
try {
    $supabaseProcess = Start-Process -FilePath $supabaseCli -ArgumentList @('start', '--exclude', 'logflare,vector') -WorkingDirectory $repoRoot -Wait -PassThru -NoNewWindow -RedirectStandardOutput $supabaseStdout -RedirectStandardError $supabaseStderr
}
finally {
    Remove-Item -LiteralPath $supabaseStdout, $supabaseStderr -Force -ErrorAction SilentlyContinue
}
if ($supabaseProcess.ExitCode -ne 0) {
    throw "Local Supabase did not start (exit code $($supabaseProcess.ExitCode)). No credentials were displayed."
}

Write-Host 'Local Supabase is ready. Starting the app at http://127.0.0.1:5173/.'
& $npm run dev --workspace=web -- --host 127.0.0.1 --strictPort
exit $LASTEXITCODE
