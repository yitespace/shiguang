// =============================================================
// CDP 桥接（WSL 侧）
// 原理：WSL 连不上 Windows 的 Chrome 调试端口，
//       所以把一段 PowerShell 脚本用 Base64(UTF-16LE) 编码后
//       通过 powershell.exe -EncodedCommand 送过去执行，
//       PowerShell 在 Windows 侧直连 CDP，把结果以文本/Base64 传回来。
// =============================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.win');

/** PowerShell 侧的 CDP 驱动（固定部分） */
const DRIVER = String.raw`
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Port = "9222"
$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 10
$page = $targets | Where-Object { $_.type -eq "page" -and $_.url -notlike "devtools://*" } | Select-Object -First 1
if (-not $page) { Write-Output "FATAL no-page"; exit 1 }
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.Options.SetRequestHeader("Origin", "http://127.0.0.1:$Port")
$cts = New-Object System.Threading.CancellationTokenSource
$cts.CancelAfter(20000)
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $cts.Token).Wait()
$script:id = 0
function Send($method, $params) {
  $script:id++
  $msg = @{ id = $script:id; method = $method; params = $params } | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync((New-Object ArraySegment[byte] -ArgumentList @(,$bytes)), [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
  $buf = New-Object byte[] 16777216
  while ($true) {
    $ms = New-Object IO.MemoryStream
    do {
      $t = $ws.ReceiveAsync((New-Object ArraySegment[byte] -ArgumentList @(,$buf)), [Threading.CancellationToken]::None)
      $t.Wait(40000) | Out-Null
      $r = $t.Result
      $ms.Write($buf, 0, $r.Count)
    } while (-not $r.EndOfMessage)
    $o = ([Text.Encoding]::UTF8.GetString($ms.ToArray())) | ConvertFrom-Json
    if ($o.id -eq $script:id) { return $o }
  }
}
Send "Page.enable" @{} | Out-Null
function Emit($tag, $val) { Write-Output ("@@@" + $tag + "@@@"); Write-Output $val; Write-Output ("@@@END" + $tag + "@@@") }
`;

/**
 * 执行一段 CDP 操作脚本（可用 Send / Emit / ws）
 * @param {string} body PowerShell 代码
 */
function run(body, { timeoutMs = 240000 } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const ps = DRIVER + body + '\ntry { $ws.Dispose() } catch {}';
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  let raw = '';
  try {
    raw = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], {
      timeout: timeoutMs,
      maxBuffer: 200 * 1024 * 1024,
      encoding: 'buffer',
    }).toString('utf8');
  } catch (e) {
    raw = (e.stdout ? e.stdout.toString('utf8') : '') + (e.stderr ? e.stderr.toString('utf8') : '');
  }
  return raw;
}

/** 从输出里取某个 tag 的内容 */
function pick(raw, tag) {
  const re = new RegExp(`@@@${tag}@@@\\r?\\n([\\s\\S]*?)\\r?\\n@@@END${tag}@@@`);
  const m = re.exec(raw);
  return m ? m[1].trim() : null;
}

/** 取 JSON 结果 */
function pickJson(raw, tag) {
  const s = pick(raw, tag);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

/** 保存截图 tag 到文件 */
function saveShot(raw, tag, file) {
  const b64 = pick(raw, tag);
  if (!b64 || b64.length < 500) return null;
  const p = path.join(OUT, file);
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}

/** 常用表达式：页面状态 */
const STATE_EXPR = `JSON.stringify({
  url: location.href,
  host: location.host,
  title: document.title,
  bodyLen: (document.body ? document.body.innerText.length : 0),
  text: (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0, 400)
})`;

export { run, pick, pickJson, saveShot, OUT, STATE_EXPR };

// 直接执行时：打印当前页面状态
if (process.argv[1] && process.argv[1].endsWith('cdp-bridge.mjs')) {
  const raw = run(`
$s = Send "Runtime.evaluate" @{ expression = "${STATE_EXPR.replace(/"/g, '\\"')}"; returnByValue = $true }
Emit "STATE" $s.result.result.value
`);
  const st = pickJson(raw, 'STATE');
  console.log(JSON.stringify(st, null, 2));
}
