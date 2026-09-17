# install-session-namer.ps1
# 构建 dsh-session-namer 并挂载到 web profile：
#   1) node build.mjs          —— 生成 lib/
#   2) 复制进 ~/.dsh/profiles/web/node_modules/dsh-session-namer（真实目录，不是软链）
#      注意：这里必须用真实目录。Node 会按真实路径解析 import，link: 过来的包会去
#      C:\RJ\... 下面找 @deepseek-ai/* 而找不到；真实目录则在 profile 的 node_modules
#      树里解析得到（dsh-better-sidebar 就是这个形态）。
#   3) 把 dsh-session-namer 加进 profile package.json 的 dsh.profile.bundles
# 之后需要重启 dsh web 才会加载。
# 用法: pwsh -NoProfile -File install-session-namer.ps1 [-Check] [-Remove]

param(
	[switch]$Check,
	[switch]$Remove
)

$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileRoot = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$profilePkg = Join-Path $profileRoot 'package.json'
$pluginName = 'dsh-session-namer'
$targetDir = Join-Path $profileRoot "node_modules\$pluginName"

if (-not (Test-Path -LiteralPath $profilePkg)) { throw "找不到 profile package.json: $profilePkg" }

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
