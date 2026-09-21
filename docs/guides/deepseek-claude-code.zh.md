# Claude Code 搭配 DeepSeek API

本文说明如何让 Claude Code 通过 DeepSeek 的 Anthropic 兼容 API 运行，并用 `claude-tap` 捕获这条流量。

DeepSeek 官方 Claude Code 集成会把 Claude Code 指向 `https://api.deepseek.com/anthropic`，主模型使用 `deepseek-v4-pro[1m]`。如果同时使用 `claude-tap`，继续保留这套 Claude Code 环境即可。`claude-tap` 会先从 `ANTHROPIC_BASE_URL` 读取 DeepSeek 上游，再把 Claude Code 指向本地代理。

English version: [Claude Code with DeepSeek API](deepseek-claude-code.md).

## 环境变量

Claude Code 使用 `ANTHROPIC_AUTH_TOKEN` 传入 DeepSeek key，并建议清掉 `ANTHROPIC_API_KEY`，避免 Claude Code 触发 API key 冲突提示。

```bash
export ANTHROPIC_AUTH_TOKEN="<你的 DeepSeek API key>"
unset ANTHROPIC_API_KEY

export ANTHROPIC_MODEL="deepseek-v4-pro[1m]"
export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro[1m]"
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-pro[1m]"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash"
export CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4-flash"
export CLAUDE_CODE_EFFORT_LEVEL=max
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
```

`claude-tap` 会在改写被启动的 Claude Code 进程之前，把当前 `ANTHROPIC_BASE_URL` 作为真实上游目标。只有想手动覆盖时才需要传 `--tap-target`。

## 使用 claude-tap 捕获

正常启动 `claude-tap`：

```bash
claude-tap -- --permission-mode bypassPermissions
```

一次性非交互 smoke test：

```bash
claude-tap \
  -- \
  --permission-mode bypassPermissions \
  -p 'Use Bash to run pwd, then reply with DEEPSEEK_CLAUDE_TAP_OK.'
```

进程退出后打开自动生成的 HTML：

```bash
open .traces/*/trace_*.html
```

也可以从 JSONL 重新导出 HTML：

```bash
claude-tap export .traces/2026-05-06/trace_153111.jsonl -o trace.html
```

## TLS 与本地代理

如果上游请求报 `SSLCertVerificationError`，但直接 `curl` 能成功，通常是 Python 进程使用的 CA bundle 不信任本地出站代理。可以显式指定系统 CA bundle 或代理使用的 CA bundle：

```bash
# macOS/Homebrew 常见路径是 /etc/ssl/cert.pem。
SSL_CERT_FILE=/etc/ssl/cert.pem claude-tap
```

Debian/Ubuntu 的系统 CA bundle 通常是 `/etc/ssl/certs/ca-certificates.crt`。

## 兼容性说明

Claude Code 2.1.128 和 2.1.131 可能把 `metadata.user_id` 作为 JSON 字符串发送。DeepSeek 的 Anthropic 兼容端点会拒绝这个值，因为它只接受字母、数字、下划线和连字符。`claude-tap` 只会在上游目标是 `https://api.deepseek.com/anthropic` 时规范化非法的 `metadata.user_id`；默认 Anthropic 流量保持不变。

DeepSeek 对 Claude Code 启动时的 `/v1/models?limit=1000` 预检可能返回 `404`。只要 `/v1/messages` 成功，Claude Code 仍可继续运行。下面的验证运行设置了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，用于减少无关启动流量。

`claude-tap` 会脱敏 `Authorization` / `x-api-key` 请求头，但不会全局清洗 prompt、请求 body 或工具输出。不要把 key 写进 prompt、脚本输出或 trace 内容里。

## 已验证运行

2026-05-06 验证环境：

- DeepSeek Anthropic API 直连调用返回 HTTP `200`
- Claude Code `2.1.131`
- Claude Code 主对话模型：`deepseek-v4-pro[1m]`
- Claude Code 标题和辅助调用模型：`deepseek-v4-flash`
- `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
- `claude-tap`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

真实 tmux 串行运行结果：

- 3 轮用户对话
- 11 个 `/v1/messages` 请求
- 6 个唯一 `Bash` `tool_use` block，每轮 2 个
- 6 个匹配的 `tool_result` block
- 从真实 `.traces/` trace 生成 HTML viewer
- 使用 Playwright 多次鼠标滚动后截图

概览：

![DeepSeek Claude Code serial overview](../../.agents/evidence/images/deepseek-claude-code-serial-overview.png)

滚动后的详情区域：

![DeepSeek Claude Code serial detail scroll](../../.agents/evidence/images/deepseek-claude-code-serial-detail-scroll-1.png)

滚动后的侧边栏导航：

![DeepSeek Claude Code serial sidebar scroll](../../.agents/evidence/images/deepseek-claude-code-serial-sidebar-scroll.png)

继续滚动后的最终回复：

![DeepSeek Claude Code serial final response](../../.agents/evidence/images/deepseek-claude-code-serial-final-response.png)

## 参考文档

- [DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)
- [DeepSeek Claude Code 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)
