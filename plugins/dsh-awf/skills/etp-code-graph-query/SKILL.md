---
name: etp-code-graph-query
description: 在存量 Java/Spring Boot 仓库中做代码影响检索与证据定位：优先使用代码知识图谱 MCP 工具，无图谱时降级为 ripgrep/Glob 静态检索。A3 影响分析与 A5 独立复核前必须读取。
---

# 代码图谱与静态检索

目标：每个影响结论都能落到具体代码或图谱节点，并且能说明「怎么找到的」。

## 1. 选择检索模式

按顺序判断：

1. 工具列表中存在代码图谱 MCP 工具（名称含 `graph`、`code_graph`、`blast`、`callers` 等）→ 图谱模式。
2. 仓库存在图谱导出文件（`*.graph.yaml`、`graph.json`、`.awf/graph`）→ 读取导出文件。
3. 否则 → 静态模式（ripgrep + Glob + Read）。

图谱由公司统一知识库通过 MCP 提供。后续迁到项目内自建时，工具名、入参、返回结构保持不变，调用方式不改；只替换 MCP Server 实现与连接配置。

在产物中记录：`retrieval_mode: graph | graph_export | static`、`graph_version`、`graph_commit`，以及实际 commit 与图谱 commit 的偏差是否在基线声明的 `lag_policy` 内。模式降级不算失败，但必须写进 `degraded`。

## 2. 图谱模式查询

按需执行以下查询，参数用符号或业务词：

| 查询 | 用途 |
| --- | --- |
| entities_by_capability | 业务能力 → 关联类/方法/接口 |
| blast_radius | 符号 → 上下游扩散 |
| table_field_usages | 表/字段读写方 |
| api_consumers | API 调用方 |
| jobs_touching | 关联定时任务 |
| message_producers / message_consumers | 消息生产/消费 |
| config_references | 配置项引用 |
| permission_references | 权限点关联 |
| bean_dependencies | Spring Bean 依赖 |
| cross_module_calls | 跨模块调用 |
| tenant_context_paths | 租户上下文传递 |

约束：

- 扩散必须设置深度（默认 3）与节点上限（200），超出记录 `truncated`。
- 返回体必须包含 `graph_version`、`graph_commit`、`truncated`；缺失任一项视为无效证据。
- 结果必须带节点 ID；只有自然语言描述的返回视为无效，不得作为证据。
- 图谱结果必须用代码复核：打开 `file` 确认符号存在，记录 `file:line`。
- 图谱 commit 落后基线代码超出 `lag_policy` 时，结论只能作为线索，必须静态复核，否则标 `evidence_gap`。

## 3. 静态模式检索

### 3.1 定位定义

```bash
rg -n "class +<Name>|interface +<Name>|enum +<Name>" --glob '*.java'
rg -n "<method>\s*\(" --glob '*.java'
```

### 3.2 找调用方

```bash
rg -n "\b<method>\s*\(" --glob '*.java' | rg -v "void <method>|public .* <method>\("
rg -n "<ClassName>" --glob '*.java'
```

### 3.3 数据与表

```bash
rg -n "<table_name>" --glob '*.{java,xml,sql,yml,yaml}'
rg -n "<field_name>" --glob '*.{java,xml,sql}'
```

### 3.4 消息

```bash
rg -n "<topic_or_exchange>" -B3 -A6 --glob '*.{java,xml,yml,yaml}'
rg -n "@RabbitListener|@KafkaListener|@RocketMQMessageListener|MessagePublisher|send\(" --glob '*.java'
```

### 3.5 Job 与调度

```bash
rg -n "@Scheduled|@XxlJob|QuartzJobBean|implements Job" --glob '*.java'
```

### 3.6 配置与开关

```bash
rg -n "<config.key>|<config-key>|<CONFIG_KEY>" --glob '*.{java,yml,yaml,properties,xml}'
rg -n "@Value|@ConfigurationProperties|getProperty\(" --glob '*.java'
```

### 3.7 权限

```bash
rg -n "@RequirePermission|@PreAuthorize|hasPermission|permissionCode" --glob '*.java'
```

### 3.8 租户上下文

```bash
rg -n "TenantContext|tenantId|tenant_id|TENANT_ID" --glob '*.{java,xml,yml}'
```

### 3.9 跨模块与依赖

```bash
rg -n "^import .*\.<module>\." --glob '*.java'
rg -n "<InterfaceName>" --glob '*.java'
```

### 3.10 动态行为

```bash
rg -n "Class\.forName|getBean\(|invoke\(|SpEL|#\{" --glob '*.java'
rg -n "@ConditionalOn|@Profile|@Conditional" --glob '*.java'
```

## 4. 证据写法

| 类型 | 写法 | 适用 |
| --- | --- | --- |
| `graph_proven` | `graph:<node-id>` + 关系 + target | 图谱确认的调用/读写/消息关系 |
| `static_analysis` | `<path>:<line>` | 代码中可见的定义、调用、SQL、注解 |
| `configuration_proven` | `<config-path>#<key>` | 配置项与默认值 |
| `git_history` | `git:<commit>` + 文件 | 历史变更依据 |
| `runtime_proven` | `runtime:<source-id>` | API/Trace/MQ/Job 记录 |
| `heuristic` | 说明推断链 | 无法直接验证但必须给出推理依据 |
| `needs_runtime_confirm` | 说明缺什么数据 | 动态/反射/租户差异 |

禁止：只写「参考 XX 服务」而不给文件与行号；把注释或 README 当代码事实。

## 5. 图谱与代码不一致

1. 以基线 commit 代码为准。
2. 记录 `graph_drift`：节点、图谱声明、代码实际。
3. 相关结论不得标 `final`，并建议更新图谱版本。

## 6. 盲区提示

以下情况容易漏：

- 反射、SpEL、动态代理、AOP 织入的隐式调用
- MyBatis XML / 动态 SQL 中的表与字段
- 定时任务由数据库配置启用
- MQ 消费者在别的模块或别的仓库
- 通过配置中心下发的租户级差异
- 已无调用但仍存在的历史接口

遇到以上情况，写 `needs_runtime_confirm` 或扩大检索范围，不得默认无影响。
