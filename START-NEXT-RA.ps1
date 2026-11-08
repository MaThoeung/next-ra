# NEXT-RA local launcher. Serves static files on loopback only; it is not exposed to the network.
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$listener = $null
$port = $null

foreach ($candidate in 8765..8775) {
    try {
        $test = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
        $test.Start()
        $listener = $test
        $port = $candidate
        break
    } catch {
        if ($test) { try { $test.Stop() } catch {} }
    }
}

if (-not $listener) {
    Write-Host 'Could not find an available local port between 8765 and 8775.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

$baseUrl = "http://127.0.0.1:$port/"
Write-Host ''
Write-Host 'NEXT-RA local web server is running.' -ForegroundColor Green
Write-Host "Address: $baseUrl" -ForegroundColor Cyan
Write-Host 'Keep this window open while using NEXT-RA.' -ForegroundColor Yellow
Write-Host 'Press Ctrl+C in this window to stop the server.'
Write-Host ''
Start-Process $baseUrl

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
    '.json' = 'application/json; charset=utf-8'
    '.txt'  = 'text/plain; charset=utf-8'
    '.webp' = 'image/webp'
}
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

try {
    while ($listener.Server.IsBound) {
        $client = $null
        try {
            $client = $listener.AcceptTcpClient()
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($requestLine)) { $client.Close(); continue }
            while ($true) {
                $headerLine = $reader.ReadLine()
                if ($null -eq $headerLine -or $headerLine -eq '') { break }
            }

            $parts = $requestLine.Split(' ')
            $method = $parts[0]
            $target = if ($parts.Length -gt 1) { $parts[1] } else { '/' }
            $pathOnly = ($target -split '\?', 2)[0]
            $decoded = [System.Uri]::UnescapeDataString($pathOnly).TrimStart('/')
            if ([string]::IsNullOrWhiteSpace($decoded)) { $decoded = 'index.html' }
            $decoded = $decoded.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $decoded))

            $status = '200 OK'
            $body = [byte[]]@()
            $contentType = 'application/octet-stream'
            if ($method -ne 'GET' -and $method -ne 'HEAD') {
                $status = '405 Method Not Allowed'
                $body = [System.Text.Encoding]::UTF8.GetBytes('Method Not Allowed')
                $contentType = 'text/plain; charset=utf-8'
            } elseif (-not ($filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or $filePath -eq (Join-Path $root 'index.html'))) {
                $status = '403 Forbidden'
                $body = [System.Text.Encoding]::UTF8.GetBytes('Forbidden')
                $contentType = 'text/plain; charset=utf-8'
            } elseif (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
                $status = '404 Not Found'
                $body = [System.Text.Encoding]::UTF8.GetBytes('Not Found')
                $contentType = 'text/plain; charset=utf-8'
            } else {
                $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
                if ($mime.ContainsKey($extension)) { $contentType = $mime[$extension] }
                $body = [System.IO.File]::ReadAllBytes($filePath)
            }

            $length = $body.Length
            $header = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $length`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($method -ne 'HEAD' -and $length -gt 0) { $stream.Write($body, 0, $length) }
            $stream.Flush()
        } catch {
            Write-Host "Local server request error: $($_.Exception.Message)" -ForegroundColor DarkYellow
        } finally {
            if ($client) { $client.Close() }
        }
    }
} finally {
    if ($listener) { $listener.Stop() }
}
