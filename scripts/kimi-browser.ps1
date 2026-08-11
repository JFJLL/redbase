[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("status", "navigate", "find_tab", "snapshot", "click", "fill", "evaluate", "screenshot", "network", "list_tabs", "close_tab", "close_session", "save_as_pdf")]
    [string]$Action,
    [string]$Url,
    [string]$Selector,
    [string]$Value,
    [string]$Code,
    [string]$Session = "verify-change",
    [string]$GroupTitle,
    [string]$NetworkCmd,
    [string]$Format,
    [string]$Path,
    [switch]$NewTab,
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

if ($Action -eq "status") {
    $bin = Join-Path $HOME ".kimi-webbridge\bin\kimi-webbridge.exe"
    if (-not (Test-Path -LiteralPath $bin)) {
        Write-Output '{"error":"kimi-webbridge binary not found"}'
        exit 2
    }
    & $bin status
    exit 0
}

$args = @{}
switch ($Action) {
    "navigate" {
        if (-not $Url) { throw "navigate requires -Url" }
        $args.url = $Url
        if ($NewTab) { $args.newTab = $true }
        if ($GroupTitle) { $args.group_title = $GroupTitle }
    }
    "find_tab" {
        if (-not $Url) { throw "find_tab requires -Url" }
        $args.url = $Url
    }
    "click" {
        if (-not $Selector) { throw "click requires -Selector" }
        $args.selector = $Selector
    }
    "fill" {
        if (-not $Selector) { throw "fill requires -Selector" }
        $args.selector = $Selector
        $args.value = $Value
    }
    "evaluate" {
        if (-not $Code) { throw "evaluate requires -Code" }
        $args.code = $Code
    }
    "screenshot" {
        if ($Format) { $args.format = $Format }
        if ($Selector) { $args.selector = $Selector }
        if ($Path) { $args.path = $Path }
    }
    "network" {
        if (-not $NetworkCmd) { throw "network requires -NetworkCmd start|stop|list|detail" }
        $args.cmd = $NetworkCmd
    }
    "save_as_pdf" {
        if ($Path) { $args.path = $Path }
    }
}

$body = @{
    action = $Action
    args = $args
    session = $Session
} | ConvertTo-Json -Compress -Depth 8

try {
    $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:10086/command" -ContentType "application/json" -Body $body -TimeoutSec $TimeoutSeconds
    $response | ConvertTo-Json -Depth 30
}
catch {
    Write-Error "Kimi WebBridge call failed: $($_.Exception.Message)"
    exit 1
}
