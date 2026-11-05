$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$environmentPath = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $environmentPath) {
  Write-Output 'O arquivo local .env já existe; nenhum segredo foi alterado.'
  exit 0
}

function New-LocalSecret {
  $bytes = [byte[]]::new(32)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $generator.Dispose()
  }
}

$template = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Raw
$environment = $template.Replace('EVOLUTION_API_KEY=GENERATE_ON_INIT', "EVOLUTION_API_KEY=$(New-LocalSecret)")
$environment = $environment.Replace('POSTGRES_PASSWORD=GENERATE_ON_INIT', "POSTGRES_PASSWORD=$(New-LocalSecret)")
$environment = $environment.Replace('REDIS_PASSWORD=GENERATE_ON_INIT', "REDIS_PASSWORD=$(New-LocalSecret)")
[System.IO.File]::WriteAllText($environmentPath, $environment, [System.Text.UTF8Encoding]::new($false))

Write-Output 'Arquivo local .env criado com chaves aleatórias. Ele é ignorado pelo Git.'
