# Fable 5.1 提示词抓取手册

用 OrcaReplay 在本机代理层抓下 Claude Code 交互模式发给 `claude-fable-5-1` 的完整系统提示词。
抓的是本机 agent 的出站请求，不涉及任何服务端。

> 这份手册记录的是手动流程。日常用 `node capture/capture.mjs <claude|codex>` 一条命令跑完，
> 八步都在里面。手册留着是为了移植到别的 harness 或别的平台时知道每一步在做什么。

环境：Claude Code 2.1.258 · OrcaReplay 0.1.2 · Windows 10 Pro · node 22.23.2 · 2026-09-02

## 产出

| 项 | 值 |
|---|---|
| `system[]` 四个 block | 14,953 字符 |
| 注入的 `role:"system"` 消息 | 11,529 字符 |
| 工具定义 | 35 个 / 140,071 字节 |
| 请求体总计 | 168,303 字节 |
| 服务端计费 prefix | 59,811 tokens |

最终落地 `prompt/claude-fable-5-1-system-prompt.md`，只含提示词本身。

## 前置条件

| 项 | 要求 |
|---|---|
| node | 20.19+ 或 22.12+ |
| orcareplay | `npm i -g orcareplay` |
| claude | 已登录且能直连 api.anthropic.com |
| 终端 | Windows。步骤 4 需要 PowerShell |

Linux 和 macOS 上第 3 到 5 步可以合并成一条 `orca record claude`：那里管道背后仍是 pty，
Claude Code 会按交互模式装配。Windows 不行，原因见下面的坑。

## 步骤

### 1. 先看 orca 会把请求发到哪

如果 `orca setup` 配过 gateway，`resolveUpstream()`（`packages/cli/src/config.ts:132`）会把所有
anthropic 流量转到那里，而第三方 router 通常没有 fable。

```console
$ cat ~/.config/orca/config.json
{ "gateway": { "url": "http://<your-gateway>:8317", "api_key": "<key>" },
  "models": [ "gpt-5.6-sol" ] }
```

只要这个文件里有 `gateway`，后面每条 orca 命令都加上 `--upstream-anthropic https://api.anthropic.com`。

### 2. 先抓一份 print 模式的，验证链路

可选，但便宜且能立刻确认代理、凭据、模型 id 三者都通。

```console
$ orca record claude --no-fs --no-shell \
    --upstream-anthropic https://api.anthropic.com \
    -- -p "reply with just: ok" --model claude-fable-5-1
info recording run=run_8e6d567d4ca4 adapter=claude-code proxy=:58642
ok
info recorded run=run_8e6d567d4ca4 events=7 blobs=3 exit=0
```

看到 `exit=0` 说明链路没问题。注意这份是 `cc_entrypoint=sdk-cli`，不是交互模式那份。

### 3. 起一个常驻代理

`orca attach` 不负责启动 agent，只把代理挂住并打印要 export 的变量。`--port` 没写进 `--help`，
但它存在，固定端口能省掉解析输出这一步。

```console
$ orca attach --for claude --port 46001 \
    --upstream-anthropic https://api.anthropic.com
info attached run=run_bc749535e248 proxy=http://127.0.0.1:46001 for=claude-code

  # in the sandbox, before starting your agent:
  export ANTHROPIC_BASE_URL='http://127.0.0.1:46001'
  # your agent's own credential is unchanged - orca forwards it upstream

  Recording. Press ctrl-C when the agent is done.
```

这条命令会一直挂着。开新窗口做下一步。

### 4. 在一个真 console 里启动 claude

关键在 `Start-Process` 不带 `-NoNewWindow`：Windows 会给控制台程序分配一个真的 console，
于是 `process.stdin.isTTY` 为真，Claude Code 走交互模式装配。

```powershell
$claude = "$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
foreach ($n in @('CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID','CLAUDE_EFFORT','CLAUDE_CODE_EXECPATH','AI_AGENT')) {
  if (Test-Path "Env:\$n") { Remove-Item "Env:\$n" }
}
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:46001'
Start-Process -FilePath $claude -WindowStyle Minimized -PassThru `
  -WorkingDirectory 'D:\your\repo' `
  -ArgumentList @('--model','claude-fable-5-1','"say only the word ok"')
```

提示词用内嵌双引号包成**单个**参数。工作目录选一个 claude 已经信任过的仓库，否则它会弹信任确认然后卡住。

### 5. 等带工具的那条请求落盘

第一条 `model.request` 是标题生成调用，`tools=0`，不是你要的。等 `tools` 大于零的那条。

```console
$ until grep -q '"tools":3' .orca/runs/*/events.jsonl; do sleep 2; done
seq 4  model.request   claude-fable-5-1  tools=35  blob=175255
seq 5  model.response  200  end_turn  cache_read=59811
```

### 6. 收干净

两个进程都要停。杀掉启动 `orca attach` 的那个 shell 并不会杀掉它底下的 node，端口会一直被占。

```powershell
Stop-Process -Id 18544 -Force
Get-NetTCPConnection -LocalPort 46001 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### 7. 从 trace 里取出请求体

事件里存的是 blob 的 sha256，按前两位分目录。取 `tools>0` 的**第一条**，别取最大那条——
后面的轮次会加载延迟工具，工具数会从 35 涨到 37。

```js
const evs = readFileSync(dir + '/events.jsonl', 'utf8')
  .split('\n').filter(Boolean).map(JSON.parse);
const r = evs.filter(e => e.type === 'model.request' && e.attrs.tools > 0)[0];
const sha = r.payload.$blob.replace('sha256:', '');
let body = JSON.parse(readFileSync(`${dir}/blobs/${sha.slice(0,2)}/${sha}`, 'utf8'));
if (typeof body === 'string') body = JSON.parse(body);   // blob 是双层 JSON
```

### 8. 拼出提示词并脱敏

提示词分两处：`body.system` 四个 block，以及 `body.messages` 里那条 `role:"system"`
（装的是 agent 类型、skill 清单和权限模式段）。

```js
const prompt = body.system.map(s => s.text).join('\n\n')
  + '\n\n' + body.messages.find(m => m.role === 'system').content[0].text;
```

```
  [0]     70 字符  cache=none    billing header
  [1]     57 字符  cache=1h      identity
  [2]    907 字符  cache=none    reporting outcomes
  [3]  13919 字符  cache=1h      正文
  role:system  11529 字符
```

然后把机器相关的值替换成占位符。`capture.mjs` 里的规则是从本机推出来的，不是写死的：家目录、
用户名、git 用户名和邮箱、gateway 主机、Claude Code 的项目 slug、系统 build，再加上邮箱、uuid、
32 位以上十六进制串的通用规则。顺序有讲究——memory 目录在家目录里面，家目录规则先跑会留下
半替换的路径。替换完回扫一遍，有残留就直接报错不写文件。

## 两个模式差多少

| | print (sdk-cli) | interactive (cli) |
|---|---|---|
| `system[]` | 13,641 字符 | 14,953 字符 |
| `role:system` | 7,585 字符 | 11,529 字符 |
| tools | 29 | 35 |
| 请求体 | 104,492 字节 | 168,303 字节 |
| tokens | 37,831 | 59,811 |

交互模式独有：`! <command>` 提示、整个 Scratchpad Directory 段、cwd 是 git 仓库时追加的
`gitStatus` 块，以及 `Artifact`、`AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode` 四个工具。

身份行也不一样：

- print — `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
- interactive — `You are Claude Code, Anthropic's official CLI for Claude.`

## 坑

**gateway 会静默改写上游。** `400 unknown provider for model claude-fable-5-1` 来自你自己配的
gateway，不是 Anthropic，也和 claude 装没装无关。本机 claude 能跑是因为它直连官方端点。

**凭据会被转发到上游。** `packages/proxy/src/server.ts` 里 `SECRET_REQUEST_HEADERS` 明确会
forward auth 头（只是不写进 trace）。上游指向第三方 gateway 时，等于把 OAuth token 连同整个
提示词发了过去。走明文 HTTP 更糟。

**`orca record claude` 抓不到交互模式。** 它用管道启动，`isTTY` 为假，Claude Code 直接走非交互
装配。适配器里 `command` 硬编码成 `'claude'`，也没法插一层 winpty 进去。

**winpty 在无 console 环境下起不来。** `winpty.cc:924` 断言 `cols > 0 && rows > 0` 失败，因为它
从 stdout 拿不到窗口尺寸，而命令行又没有 `--cols`。所以走 `Start-Process` 让系统分配 console，
比自己造 pty 省事。

**PowerShell 会把带空格的参数拆开。** `-ArgumentList` 里写 `'reply with just: ok'`，claude 只收到
`reply`，然后自己去翻 git 和 PR 找上下文。系统提示词不受影响，但会白烧 token。

**不清 `CLAUDE_*` 会被当成嵌套会话。** 从一个 Claude Code 会话里启动 claude，`CLAUDECODE=1` 和
`CLAUDE_CODE_CHILD_SESSION=1` 会被继承。步骤 4 里那一串 `Remove-Item` 就是为这个。

## 怎么确认抓到的是真的

跑两次，diff `system[3]`。除了下面这些 cwd 派生的值，应该逐字节相同。

| 允许的差异 | 为什么 |
|---|---|
| scratchpad 路径 | 每个会话一个 uuid |
| memory 目录 | 由 cwd 派生 |
| `gitStatus` 块 | 随仓库状态变 |
| `cc_version` 后缀 | 对装配后 prompt 取的哈希，上面几项一变它就变 |

另一个交叉验证：那次被 gateway 拒的抓取和后来 200 成功的抓取，`system[3]` 只差工作目录和
memory 哈希，工具定义与 `role:system` 完全一致。**上游返回什么不影响已经录下的请求**——提示词是
本机装配后发出去的，代理在转发前就落盘了。

## 参考 run

| run | 模式 | 结果 |
|---|---|---|
| `run_bc749535e248` | interactive | 200 |
| `run_8e6d567d4ca4` | print | 200 |
| `run_7a02fa0c8266` | print | 被 gateway 拒，请求体仍完整 |
