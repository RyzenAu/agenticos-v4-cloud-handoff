# Test helper: a minimal HTTP responder standing in for the hub (answers 200 to anything on 127.0.0.1:<Port>).
param([Parameter(Mandatory)][int]$Port)
$l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
$l.Start()
while ($true) {
  $c = $l.AcceptTcpClient()
  try {
    $s = $c.GetStream()
    $buf = New-Object byte[] 2048
    [void]$s.Read($buf, 0, 2048)
    $resp = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Length: 2`r`nConnection: close`r`n`r`nok")
    $s.Write($resp, 0, $resp.Length)
  } catch { } finally { $c.Close() }
}
