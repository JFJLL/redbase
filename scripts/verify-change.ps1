[CmdletBinding()]
param(
    [string]$PolicyPath = "verification-policy.json",
    [string]$ReceiptPath = ".verification/receipt.json",
    [string]$EvidencePath = ".verification/evidence.json",
    [ValidateSet("local", "ci", "release")]
    [string]$Mode = "local",
    [ValidateSet("R0", "R1", "R2", "R3")]
    [string]$RiskFloor,
    [string]$BaseRefOverride,
    [switch]$PlanOnly,
    [switch]$CheckReceipt,
    [switch]$InitEvidence
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

function Get-Sha256Text {
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

function Get-FileSha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "<missing>" }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ExcludePatterns {
    param([object]$Policy)
    $patterns = [Collections.Generic.List[string]]::new()
    foreach ($p in @("^\.verification/", "^artifacts/verification/", "(^|/)node_modules/", "\.db$", "\.db-shm$", "\.db-wal$", "(^|/)dist/", "\.exe$")) {
        $patterns.Add($p)
    }
    if ($Policy -and $Policy.changeScope -and $Policy.changeScope.excludePaths) {
        foreach ($p in @($Policy.changeScope.excludePaths)) {
            if (-not $patterns.Contains([string]$p)) { $patterns.Add([string]$p) }
        }
    }
    return @($patterns)
}

function Test-Excluded {
    param([string]$Path, [string[]]$Patterns)
    foreach ($p in $Patterns) {
        if ($Path -match $p) { return $true }
    }
    return $false
}

function Get-BaseRefInfo {
    param([string]$Root, [object]$Policy, [string]$BaseRefOverride)
    $baseRef = ""
    if ($BaseRefOverride) {
        $baseRef = $BaseRefOverride
    }
    elseif ($Policy -and $Policy.changeScope -and $Policy.changeScope.baseRef) {
        $baseRef = [string]$Policy.changeScope.baseRef
    }
    if (-not $baseRef) { $baseRef = "origin/main" }

    $candidates = @($baseRef, "origin/master", "main", "master")
    $baseSha = ""
    foreach ($candidate in $candidates) {
        $trySha = (& git -C $Root rev-parse --verify "$candidate" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $trySha) {
            $baseRef = $candidate
            $baseSha = [string]$trySha
            break
        }
    }
    if (-not $baseSha) {
        throw "Cannot resolve base ref '$baseRef' (tried origin/main, origin/master, main, master). Run 'git fetch' or set changeScope.baseRef in the policy."
    }
    $baseSha = $baseSha.Trim()
    $mergeBase = (& git -C $Root merge-base "$baseSha" HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $mergeBase) {
        throw "Cannot compute merge-base between $baseRef and HEAD. The repository may need 'git fetch --unshallow' or a deeper clone."
    }
    return [ordered]@{ baseRef = $baseRef; baseSha = ([string]$mergeBase).Trim() }
}

function Get-ChangeSet {
    param([string]$Root, [string]$BaseSha, [object]$Policy)
    $excludes = Get-ExcludePatterns -Policy $Policy
    $items = [Collections.Generic.List[object]]::new()

    function Add-Item {
        param([string]$Path, [string]$Status, [string]$OldPath)
        $normalized = ([string]$Path).Trim().Replace("\", "/")
        if (-not $normalized) { return }
        if (Test-Excluded -Path $normalized -Patterns $excludes) { return }
        $statusMap = @{ "A" = "added"; "M" = "modified"; "D" = "deleted"; "R" = "renamed"; "U" = "updated"; "T" = "typechange" }
        $semantic = $Status
        if ($statusMap.ContainsKey($Status)) { $semantic = $statusMap[$Status] }
        $obj = [ordered]@{ path = $normalized; status = $semantic }
        if ($OldPath) {
            $old = ([string]$OldPath).Trim().Replace("\", "/")
            if (-not (Test-Excluded -Path $old -Patterns $excludes)) {
                $obj.oldPath = $old
            }
        }
        $items.Add([pscustomobject]$obj)
    }

    # 1) committed changes: base...HEAD
    $committed = @(& git -C $Root diff --name-status "$BaseSha" HEAD -- 2>$null)
    if ($LASTEXITCODE -eq 0) {
        foreach ($line in $committed) {
            if ($line -match "^([AMDRTUXB])\d*\s+(.+)$") {
                $status = $Matches[1]
                $rest = $Matches[2].Trim()
                if ($status -eq "R" -and $rest -match "^(.+?)\s+(.+)$") {
                    Add-Item -Path $Matches[2] -Status "renamed" -OldPath $Matches[1]
                }
                else {
                    Add-Item -Path $rest -Status $status
                }
            }
        }
    }

    # 2) working tree changes vs HEAD
    $working = @(& git -C $Root diff --name-status HEAD -- 2>$null)
    if ($LASTEXITCODE -eq 0) {
        foreach ($line in $working) {
            if ($line -match "^([AMDRTUXB])\d*\s+(.+)$") {
                $status = $Matches[1]
                $rest = $Matches[2].Trim()
                if ($status -eq "R" -and $rest -match "^(.+?)\s+(.+)$") {
                    Add-Item -Path $Matches[2] -Status "renamed" -OldPath $Matches[1]
                }
                else {
                    Add-Item -Path $rest -Status $status
                }
            }
        }
    }

    # 3) untracked
    $includeUntracked = $true
    if ($Policy -and $Policy.changeScope -and $Policy.changeScope.includeUntracked -ne $null) {
        $includeUntracked = [bool]$Policy.changeScope.includeUntracked
    }
    if ($includeUntracked) {
        $untracked = @(& git -C $Root ls-files --others --exclude-standard 2>$null)
        foreach ($u in $untracked) {
            Add-Item -Path ([string]$u) -Status "untracked"
        }
    }

    $seen = [Collections.Generic.HashSet[string]]::new()
    $unique = [Collections.Generic.List[object]]::new()
    foreach ($item in $items) {
        $key = $item.path + "|" + $item.status + "|" + $item.oldPath
        if ($seen.Add($key)) { $unique.Add($item) }
    }
    return @($unique | Sort-Object path)
}

function Get-ChangeSetHash {
    param([string]$Root, [string]$BaseSha, [object[]]$ChangeSet)
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add("BASE " + $BaseSha)
    foreach ($item in $ChangeSet) {
        $full = Resolve-RepoPath -Root $Root -Value $item.path
        $hash = Get-FileSha256 -Path $full
        if ($item.status -eq "deleted") { $hash = "<deleted>" }
        $prefix = $item.status
        if ($item.oldPath) { $prefix += " " + $item.oldPath }
        $lines.Add(($prefix + " " + $item.path + " " + $hash))
    }
    return Get-Sha256Text -Value (($lines | Sort-Object) -join "`n")
}

function Test-RouteMatch {
    param([object]$Route, [string]$File, [string]$OldPath)
    $matched = $false
    if ($Route.includeAny -or $Route.includeAll -or $Route.patterns) {
        if ($Route.includeAny) {
            foreach ($p in @($Route.includeAny)) { if ($File -match $p) { $matched = $true; break } }
            if (-not $matched) { return $false }
        }
        if ($Route.includeAll) {
            foreach ($p in @($Route.includeAll)) { if ($File -notmatch $p) { return $false } }
            $matched = $true
        }
        if ($Route.patterns) {
            $any = $false
            foreach ($p in @($Route.patterns)) { if ($File -match $p) { $any = $true; break } }
            if (-not $any) { return $false }
            $matched = $true
        }
    }
    else {
        return $false
    }
    if ($Route.exclude) {
        foreach ($p in @($Route.exclude)) {
            if ($File -match $p) { return $false }
            if ($OldPath -and $OldPath -match $p) { return $false }
        }
    }
    return $matched
}

function Get-Plan {
    param(
        [object]$Policy,
        [object[]]$ChangeSet,
        [string]$Mode,
        [string]$RiskFloor
    )
    $defaultRisk = [string]$Policy.defaultRisk
    $risk = "R0"
    $routeHits = [Collections.Generic.List[object]]::new()
    $laneNames = [Collections.Generic.List[string]]::new()
    $evidenceCases = [Collections.Generic.List[string]]::new()

    foreach ($item in $ChangeSet) {
        $file = [string]$item.path
        $oldPath = if ($item.oldPath) { [string]$item.oldPath } else { "" }
        $fileRisk = $null
        foreach ($route in @($Policy.routes)) {
            $routeMatched = Test-RouteMatch -Route $route -File $file -OldPath $oldPath
            if (-not $routeMatched) { continue }
            $riskValue = [int]$Policy.riskOrder.([string]$route.risk)
            if ($null -eq $fileRisk -or $riskValue -gt [int]$Policy.riskOrder.([string]$fileRisk)) {
                $fileRisk = [string]$route.risk
            }
            $routeHits.Add([ordered]@{
                file = $file
                route = [string]$route.id
                risk = [string]$route.risk
                addedLanes = @($route.addLanes)
            })
            foreach ($lane in @($route.addLanes)) {
                if (-not $laneNames.Contains([string]$lane)) { $laneNames.Add([string]$lane) }
            }
            foreach ($case in @($route.evidenceCases)) {
                if (-not $evidenceCases.Contains([string]$case)) { $evidenceCases.Add([string]$case) }
            }
        }
        if ($null -eq $fileRisk) {
            $fileRisk = $defaultRisk
        }
        if ([int]$Policy.riskOrder.([string]$fileRisk) -gt [int]$Policy.riskOrder.($risk)) {
            $risk = [string]$fileRisk
        }
    }

    $computedRisk = $risk
    if ($RiskFloor) {
        if ([int]$Policy.riskOrder.($RiskFloor) -gt [int]$Policy.riskOrder.($risk)) {
            $risk = $RiskFloor
        }
    }

    $orderedLanes = [Collections.Generic.List[string]]::new()
    foreach ($lane in @($Policy.baseLanes.($risk))) {
        if (-not $orderedLanes.Contains([string]$lane)) { $orderedLanes.Add([string]$lane) }
    }
    foreach ($lane in $laneNames) {
        if (-not $orderedLanes.Contains([string]$lane)) { $orderedLanes.Add([string]$lane) }
    }

    $selected = [Collections.Generic.List[string]]::new()
    foreach ($lane in $orderedLanes) {
        $definition = $Policy.lanes.($lane)
        if (-not $definition) { throw "Unknown lane in policy: $lane" }
        if (@($definition.modes) -contains $Mode -or -not $definition.modes) { $selected.Add($lane) }
    }

    $laneReasons = [ordered]@{}
    foreach ($lane in $selected) {
        $reason = "base lane for $risk"
        foreach ($hit in $routeHits) {
            if (@($hit.addedLanes) -contains $lane) {
                $reason = ([string]$hit.route) + " (file: " + ([string]$hit.file) + ")"
                break
            }
        }
        $laneReasons[$lane] = $reason
    }

    return [ordered]@{
        risk = $risk
        computedRisk = $computedRisk
        riskFloor = if ($RiskFloor) { $RiskFloor } else { $null }
        lanes = @($selected)
        laneReasons = $laneReasons
        routeHits = @($routeHits)
        evidenceCases = @($evidenceCases)
    }
}

function Get-PolicyHash {
    param([string]$Path)
    return Get-FileSha256 -Path $Path
}

function Get-RunnerHash {
    param([string]$Path)
    return Get-FileSha256 -Path $Path
}

function Get-NpmScripts {
    param([string]$Root, [string]$Cwd)
    $scripts = @{}
    $packagePath = Join-Path (Resolve-RepoPath -Root $Root -Value $Cwd) "package.json"
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { return $scripts }
    $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 50
    if ($package.scripts) {
        foreach ($property in $package.scripts.PSObject.Properties) {
            $scripts[$property.Name] = $true
        }
    }
    return $scripts
}

function Test-AgentReviewFile {
    param([string]$ArtifactPath, [string]$ChangeSetHash)
    try {
        $review = Get-Content -LiteralPath $ArtifactPath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100
    }
    catch {
        return [ordered]@{ status = "fail"; reason = "agent-review artifact is not valid JSON" }
    }
    if (-not $review.changeSetHash -or $review.changeSetHash -ne $ChangeSetHash) {
        return [ordered]@{ status = "fail"; reason = "agent-review changeSetHash is stale" }
    }
    if (-not $review.reviewer) {
        return [ordered]@{ status = "fail"; reason = "agent-review missing reviewer block" }
    }
    if ($review.reviewer.freshContext -ne $true) {
        return [ordered]@{ status = "fail"; reason = "agent-review reviewer must be fresh-context (freshContext=true)" }
    }
    if ($review.reviewer.implementedFix -eq $true) {
        return [ordered]@{ status = "fail"; reason = "agent-review reviewer must not have implemented the fix (implementedFix=false)" }
    }
    if ([int]$review.reviewRounds -gt 3) {
        return [ordered]@{ status = "fail"; reason = "review rounds exceeded the 3-round convergence limit; escalate to the user" }
    }
    if (-not $review.verdict -or $review.verdict -ne "pass") {
        return [ordered]@{ status = "fail"; reason = "agent-review verdict must be pass" }
    }
    foreach ($finding in @($review.findings)) {
        $severity = [string]$finding.severity
        $status = [string]$finding.status
        if (($severity -eq "high" -or $severity -eq "critical") -and $status -eq "open") {
            return [ordered]@{ status = "fail"; reason = "open high/critical finding blocks pass: " + $finding.id }
        }
    }
    return [ordered]@{ status = "pass" }
}

function Test-EvidenceLane {
    param(
        [object]$Definition,
        [object]$Evidence,
        [string]$ChangeSetHash,
        [string]$Root
    )
    if (-not $Evidence) { return [ordered]@{ status = "fail"; reason = "evidence file missing" } }
    if ($Evidence.changeSetHash -ne $ChangeSetHash) {
        return [ordered]@{ status = "fail"; reason = "evidence changeSetHash is stale" }
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

    $artifactHash = Get-FileSha256 -Path $artifactPath
    $key = [string]$Definition.evidenceKey
    if ($key -eq "agent-review") {
        $reviewResult = Test-AgentReviewFile -ArtifactPath $artifactPath -ChangeSetHash $ChangeSetHash
        if ($reviewResult.status -ne "pass") { return $reviewResult }
    }
    else {
        $content = Get-Content -LiteralPath $artifactPath -Raw -Encoding UTF8
        if (-not $content.Contains($ChangeSetHash)) {
            return [ordered]@{ status = "fail"; reason = "artifact does not carry the current changeSetHash" }
        }
        if ($content -match "(?im)^\s*-?\s*(Overall|Result|Verdict)\s*:\s*.*\b(fail|blocked|pending)\b") {
            return [ordered]@{ status = "fail"; reason = "artifact contains failing, blocked, or pending cases" }
        }
        if ($content.Length -lt 300) {
            return [ordered]@{ status = "fail"; reason = "artifact too thin to constitute evidence" }
        }
    }
    return [ordered]@{ status = "pass"; artifact = $artifact; artifactSha256 = $artifactHash }
}

function Invoke-CommandLane {
    param(
        [object]$Definition,
        [object]$Policy,
        [string]$Root,
        [object]$NpmScriptCache
    )
    $executed = 0
    $laneFailed = $false
    $capabilityGaps = [Collections.Generic.List[string]]::new()
    $results = [Collections.Generic.List[object]]::new()

    foreach ($command in @($definition.commands)) {
        $cwd = "."
        if ($command.cwd) { $cwd = [string]$command.cwd }
        $isHygiene = [bool]$command.hygiene
        $cacheKey = $Root + "|" + $cwd
        $npmScripts = $NpmScriptCache[$cacheKey]
        if ($null -eq $npmScripts) {
            $npmScripts = Get-NpmScripts -Root $Root -Cwd $cwd
            $NpmScriptCache[$cacheKey] = $npmScripts
        }

        if ($command.npmScript -and -not $npmScripts.ContainsKey([string]$command.npmScript)) {
            $capabilityGaps.Add([string]$command.id + " (npm script '" + $command.npmScript + "' missing)")
            $results.Add([ordered]@{ lane = $definition.id; command = $command.id; status = "skipped"; reason = "npm script missing"; hygiene = $isHygiene })
            continue
        }

        $program = [string]$command.program
        $resolvedProgram = Get-Command -Name $program -ErrorAction SilentlyContinue
        if (-not $resolvedProgram) {
            $results.Add([ordered]@{ lane = $definition.id; command = $command.id; status = "skipped"; reason = "program missing"; hygiene = $isHygiene })
            $capabilityGaps.Add([string]$command.id + " (program '" + $program + "' missing)")
            if ($command.required) { $laneFailed = $true }
            continue
        }

        $arguments = @($command.args | ForEach-Object { [string]$_ })
        Write-Host ("[" + $definition.id + "] " + $command.id)
        $targetDir = Resolve-RepoPath -Root $Root -Value $cwd
        Push-Location -LiteralPath $targetDir
        try {
            & $resolvedProgram.Source @arguments
            $exitCode = $LASTEXITCODE
            if ($null -eq $exitCode) { $exitCode = 0 }
        }
        catch {
            $exitCode = 1
        }
        finally {
            Pop-Location
        }
        $status = if ($exitCode -eq 0) { "pass" } else { "fail" }
        if ($exitCode -ne 0) { $laneFailed = $true }
        if (-not $isHygiene) { $executed++ }
        $results.Add([ordered]@{ lane = $definition.id; command = $command.id; status = $status; exitCode = $exitCode; hygiene = $isHygiene })
    }

    $minExecuted = [int]$definition.minExecuted
    if ($minExecuted -gt 0 -and $executed -lt $minExecuted) {
        $laneFailed = $true
        $results.Add([ordered]@{ lane = $definition.id; status = "fail"; reason = "lane executed $executed non-hygiene command(s), requires $minExecuted; missing: $($capabilityGaps -join '; ')" })
    }
    return [ordered]@{ failed = $laneFailed; results = @($results); gaps = @($capabilityGaps) }
}

$root = Resolve-RepoRoot
Set-Location -LiteralPath $root
$resolvedPolicyPath = Resolve-RepoPath -Root $root -Value $PolicyPath
$resolvedReceiptPath = Resolve-RepoPath -Root $root -Value $ReceiptPath
$resolvedEvidencePath = Resolve-RepoPath -Root $root -Value $EvidencePath
$runnerHash = Get-RunnerHash -Path $MyInvocation.MyCommand.Path

if (-not (Test-Path -LiteralPath $resolvedPolicyPath -PathType Leaf)) {
    throw "Verification policy not found: $resolvedPolicyPath"
}

$policy = Get-Content -LiteralPath $resolvedPolicyPath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100
$policyHash = Get-PolicyHash -Path $resolvedPolicyPath
$baseInfo = Get-BaseRefInfo -Root $root -Policy $policy -BaseRefOverride $BaseRefOverride
$changeSet = @(Get-ChangeSet -Root $root -BaseSha $baseInfo.baseSha -Policy $policy)
$changeSetHash = Get-ChangeSetHash -Root $root -BaseSha $baseInfo.baseSha -ChangeSet $changeSet
$plan = Get-Plan -Policy $policy -ChangeSet $changeSet -Mode $Mode -RiskFloor $RiskFloor

if ($PlanOnly) {
    $filesOut = foreach ($item in $changeSet) {
        $matchedRoutes = @()
        foreach ($hit in $plan.routeHits) {
            if ($hit.file -eq $item.path) {
                $matchedRoutes += [ordered]@{
                    id = $hit.route
                    risk = $hit.risk
                    addedLanes = $hit.addedLanes
                }
            }
        }
        [ordered]@{
            path = $item.path
            status = $item.status
            oldPath = if ($item.oldPath) { $item.oldPath } else { $null }
            matchedRoutes = $matchedRoutes
        }
    }
    $lanesOut = foreach ($lane in $plan.lanes) {
        [ordered]@{ lane = $lane; reason = $plan.laneReasons[$lane] }
    }
    [ordered]@{
        schemaVersion = 2
        mode = $Mode
        baseRef = $baseInfo.baseRef
        baseSha = $baseInfo.baseSha
        changeSetHash = $changeSetHash
        files = @($filesOut)
        risk = $plan.risk
        computedRisk = $plan.computedRisk
        riskFloor = $plan.riskFloor
        requiredLanes = @($lanesOut)
        evidenceCases = $plan.evidenceCases
        changedFilesCount = $changeSet.Count
    } | ConvertTo-Json -Depth 30
    exit 0
}

if ($CheckReceipt) {
    if (-not (Test-Path -LiteralPath $resolvedReceiptPath -PathType Leaf)) {
        [Console]::Error.WriteLine("Verification receipt is missing.")
        exit 2
    }
    $receipt = Get-Content -LiteralPath $resolvedReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100
    $expectedLanes = @($plan.lanes | Sort-Object)
    $receiptLanes = @($receipt.requiredLanes | Sort-Object)
    $lanesMatch = (($expectedLanes -join "|") -eq ($receiptLanes -join "|"))

    $receiptOk = $true
    $receiptFailReason = ""
    if ($receipt.schemaVersion -ne 2) { $receiptOk = $false; $receiptFailReason = "receipt schemaVersion is not 2 (v1 receipts are stale by design)" }
    elseif ($receipt.status -ne "pass") { $receiptOk = $false; $receiptFailReason = "receipt status is not pass" }
    elseif ($receipt.mode -ne $Mode) { $receiptOk = $false; $receiptFailReason = "receipt mode does not match" }
    elseif ($receipt.changeSetHash -ne $changeSetHash) { $receiptOk = $false; $receiptFailReason = "receipt changeSetHash is stale" }
    elseif ($receipt.risk -ne $plan.risk) { $receiptOk = $false; $receiptFailReason = "receipt risk does not match" }
    elseif (-not $lanesMatch) { $receiptOk = $false; $receiptFailReason = "receipt lanes do not cover the current plan" }
    elseif ($receipt.policy.version -ne $policy.version -or $receipt.policy.sha256 -ne $policyHash) { $receiptOk = $false; $receiptFailReason = "receipt policy binding is stale" }
    elseif ($receipt.runner.sha256 -ne $runnerHash) { $receiptOk = $false; $receiptFailReason = "receipt runner binding is stale" }
    else {
        foreach ($laneName in $plan.lanes) {
            $definition = $policy.lanes.($laneName)
            if ($definition.kind -eq "evidence") {
                $ev = $receipt.evidence.PSObject.Properties[$definition.evidenceKey]
                if (-not $ev) { $receiptOk = $false; $receiptFailReason = "receipt missing evidence for $laneName"; break }
                $artifactPath = Resolve-RepoPath -Root $root -Value ([string]$ev.Value.artifact)
                if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
                    $receiptOk = $false; $receiptFailReason = "evidence artifact for $laneName was deleted"; break
                }
                $currentHash = Get-FileSha256 -Path $artifactPath
                if ($currentHash -ne [string]$ev.Value.sha256) {
                    $receiptOk = $false; $receiptFailReason = "evidence artifact for $laneName was modified"; break
                }
            }
        }
    }

    if (-not $receiptOk) {
        [Console]::Error.WriteLine("Verification receipt is failed, stale, or does not cover the current risk lanes. Reason: $receiptFailReason")
        exit 2
    }
    Write-Output "Verification receipt is current."
    exit 0
}

if ($InitEvidence) {
    $evidence = [ordered]@{
        schemaVersion = 2
        changeSetHash = $changeSetHash
        baseRef = $baseInfo.baseRef
        baseSha = $baseInfo.baseSha
        lanes = [ordered]@{}
    }
    foreach ($laneName in $plan.lanes) {
        $definition = $policy.lanes.($laneName)
        if ($definition.kind -ne "evidence") { continue }
        $defaultArtifact = "artifacts/verification/" + $definition.evidenceKey + ".md"
        if ($definition.evidenceKey -eq "agent-review") { $defaultArtifact = "artifacts/verification/agent-review.json" }
        $evidence.lanes[$definition.evidenceKey] = [ordered]@{
            status = "pending"
            artifact = $defaultArtifact
        }
    }
    $evidenceDir = Split-Path -Parent $resolvedEvidencePath
    New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
    [IO.File]::WriteAllText(
        $resolvedEvidencePath,
        ($evidence | ConvertTo-Json -Depth 20),
        [Text.UTF8Encoding]::new($false)
    )
    Write-Output "Initialized evidence: $resolvedEvidencePath"
    Write-Output "Required evidence lanes: $($plan.lanes | Where-Object { $policy.lanes.($_).kind -eq 'evidence' } | Join-String -Separator ', ')"
    exit 0
}

if ($changeSet.Count -eq 0) {
    [Console]::Error.WriteLine("Nothing to verify: no changes vs base '$($baseInfo.baseRef)' or the working tree. Refusing to issue a receipt.")
    exit 3
}

$startedAt = (Get-Date).ToString("o")
$npmCache = @{}
$evidence = $null
if (Test-Path -LiteralPath $resolvedEvidencePath -PathType Leaf) {
    $evidence = Get-Content -LiteralPath $resolvedEvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 100
}
$results = [Collections.Generic.List[object]]::new()
$failed = $false
$capabilityGaps = [Collections.Generic.List[string]]::new()

foreach ($laneName in $plan.lanes) {
    $definition = $policy.lanes.($laneName)
    if ($definition.kind -eq "evidence") {
        $laneResult = Test-EvidenceLane -Definition $definition -Evidence $evidence -ChangeSetHash $changeSetHash -Root $root
        if ($laneResult.status -ne "pass") { $failed = $true }
        $results.Add([ordered]@{ lane = $laneName; kind = "evidence"; status = $laneResult.status; detail = $laneResult })
        continue
    }
    $definition = [pscustomobject]@{ id = $laneName; commands = $definition.commands; minExecuted = $definition.minExecuted }
    $laneOutcome = Invoke-CommandLane -Definition $definition -Policy $policy -Root $root -NpmScriptCache $npmCache
    foreach ($r in $laneOutcome.results) { $results.Add($r) }
    foreach ($g in $laneOutcome.gaps) { $capabilityGaps.Add($g) }
    if ($laneOutcome.failed) { $failed = $true }
}

$finalChangeSet = @(Get-ChangeSet -Root $root -BaseSha $baseInfo.baseSha -Policy $policy)
$finalChangeSetHash = Get-ChangeSetHash -Root $root -BaseSha $baseInfo.baseSha -ChangeSet $finalChangeSet
if ($finalChangeSetHash -ne $changeSetHash) {
    $failed = $true
    $results.Add([ordered]@{ lane = "freshness"; status = "fail"; reason = "workspace changed during verification" })
}

$evidenceBlock = [ordered]@{}
foreach ($laneName in $plan.lanes) {
    $definition = $policy.lanes.($laneName)
    if ($definition.kind -ne "evidence") { continue }
    $r = $results | Where-Object { $_.lane -eq $laneName -and $_.kind -eq "evidence" } | Select-Object -First 1
    if ($r -and $r.detail.status -eq "pass") {
        $evidenceBlock[$definition.evidenceKey] = [ordered]@{
            artifact = $r.detail.artifact
            sha256 = $r.detail.artifactSha256
        }
    }
}

$receipt = [ordered]@{
    schemaVersion = 2
    version = 1
    mode = $Mode
    status = if ($failed) { "fail" } else { "pass" }
    baseRef = $baseInfo.baseRef
    baseSha = $baseInfo.baseSha
    changeSetHash = $finalChangeSetHash
    policy = [ordered]@{ version = $policy.version; sha256 = $policyHash }
    runner = [ordered]@{ sha256 = $runnerHash }
    risk = $plan.risk
    computedRisk = $plan.computedRisk
    riskFloor = $plan.riskFloor
    requiredLanes = $plan.lanes
    evidence = $evidenceBlock
    capabilityGaps = @($capabilityGaps | Sort-Object -Unique)
    startedAt = $startedAt
    completedAt = (Get-Date).ToString("o")
    results = @($results)
}

$receiptDirectory = Split-Path -Parent $resolvedReceiptPath
New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null
[IO.File]::WriteAllText(
    $resolvedReceiptPath,
    ($receipt | ConvertTo-Json -Depth 40),
    [Text.UTF8Encoding]::new($false)
)

if ($failed) {
    [Console]::Error.WriteLine("Verification failed. See $resolvedReceiptPath")
    exit 1
}

if ($Mode -eq "local") {
    $dirtyPath = Join-Path $root ".verification/dirty.json"
    if (Test-Path -LiteralPath $dirtyPath) { Remove-Item -LiteralPath $dirtyPath -Force }
}
Write-Output "Verification passed: $resolvedReceiptPath"
exit 0
