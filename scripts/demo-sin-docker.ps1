# Levanta GrowLink completo SIN Docker, para probarlo y hacer demos:
# los 3 servicios (bases de datos en memoria) y el front en modo desarrollo.
#
#   .\infra\scripts\demo-sin-docker.ps1            levanta todo y abre el navegador
#   .\infra\scripts\demo-sin-docker.ps1 -Parar     lo apaga
#
# Hace falta Java 21, Maven y Node 22 o mas nuevo.
# Ojo: las bases viven en memoria, al apagar los servicios se pierde todo lo que se haya hecho
# (los usuarios y cursos de prueba se vuelven a crear solos al arrancar).
# Si tienes la variable de entorno CLAUDE_API_KEY puesta, el roadmap usa la IA de verdad.

param([switch]$Parar)

$puertos = 5173, 8080, 8085, 8086

if ($Parar) {
    foreach ($p in $puertos) {
        $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host "detenido lo que estaba en el puerto $p" }
    }
    Write-Host "Listo. Si quedaron ventanas de PowerShell abiertas las puedes cerrar."
    return
}

$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

$ocupados = $puertos | Where-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue }
if ($ocupados) {
    Write-Host "Estos puertos ya estan ocupados: $($ocupados -join ', ')." -ForegroundColor Yellow
    Write-Host "Probablemente ya esta corriendo. Para apagarlo: .\infra\scripts\demo-sin-docker.ps1 -Parar"
    return
}

# el mismo secreto en los tres servicios, asi el token de uno sirve en los otros
$env:GROWLINK_JWT_SECRET = "clave-de-demo-local-de-minimo-32-caracteres-xx"
$env:GROWLINK_INTERNAL_KEY = "llave-interna-de-demo"
$env:GROWLINK_CURSOS_SERVICE_URL = "http://localhost:8086"
$env:USUARIOS_BASE_URL = "http://localhost:8080"
$env:CURSOS_BASE_URL = "http://localhost:8086"
$env:SPRING_DATASOURCE_DRIVER_CLASS_NAME = "org.h2.Driver"
$env:SPRING_DATASOURCE_USERNAME = "sa"
$env:SPRING_DATASOURCE_PASSWORD = ""
$env:SPRING_JPA_HIBERNATE_DDL_AUTO = "create-drop"

function Iniciar-Servicio($carpeta, $baseDeDatos) {
    $env:SPRING_DATASOURCE_URL = "jdbc:h2:mem:$baseDeDatos;MODE=PostgreSQL;DB_CLOSE_DELAY=-1"
    $comando = "`$Host.UI.RawUI.WindowTitle = '$carpeta'; cd '$raiz\$carpeta'; mvn spring-boot:run '-Dspring-boot.run.useTestClasspath=true'"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $comando
    Write-Host "arrancando $carpeta ..."
}

Iniciar-Servicio "usuarios-service" "growlink"
Iniciar-Servicio "cursos-service" "cursos"
Iniciar-Servicio "trivia-service" "trivia"

if (-not (Test-Path "$raiz\GrowLink-FRONTEND\node_modules")) {
    Write-Host "instalando las dependencias del front (solo la primera vez) ..."
    Push-Location "$raiz\GrowLink-FRONTEND"; npm install --no-audit --no-fund | Out-Null; Pop-Location
}
$comandoFront = "`$Host.UI.RawUI.WindowTitle = 'GrowLink-FRONTEND'; cd '$raiz\GrowLink-FRONTEND'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $comandoFront
Write-Host "arrancando GrowLink-FRONTEND ..."

# espera a que todo responda (los servicios tardan casi un minuto la primera vez)
$pruebas = @{
    "usuarios-service" = "http://localhost:8080/api/auth/usuarios"
    "cursos-service"   = "http://localhost:8086/api/habilidades"
    "trivia-service"   = "http://localhost:8085/api/salas/NOEXISTE"
    "front"            = "http://localhost:5173/"
}
Write-Host "esperando a que todo responda ..."
foreach ($nombre in $pruebas.Keys) {
    $listo = $false
    for ($i = 0; $i -lt 60 -and -not $listo; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $pruebas[$nombre] -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            $listo = $true
        } catch {
            # un 403 o 404 tambien significa que el servicio esta vivo
            if ($_.Exception.Response) { $listo = $true } else { Start-Sleep -Seconds 3 }
        }
    }
    if ($listo) { Write-Host "  $nombre listo" -ForegroundColor Green } else { Write-Host "  $nombre NO respondio, mira su ventana" -ForegroundColor Red }
}

Write-Host ""
Write-Host "GrowLink esta en http://localhost:5173  (entra con Ana, Beto o Carla)"
Write-Host "Para apagarlo todo: .\infra\scripts\demo-sin-docker.ps1 -Parar"
Start-Process "http://localhost:5173"
