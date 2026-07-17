[CmdletBinding()]
param(
    [string]$PolicyPath = "verification-policy.json",
    [string]$ReceiptPath = ".verification/receipt.json",
    [string]$EvidencePath = ".verification/evidence.json",
    [ValidateSet("local", "ci")]
    [string]$Mode = "local",
    [ValidateSet("R0", "R1", "R2", "R3")]
    [string]$RiskOverride,
    [switch]$PlanOnly,
    [switch]$CheckReceipt
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Resolve-RepoRoot {
    $root = (& git -C (Get-Location).Path rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $root) {
        throw "verify-change requires a Git repository."
    }
    return [IO.Path]::GetFullPath(($root | Select-Object -First 1))
}

function Resolve-RepoPath {
    param([string]$Root, [string]$Value)
    if ([IO.Path]::IsPathRooted($Value)) {
        return [IO.Path]::GetFullPath($Value)
    }
    return [IO.Path]::GetFullPath((Join-Path $Root $Value))
}

function Get-ChangedFiles {
    param([string]$Root)
    $items = [Collections.Generic.List[string]]::new()
    $tracked = @(& git -C $Root diff --name-only --diff-filter=ACMRTUXB HEAD -- 2>$null)
    if ($LASTEXITCODE -ne 0) {
        $tracked = @(& git -C $Root diff --name-only --diff-filter=ACMRTUXB -- 2>$null)
    }
    $untracked = @(& git -C $Root ls-files --others --exclude-standard 2>$null)
    foreach ($item in @($tracked) + @($untracked)) {
        if (-not $item) { continue }
        $normalized = ([string]$item).Trim().Replace("\", "/")
        if ($normalized -match "^(\.verification|artifacts/verification)/") { continue }
        if (-not $items.Contains($normalized)) { $items.Add($normalized) }
    }
    return @($items | Sort-Object)
}

function Get-TextSha256 {
    param([string]$Value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-WorkspaceFingerprint {
    param([string]$Root, [string[]]$ChangedFiles)
    $parts = foreach ($relative in $ChangedFiles) {
        $full = Resolve-RepoPath -Root $Root -Value $relative
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $hash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
            "$relative`t$hash"
        }
        else {
            "$relative`t<deleted>"
        }
    }
    return Get-TextSha256 -Value (($parts | Sort-Object) -join "`n")
}

function Get-Plan {
    param(
        [object]$Policy,
        [string[]]$ChangedFiles,
        [string]$Mode,
        [string]$RiskOverride
    )
    $risk = "R0"
    $laneNames = [Collections.Generic.List[string]]::new()

    foreach ($file in $ChangedFiles) {
        $matched = $false
        foreach ($route in @($Policy.routes)) {
            $routeMatched = $false
            foreach ($pattern in @($route.patterns)) {
                if ($file -match $pattern) {
                    $routeMatched = $true
                    break
                }
            }
            if (-not $routeMatched) { continue }
            $matched = $true
            if ([int]$Policy.riskOrder.($route.risk) -gt [int]$Policy.riskOrder.($risk)) {
                $risk = $route.risk
            }
            foreach ($lane in @($route.addLanes)) {
                if (-not $laneNames.Contains([string]$lane)) { $laneNames.Add([string]$lane) }
            }
        }
        if (-not $matched -and [int]$Policy.riskOrder.($Policy.defaultRisk) -gt [int]$Policy.riskOrder.($risk)) {
            $risk = $Policy.defaultRisk
        }
    }

    if ($RiskOverride) { $risk = $RiskOverride }
    $orderedLaneNames = [Collections.Generic.List[string]]::new()
    foreach ($lane in @($Policy.baseLanes.($risk))) {
        if (-not $orderedLaneNames.Contains([string]$lane)) { $orderedLaneNames.Add([string]$lane) }
    }
    foreach ($lane in $laneNames) {
        if (-not $orderedLaneNames.Contains([string]$lane)) { $orderedLaneNames.Add([string]$lane) }
    }

    $selected = [Collections.Generic.List[string]]::new()
    foreach ($lane in $orderedLaneNames) {
        $definition = $Policy.lanes.($lane)
        if (-not $definition) { throw "Unknown lane in policy: $lane" }
        if (@($definition.modes) -contains $Mode) { $selected.Add($lane) }
    }
    return [ordered]@{ risk = $risk; lanes = @($selected) }
}

function Get-NpmScripts {
    param([string]$Root)
    $scripts = @{}
    $packagePath = Join-Path $Root "package.json"
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { return $scripts }
    $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 50
    if ($package.scripts) {
        foreach ($property in $package.scripts.PSObject.Properties) {
            $scripts[$property.Name] = $true
        }
    }
    return $scripts
}

function Test-EvidenceLane {
    param(
        [object]$Definition,
        [object]$Evidence,
        [string]$Fingerprint,
        [string]$Root
    )
    if (-not $Evidence) { return [ordered]@{ status = "fail"; reason = "evidence file missing" } }
    if ($Evidence.fingerprint -ne $Fingerprint) {
        return [ordered]@{ status = "fail"; reason = "evidence fingerprint is stale" }
    }
    $property = $Evidence.lanes.PSObject.Properties[$Definition.evidenceKey]
    if (-not $property -or $property.Value.status -ne "pass") {
        return [ordered]@{ status = "fail"; reason = "required evidence lane did not pass" }
    }
    $artifact = [string]$property.Value.artifact
    if (-not $artifact) { return [ordered]@{ status = "fail"; reason = "evidence artifact path missing" } }
    $artifactPath = Resolve-RepoPath -Root $Root -Value $artifact
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
        return [ordered]@{ status = "fail"; reason = "evidence artifact does not exist" }
    }
    return [ordered]@{ status = "pass"; artifact = $artifact }
}

$root = Resolve-RepoRoot
Set-Location -LiteralPath $root
$resolvedPolicyPath = Resolve-RepoPath -Root $root -Value $PolicyPath
$resolvedReceiptPath = Resolve-RepoPath -Root $root -Value $ReceiptPath
$resolvedEvidencePath = Resolve-RepoPath -Root $root -Value $EvidencePath

if (-not (Test-Path -LiteralPath $resolvedPolicyPath -PathType Leaf)) {
    throw "Verification policy not found: $resolvedPolicyPath"
}

$policy = Get-Content -LiteralPath $resolvedPolicyPath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100
$changedFiles = @(Get-ChangedFiles -Root $root)
$fingerprint = Get-WorkspaceFingerprint -Root $root -ChangedFiles $changedFiles
$plan = Get-Plan -Policy $policy -ChangedFiles $changedFiles -Mode $Mode -RiskOverride $RiskOverride

if ($PlanOnly) {
    [ordered]@{
        policyVersion = $policy.version
        mode = $Mode
        fingerprint = $fingerprint
        changedFiles = $changedFiles
        risk = $plan.risk
        requiredLanes = $plan.lanes
    } | ConvertTo-Json -Depth 20
    exit 0
}

if ($CheckReceipt) {
    if (-not (Test-Path -LiteralPath $resolvedReceiptPath -PathType Leaf)) {
        Write-Error "Verification receipt is missing."
        exit 2
    }
    $receipt = Get-Content -LiteralPath $resolvedReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100
    $expectedLanes = @($plan.lanes | Sort-Object)
    $receiptLanes = @($receipt.requiredLanes | Sort-Object)
    $lanesMatch = (($expectedLanes -join "|") -eq ($receiptLanes -join "|"))
    if ($receipt.status -ne "pass" -or $receipt.mode -ne $Mode -or
        $receipt.policyVersion -ne $policy.version -or $receipt.fingerprint -ne $fingerprint -or
        $receipt.risk -ne $plan.risk -or -not $lanesMatch) {
        Write-Error "Verification receipt is failed, stale, or does not cover the current risk lanes."
        exit 2
    }
    Write-Output "Verification receipt is current."
    exit 0
}

$startedAt = (Get-Date).ToString("o")
$npmScripts = Get-NpmScripts -Root $root
$evidence = $null
if (Test-Path -LiteralPath $resolvedEvidencePath -PathType Leaf) {
    $evidence = Get-Content -LiteralPath $resolvedEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100
}
$results = [Collections.Generic.List[object]]::new()
$failed = $false

foreach ($laneName in $plan.lanes) {
    $definition = $policy.lanes.($laneName)
    if ($definition.kind -eq "evidence") {
        $laneResult = Test-EvidenceLane -Definition $definition -Evidence $evidence -Fingerprint $fingerprint -Root $root
        if ($laneResult.status -ne "pass") { $failed = $true }
        $results.Add([ordered]@{ lane = $laneName; kind = "evidence"; status = $laneResult.status; detail = $laneResult })
        continue
    }

    $executed = 0
    $laneFailed = $false
    foreach ($command in @($definition.commands)) {
        if ($command.npmScript -and -not $npmScripts.ContainsKey([string]$command.npmScript)) {
            $results.Add([ordered]@{ lane = $laneName; command = $command.id; status = "skipped"; reason = "npm script missing" })
            continue
        }
        $resolvedProgram = Get-Command -Name $command.program -ErrorAction SilentlyContinue
        if (-not $resolvedProgram) {
            $status = if ($command.required) { "fail" } else { "skipped" }
            $results.Add([ordered]@{ lane = $laneName; command = $command.id; status = $status; reason = "program missing" })
            if ($command.required) { $laneFailed = $true }
            continue
        }
        $executed++
        Write-Host "[$laneName] $($command.id)"
        $program = [string]$command.program
        $arguments = @($command.args | ForEach-Object { [string]$_ })
        & $program @arguments
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        $status = if ($exitCode -eq 0) { "pass" } else { "fail" }
        if ($exitCode -ne 0) { $laneFailed = $true }
        $results.Add([ordered]@{ lane = $laneName; command = $command.id; status = $status; exitCode = $exitCode })
    }
    if ($executed -lt [int]$definition.minExecuted) {
        $laneFailed = $true
        $results.Add([ordered]@{ lane = $laneName; status = "fail"; reason = "lane executed $executed command(s), requires $($definition.minExecuted)" })
    }
    if ($laneFailed) { $failed = $true }
}

$finalChangedFiles = @(Get-ChangedFiles -Root $root)
$finalFingerprint = Get-WorkspaceFingerprint -Root $root -ChangedFiles $finalChangedFiles
if ($finalFingerprint -ne $fingerprint) {
    $failed = $true
    $results.Add([ordered]@{ lane = "freshness"; status = "fail"; reason = "workspace changed during verification" })
}

$receipt = [ordered]@{
    version = 1
    policyVersion = $policy.version
    mode = $Mode
    status = if ($failed) { "fail" } else { "pass" }
    risk = $plan.risk
    fingerprint = $finalFingerprint
    changedFiles = $finalChangedFiles
    requiredLanes = $plan.lanes
    startedAt = $startedAt
    completedAt = (Get-Date).ToString("o")
    results = @($results)
}

$receiptDirectory = Split-Path -Parent $resolvedReceiptPath
New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null
[IO.File]::WriteAllText(
    $resolvedReceiptPath,
    ($receipt | ConvertTo-Json -Depth 30),
    [Text.UTF8Encoding]::new($false)
)

if ($failed) {
    Write-Error "Verification failed. See $resolvedReceiptPath"
    exit 1
}

if ($Mode -eq "local") {
    $dirtyPath = Join-Path $root ".verification/dirty.json"
    if (Test-Path -LiteralPath $dirtyPath) { Remove-Item -LiteralPath $dirtyPath -Force }
}
Write-Output "Verification passed: $resolvedReceiptPath"
exit 0
