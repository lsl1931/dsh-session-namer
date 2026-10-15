# install-session-namer.ps1
# 构建 dsh-session-namer 并挂载到一个 dsh profile：
#   1) node build.mjs          —— 生成 lib/
#   2) 复制进 <profile>/node_modules/dsh-session-namer（真实目录，不是软链）
#      为什么用真实目录：安装副本才能被逐字节比对（selftest --installed），
#      也避免 pnpm 的 link 语义在 profile 重装时改变解析路径。
#      注：'@deepseek-ai/*' 由宿主 Loader 在运行时解析，与这里无关 —— 旧注释
#      声称"必须真实目录才能解析到 @deepseek-ai/*"并不成立（desktop profile 的
#      node_modules 里根本没有 @deepseek-ai，插件照常工作）。
#   3) 把 dsh-session-namer 加进 profile package.json 的 dsh.profile.bundles
# 之后需要重启 dsh web 才会加载。
#
# profile 解析顺序：-Profile 显式指定 > 已经装了本插件的 profile > 唯一的 profile；
# 都确定不了就报错并列出候选，不再默认写死 web。
#
# 用法: pwsh -NoProfile -File install-session-namer.ps1 [-Profile <名称>] [-Check] [-Remove]

param(
	[string]$Profile,
	[switch]$Check,
	[switch]$Remove
)

$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginName = 'dsh-session-namer'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $dshHome 'profiles'
if (-not (Test-Path -LiteralPath $profilesRoot)) { throw "找不到 profiles 目录: $profilesRoot" }

$candidates = @(Get-ChildItem -LiteralPath $profilesRoot -Directory |
	Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') })
if ($candidates.Count -eq 0) { throw "在 $profilesRoot 下没有找到任何 profile（缺少 package.json）" }

if ($Profile) {
	$profileRoot = Join-Path $profilesRoot $Profile
	if (-not (Test-Path -LiteralPath (Join-Path $profileRoot 'package.json'))) {
		throw "profile '$Profile' 不存在或缺少 package.json；候选: $($candidates.Name -join ', ')"
	}
} else {
	$installed = @($candidates | Where-Object {
		(Get-Content -LiteralPath (Join-Path $_.FullName 'package.json') -Raw | ConvertFrom-Json).dsh.profile.bundles -contains $pluginName
	})
	if ($installed.Count -ge 1) { $profileRoot = $installed[0].FullName }
	elseif ($candidates.Count -eq 1) { $profileRoot = $candidates[0].FullName }
	else { throw "无法确定 profile，请用 -Profile <名称>；候选: $($candidates.Name -join ', ')" }
}

$profilePkg = Join-Path $profileRoot 'package.json'
$targetDir = Join-Path (Join-Path $profileRoot 'node_modules') $pluginName
Write-Host "[info] profile: $profileRoot"

# ---------------------------------------------------------------- 反安装
if ($Remove) {
	if (Test-Path -LiteralPath $targetDir) {
		Remove-Item -LiteralPath $targetDir -Recurse -Force
		Write-Host "[remove] 已删除: $targetDir"
	}
	$json = Get-Content -LiteralPath $profilePkg -Raw | ConvertFrom-Json -AsHashtable
	$bundles = @($json['dsh']['profile']['bundles'])
	if ($bundles -contains $pluginName) {
		$backup = "$profilePkg.dsh-bak"
		if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $profilePkg -Destination $backup -Force }
		$json['dsh']['profile']['bundles'] = @($bundles | Where-Object { $_ -ne $pluginName })
		[IO.File]::WriteAllText($profilePkg, ($json | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
		Write-Host "[remove] 已从 bundles 移除 $pluginName（重启 dsh web 生效）"
	} else {
		Write-Host "[remove] bundles 里本来就没有 $pluginName"
	}
	exit 0
}

# ---------------------------------------------------------------- 构建
if ($Check) {
	Write-Host "[check] 源目录: $source"
	Write-Host "[check] 目标目录: $targetDir"
	$json = Get-Content -LiteralPath $profilePkg -Raw | ConvertFrom-Json -AsHashtable
	$bundles = @($json['dsh']['profile']['bundles'])
	Write-Host "[check] bundles 已包含: $($bundles -contains $pluginName)"
	exit 0
}

Push-Location $source
try {
	$node = (Get-Command node -ErrorAction SilentlyContinue).Source
	if (-not $node) { throw '未找到 node' }
	& $node (Join-Path $source 'build.mjs')
	if ($LASTEXITCODE -ne 0) { throw "build 失败（exit $LASTEXITCODE）" }
} finally {
	Pop-Location
}

# 语法自检：两个 half 都要能过 node --check
foreach ($file in @('lib\index.js', 'lib\client.js')) {
	$path = Join-Path $source $file
	if (-not (Test-Path -LiteralPath $path)) { throw "缺少构建产物: $path" }
	& $node --check $path
	if ($LASTEXITCODE -ne 0) { throw "语法检查未通过: $file" }
}

# ---------------------------------------------------------------- 复制进 profile
if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
foreach ($item in @('lib', 'package.json', 'cordis.patch.yml', 'README.md')) {
	$from = Join-Path $source $item
	if (-not (Test-Path -LiteralPath $from)) { continue }
	Copy-Item -LiteralPath $from -Destination $targetDir -Recurse -Force
}
Write-Host "[ok] 已安装到: $targetDir"

# ---------------------------------------------------------------- 注册 bundle
$json = Get-Content -LiteralPath $profilePkg -Raw | ConvertFrom-Json -AsHashtable
$bundles = @($json['dsh']['profile']['bundles'])
if ($bundles -contains $pluginName) {
	Write-Host "[skip] bundles 已包含 $pluginName"
} else {
	$backup = "$profilePkg.dsh-bak"
	if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $profilePkg -Destination $backup -Force }
	$json['dsh']['profile']['bundles'] = @($bundles + $pluginName)
	[IO.File]::WriteAllText($profilePkg, ($json | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding $false))
	Write-Host "[ok] 已把 $pluginName 加进 dsh.profile.bundles（原文件备份为 package.json.dsh-bak）"
}

Write-Host '[next] 重启 dsh web（或重开 DSH 应用）后，会话标题右侧会出现「总结命名」按钮'
Write-Host '[note] 以后在 profile 里跑 pnpm install 可能会清掉这个手工放置的目录，重跑本脚本即可'
