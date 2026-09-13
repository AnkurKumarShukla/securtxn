<#
.SYNOPSIS
  Puts the whole app behind one public URL, and points the config at it.

.DESCRIPTION
  ONE TUNNEL, NOT TWO, and that is a constraint rather than a preference: the
  free ngrok plan allows a single agent. It works because the web app already
  proxies the API's path prefixes to the API process (see next.config.mjs), so
  one hostname serves the pages AND the API and the browser only ever talks to
  one origin. Tunnelling the API separately would need a second agent and would
  reintroduce the CORS problem the proxy exists to avoid.

      browser --> https://<domain> --> :3001 web --> :3000 api

  STATIC BEATS EPHEMERAL, for one reason that is not convenience: DigiLocker
  only redirects to a URL registered against the app. A hostname that changes
  every run has to be re-registered every run, and until it is, the consent step
  fails. Everything else here works fine on a random URL.

.PARAMETER Domain
  A reserved ngrok domain, no scheme. Defaults to whatever `NGROK_DOMAIN` in the
  repo .env says. Without one the tunnel still runs, on a random hostname.
#>
param(
  [string]$Domain,
  [int]$Port = 3001
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo ".env"
$webEnv  = Join-Path $repo "apps\web\.env.local"

function Get-EnvValue([string]$file, [string]$key) {
  if (-not (Test-Path $file)) { return $null }
  $line = Select-String -Path $file -Pattern "^$key=" | Select-Object -First 1
  if ($line) { return ($line.Line -split '=', 2)[1].Trim() }
  return $null
}

function Set-EnvValue([string]$file, [string]$key, [string]$value) {
  $lines = if (Test-Path $file) { Get-Content $file } else { @() }
  if ($lines -match "^$key=") {
    $lines = $lines -replace "^$key=.*", "$key=$value"
  } else {
    $lines += "$key=$value"
  }
  Set-Content -Path $file -Value $lines -Encoding utf8
}

# --- the authtoken is the one thing this script cannot supply ---------------
ngrok config check *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nngrok has no saved authtoken." -ForegroundColor Yellow
  Write-Host "Get it from https://dashboard.ngrok.com/get-started/your-authtoken, then run:"
  Write-Host "  ngrok config add-authtoken <your-token>`n"
  exit 1
}

if (-not $Domain) { $Domain = Get-EnvValue $envFile "NGROK_DOMAIN" }

if ($Domain) {
  Write-Host "Tunnelling https://$Domain -> http://localhost:$Port" -ForegroundColor Cyan
  $args = @("http", "$Port", "--url=https://$Domain")
} else {
  Write-Host "No NGROK_DOMAIN set — using a random hostname for this run." -ForegroundColor Yellow
  Write-Host "Claim your free static domain at https://dashboard.ngrok.com/domains," -ForegroundColor Yellow
  Write-Host "then put it in .env as NGROK_DOMAIN=<name>.ngrok-free.app`n" -ForegroundColor Yellow
  $args = @("http", "$Port")
}

# Started detached so this script can read the assigned URL back out of the
# agent's local API and write it into the three places that must agree with it.
$proc = Start-Process -FilePath "ngrok" -ArgumentList $args -PassThru -NoNewWindow

try {
  $url = $null
  foreach ($i in 1..20) {
    Start-Sleep -Milliseconds 700
    try {
      $t = Invoke-RestMethod "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 3
      $url = ($t.tunnels | Where-Object { $_.public_url -like "https://*" } | Select-Object -First 1).public_url
      if ($url) { break }
    } catch { }
  }
  if (-not $url) { Write-Error "ngrok did not report a public URL. Is it already running?" }

  $host_ = ([uri]$url).Host

  # The three settings that must agree with the hostname, kept in step
  # automatically because forgetting one produces a failure that looks like
  # something else entirely.
  Set-EnvValue $envFile "DIGILOCKER_REDIRECT_URL" "$url/identity/callback"
  Set-EnvValue $envFile "NGROK_DOMAIN" $host_
  $cors = Get-EnvValue $envFile "CORS_ORIGINS"
  $parts = @($cors -split ',' | Where-Object { $_ }) + $url | Select-Object -Unique
  Set-EnvValue $envFile "CORS_ORIGINS" ($parts -join ',')
  Set-EnvValue $webEnv "TUNNEL_HOST" $host_

  Write-Host ""
  Write-Host "  PUBLIC URL   $url" -ForegroundColor Green
  Write-Host "  inspector    http://127.0.0.1:4040"
  Write-Host ""
  Write-Host "Config updated: DIGILOCKER_REDIRECT_URL, CORS_ORIGINS, NGROK_DOMAIN, TUNNEL_HOST."
  Write-Host "RESTART the API and web processes so they pick those up." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "DigiLocker will refuse the consent redirect until this exact URL is" -ForegroundColor DarkGray
  Write-Host "registered against the app: $url/identity/callback" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "Ctrl+C to stop the tunnel."

  Wait-Process -Id $proc.Id
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
