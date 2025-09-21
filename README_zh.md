# Claude Code Router（派生版本）

Fork 自：https://github.com/musistudio/claude-code-router

本分支侧重于 Provider 多密钥轮询与按 key 统计/诊断：

- 每个 Provider 支持多个 api_keys（仅在请求成功时推进轮询索引）
- 将每个 key 的用量写回配置：req_count、req_tokens、rsp_tokens
- 将错误写回配置：err_code、err_msg（如 401/403）
- CLI 全局支持 --config（start、code、ui 等命令均可），写回到同一配置文件
- 4xx（非 429）失败时同一次请求内不切换 key，便于客户端/系统重试在 UI 中可见

## 安装

```
npm install -g @vitorcen/ccr-multi-key
```

## CLI 使用

- 可在命令前/后任意位置传入配置：
  `ccrm -c /path/to/config.json code "..."` 
  或 `ccrm code --config=/path/to/config.json "..."`
- 指标统计会写回到该配置文件。

## 最小配置示例（不含统计字段）

```json
{
  "Providers": [
    {
      "name": "gemini",
      "api_base_url": "https://generativelanguage.googleapis.com/v1beta/models/",
      "api_keys": [
        { "name": "free_tier1", "key": "sk-..." },
        { "name": "free_tier2", "key": "sk-..." },
        { "name": "free_tier3", "key": "sk-..." }
      ]
    }
  ],
  "Router": {
    "default": "gemini,gemini-2.5-pro"
  }
}
```

## 统计信息示例（由路由器写回）

```json
{
  "Providers": [
    {
      "name": "gemini",
      "api_keys": [
        {
          "name": "free_tier1",
          "key": "sk-...",
          "req_count": 3,
          "req_tokens": 74196,
          "rsp_tokens": 695,
          "req_today": 3,
          "last_req_ts": 1727000000,
          "err_code": 0,
          "err_msg": ""
        },
        {
          "name": "free_tier2",
          "key": "sk-...",
          "req_count": 2,
          "req_tokens": 1580,
          "rsp_tokens": 0,
          "req_today": 2,
          "last_req_ts": 1727000000,
          "err_code": 401,
          "err_msg": "Error from provider(,... 401): No auth credentials found"
        },
        {
          "name": "free_tier3",
          "key": "sk-...",
          "req_count": 1,
          "req_tokens": 980,
          "rsp_tokens": 120,
          "req_today": 1,
          "last_req_ts": 1727000000,
          "err_code": 0,
          "err_msg": ""
        }
      ]
    }
  ]
}
```

## Gemini API 限速（官方数据）

重要说明：Gemini 的限速按“项目（project）”生效，而非按 API Key。只有将三个 key 分属三个独立项目时，“Free x3 聚合”才有意义；若都在同一项目下，额度不会相加。

### Gemini 2.5 Pro（text-out）— Free vs Free x3 vs Tier 1


| 限制类型            | Free Tier | Free Tier x3 |    Tier 1 |
| --------------------- | ----------: | -------------: | ----------: |
| RPM（每分钟请求数） |         5 |           15 |       150 |
| TPM（每分钟令牌数） |   250,000 |      750,000 | 2,000,000 |
| RPD（每日请求数）   |       100 |          300 |    10,000 |

### Gemini 2.5 Flash（text-out）— Free vs Free*3 vs Tier 1


| 限制类型            | Free Tier | Free Tier x3 |    Tier 1 |
| --------------------- | ----------: | -------------: | ----------: |
| RPM（每分钟请求数） |        10 |           30 |     1,000 |
| TPM（每分钟令牌数） |   250,000 |      750,000 | 1,000,000 |
| RPD（每日请求数）   |       250 |          750 |    10,000 |

备注：

### 关于多 Key 轮询（Gemini）的说明

- 限速按“项目（project）”生效，而非按 API Key。对同一项目下的多个 key 做轮询，并不会提升实际的 RPM/TPM/RPD。
- “Free ×3” 仅在三个 key 分属三个独立项目（各自独立配额）时才有叠加意义。即使如此，Google 亦声明“具体配额不作保证，实际容量可能波动”。
- 推荐路径：升级到更高层级、申请提额，或在符合 Google 政策的前提下，将流量分片到真正相互独立的项目。

  - 限速文档：https://ai.google.dev/gemini-api/docs/rate-limits
  - 附加使用政策：https://ai.google.dev/gemini-api/docs/usage-policies
- 不同模型（如 2.5 Pro、2.5 Flash）额度不同；上表展示常见的两个 text-out 模型。
- 某些模型有额外维度（例如 Live API 的会话数、Imagen 的每分钟图片数等），详见官方表格。
- 可在命令前/后任意位置传入配置：`ccr --config /path/to/config.json code "..."` 或 `ccr code --config=/path/to/config.json "..."`
- 指标统计会写回到该配置文件。
