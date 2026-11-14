# Skill 设计详细文档

> 面向：在存量 SaaS / 多仓依赖场景下，为 Coding Agent 编写可触发、可按需加载、可与代码知识图谱配合的 Skill。  
> 约定：Agent 以「每个目录一个 skill + 必需 `SKILL.md`」为机制；长文与清单放入 `references/`。

---

## 1. 文档目的与适用范围

### 1.1 目的

说明 **Skill 是什么、何时该建、目录如何组织、正文写什么、如何与知识图谱/多仓框架配合、如何验收**，使团队能稳定产出同一质量的 Skill，而不是随手写一篇长 Markdown。

### 1.2 适用场景

- 公司/部门/项目特有约定（模型默认不知道）
- 分层封装与 SPI 扩展（如审批流）
- 独立仓中的中间件、开发框架、common 包的用法与禁区
- 维护型交付中「理解存量 + 按规范新增」的操作手册

### 1.3 不适用

- 通用编程知识（语言语法、常见设计模式科普）
- 应用知识图谱即可完整回答的「某 processKey 有哪些实现类」类纯事实清单（应由图谱提供，Skill 只写读法）
- 一次性格的需求说明（应走 US / 流水线产物，而不是 Skill）

---

## 2. Skill 在 Agent 中的机制

### 2.1 官方形态

```text
skills/
  <skill-name>/
    SKILL.md              # 必需
    references/           # 可选：按需加载的长文档
    scripts/              # 可选：可执行脚本
    assets/               # 可选：模板、样例骨架
```

### 2.2 三级加载（必须按此设计内容）

| 层级      | 内容                   | 何时进入上下文      | 设计含义                               |
| --------- | ---------------------- | ------------------- | -------------------------------------- |
| L1 元数据 | `name` + `description` | 几乎总是可见        | **唯一触发依据**，要写清做什么、何时用 |
| L2 正文   | `SKILL.md` 主体        | Skill 被选中/加载后 | 心智模型、硬规则、阅读路由；控制篇幅   |
| L3 资源   | `references/*` 等      | 模型按需再读        | SPI 全表、playbook、反模式、示例解读   |

原则：**短入口 + 按需深读**。不要把全书塞进 `SKILL.md`。

### 2.3 「域」如何表达

机制上 **没有「域」一等公民**。业务上的「工作流域 / 框架域」应落成：

- **一个 skill 目录**（如 `project-workflow`）
- `SKILL.md` 做域入口与路由
- `references/` 承载域内多主题文档

仅当触发场景、受众、版本生命周期明显不同（例如公司级 BPM SDK 被多系统共用）时，再拆成 **第二个独立 skill**，并在本 skill 中声明「必要时再加载 xxx」。

---

## 3. 何时应该建 Skill

满足多数下列条件再建：

1. 组织或项目特有，模型无法可靠「猜对」
2. 会被 **重复** 用于理解存量或实现新功能
3. 存在 **必须遵守的约束**（禁区、必选扩展点、版本锁定）
4. 与代码结构有稳定对应（包名、SPI、注册方式）
5. 维护成本可接受（有明确 owner、可随发版更新）

**优先写成 Skill 的内容：**

- 项目门面 API 与调用时序
- SPI 必选/可选合同
- 新建某类功能的标准步骤（playbook）
- 反模式与评审检查点
- 外部中间件的标准接入方式与禁止直连项

**优先交给图谱 / 工具的内容：**

- 某 key 当前有哪些实现类
- 完整调用图、表字段读写
- 频繁变更的全量类清单

---

## 4. 目录与命名规范

### 4.1 命名

- 目录名 = frontmatter `name`
- 仅小写字母、数字、连字符；建议 `项目或层级-能力`  
  - 例：`project-workflow`、`dept-cxf-framework`、`platform-config-client`
- 避免：`docs`、`utils`、`misc` 等无法触发的名字

### 4.2 推荐目录模板（复杂能力）

```text
project-workflow/
  SKILL.md
  references/
    architecture.md
    platform-sdk.md
    project-facade.md
    spi-catalog.md
    new-process-playbook.md
    existing-code-map.md
    anti-patterns.md
  assets/
    spi-impl-skeleton.java      # 或贵团队语言
  scripts/
    export-spi-signatures.sh    # 可选：从源码生成清单
```

### 4.3 简单能力

仅一篇能说清时：

```text
platform-mq/
  SKILL.md          # 含用法、配置、禁区即可
```

仍建议预留 `references/`，避免日后胀爆正文。

---

## 5. `SKILL.md` 写法规范

### 5.1 Frontmatter

```yaml
---
name: project-workflow
description: 项目审批流开发与存量理解。基于公司 Flowable BPM SDK 与项目级 SPI 封装。在新增审批流、实现提交审批驳回等扩展点、阅读现有流程实现、做工作流相关影响分析或技术方案时使用。
---
```

要求（按常见校验规则调整）：

- `description` 同时包含 **能力** 与 **触发场景/关键词**
- 尽量单行；避免易破坏 YAML 的写法（如未加引号的 `: ` 等，以你们校验器为准）
- 长度适中（常见上限约 1024 字符量级），把细节留给正文与 references

可选：

```yaml
metadata:
  domain: workflow
  version: "1.2"
  applies_to:
    - project-workflow-module 1.x
    - bpm-sdk 2.x
```

自定义字段放 `metadata` 下，避免占用未允许的顶层键。

### 5.2 正文结构（推荐固定大纲）

控制在可读的短文（实践上对齐「数百行内 / 高信号」）：

```markdown
# 一句话定位
# 分层心智模型（平台 → SDK → 项目封装 → 业务 SPI）
# 硬规则（5～10 条，可判定）
# 与代码图谱的配合方式（查什么、边含义、如何核对）
# 按任务加载 references 的路由表
# 关键入口（包名、门面类、注册方式一句话）
# 版本与适用范围
# 维护说明（owner、随发版更新什么）
```

### 5.3 路由表（有图谱时仍必写）

| 任务                   | 必读                                                         | 按需                      |
| ---------------------- | ------------------------------------------------------------ | ------------------------- |
| 理解某 processKey 存量 | SKILL + spi-catalog + existing-code-map；并用图谱拉实现      | architecture、golden 示例 |
| 新建审批流             | SKILL + project-facade + spi-catalog + playbook + anti-patterns | platform-sdk              |
| 改公共封装/SPI 定义    | architecture + spi-catalog + anti-patterns                   | 图谱查全量实现方          |
| 方案评审               | spi-catalog + playbook + anti-patterns                       | —                         |

### 5.4 读图协议（图谱已有实现时的核心价值）

写清固定步骤，例如：

1. 以 `processKey`（或业务类型）查询图谱实现节点与 `implements` / `calls` 边  
2. 用 `spi-catalog` 核对必选 SPI 是否齐全；缺失标为技术债，不当作规范  
3. 阅读顺序：项目门面 → 该流 SPI 实现 →（仅必要时）SDK 调用点  
4. 用 skill 中的生命周期解释边的先后，不凭文件名猜测  
5. 新建时只对齐结构与注册方式，不整段复制旧业务规则  

---

## 6. `references/` 内容设计

### 6.1 拆分原则

- **按 Agent 任务与生命周期拆**，不按随便文件名堆砌  
- 单文件主题单一，开头用 3～5 行说明「何时读本文件」  
- 超过约 100 行建议文内小目录  
- 从 `SKILL.md` **一层链接**到 reference，避免 reference 再套多层「必须先读」链

### 6.2 各文件职责（工作流范例，可映射到其他域）

| 文件                      | 写什么                                            | 不写什么                       |
| ------------------------- | ------------------------------------------------- | ------------------------------ |
| `architecture.md`         | 分层职责、一次提交/审批的标准时序                 | 全量类名列表                   |
| `platform-sdk.md`         | SDK 坐标、能力清单、**封装已覆盖勿直调**、例外    | Flowable 完整教程              |
| `project-facade.md`       | 统一 submit/approve API、事务/租户/幂等、注册方式 | 各业务校验细节                 |
| `spi-catalog.md`          | SPI 总表（必选/可选）、每接口时机/约束/示例类名   | 业务字段规则                   |
| `new-process-playbook.md` | 新建检查清单与交付物                              | 平台内部实现原理               |
| `existing-code-map.md`    | 命名约定、如何用图谱从 key 定位实现、1 个解读样例 | 全量 processKey 清单（交图谱） |
| `anti-patterns.md`        | 可判定的错误写法与正确替代                        | 空泛「注意性能」               |

### 6.3 SPI 类合同推荐表格

```markdown
| SPI | 阶段 | 必选/可选 | 用途 | 无实现时行为 |
|-----|------|-----------|------|--------------|
| ... | 提交前 | 必选 | 业务校验 | 不可注册成功 / 运行失败（按真相填写） |
```

每一 SPI 再补：方法签名（或链到生成清单）、上下文字段、允许/禁止操作、异常语义、存量示例 FQCN。

### 6.4 Playbook 推荐形态

可勾选步骤 + 每步「产物」+「参考示例类」；末尾 **DoD**：必选 SPI 已实现、已注册、最小路径联调通过、未引入 anti-patterns。

---

## 7. 与代码知识图谱的分工

| 知识类型                    | 归属                           | 说明                                    |
| --------------------------- | ------------------------------ | --------------------------------------- |
| processKey → 实现类、调用边 | **图谱**                       | Skill 不维护第二份全量地图              |
| 必选 SPI、调用时机、禁区    | **Skill**                      | 规范层                                  |
| 某次变更的 blast radius     | **图谱 + 流水线 A2**           | Skill 提供「改 SPI 时要查实现方」的指令 |
| 新建流步骤                  | **Skill**                      | 图上尚无节点                            |
| 接口签名最新值              | **生成物进 references 或工具** | CI 从源码导出，减少手写漂移             |

**验收句式：**  
「只给图谱，Agent 能列出实现；再给 Skill，Agent 能判断是否合规并按步骤新建。」

---

## 8. 多仓依赖（中间件 / 部门框架 / common）的 Skill 策略

### 8.1 分层资产

| 层级        | Skill 重点                                 |
| ----------- | ------------------------------------------ |
| 公司中间件  | 接入方式、配置、版本、禁区；薄             |
| 部门框架    | 标准写接口/调下游/异常/鉴权的项目写法      |
| 项目 common | 必须复用的类型与工具、「禁止平行实现」清单 |

### 8.2 业务仓挂载

- `AGENTS.md`：外部能力查阅顺序、版本以本仓依赖锁定为准  
- `docs/agent/external-index.md`：能力 → skill 名 / 坐标  
- 技术方案类任务：**强制引用**相关 skill 名与复用点  

### 8.3 版本

- Skill 目录或 `metadata.version` 与 Maven/Gradle 主版本对齐  
- 破坏性变更写 `BREAKING` 并改 playbook  
- 评审规则：引用 skill 版本与业务仓依赖不一致 → 警告或阻断  

---

## 9. 与交付流水线 Agent 的衔接

| 流水线步骤 | Skill 用法                                            |
| ---------- | ----------------------------------------------------- |
| A1 澄清    | 少用；仅当 US 涉及「是否已有平台能力」                |
| A2 影响    | 图谱为主；Skill 提示扩查询（SPI 实现方、门面调用方）  |
| A3 设计    | **必载** 域 Skill + 相关 facade/SPI；设计需写明复用点 |
| A4 评审    | 对照 `anti-patterns` 与必选 SPI 覆盖                  |
| A5/A6 实现 | 跟 playbook；禁止事项写入交接包                       |

---

## 10. 编写流程（团队可执行）

1. **定触发场景**：用户/开发会说什么话应命中该 skill  
2. **列模型不知的内容**：封装、SPI、禁区、注册方式  
3. **画分层与一次请求时序**（写入 architecture / SKILL）  
4. **列 SPI 或扩展点合同表**  
5. **写新建 playbook 与反模式**  
6. **接图谱**：写读图协议；删掉可图谱化的全量清单  
7. **选 1 个黄金示例** 做解读，不堆业务秘密逻辑  
8. **压缩 SKILL.md**，其余进 references  
9. **用 2～3 个真实任务试跑**（理解存量 / 新建 / 评审）改路由表  
10. **指定 owner 与发版更新项**（SPI 变更、版本矩阵）

---

## 11. 质量验收清单

发布前自检：

- [ ] `name` 与目录名一致，`description` 含场景关键词  
- [ ] `SKILL.md` 含硬规则 + 任务路由 +（若有图）读图协议  
- [ ] 长文在 `references/`，正文不重复粘贴全表  
- [ ] 必选/可选扩展点可判定；无实现时行为写清  
- [ ] 反模式可对照代码判断，而非口号  
- [ ] 不与图谱抢「全量实现列表」的维护  
- [ ] 版本与业务仓依赖对齐说明存在  
- [ ] 至少一次「仅 Skill+图谱」模拟：能完成理解存量或新建步骤草稿  

---

## 12. 反模式（Skill 设计本身）

| 反模式                  | 问题                    | 改法                        |
| ----------------------- | ----------------------- | --------------------------- |
| 单文件两万字 SKILL.md   | 占满上下文、遵循率下降  | 三级加载，细节进 references |
| 只有类清单没有合同      | 与图谱重复且易过期      | 清单交图谱，Skill 写规范    |
| 复制框架源码进 skill    | 漂移、泄密、噪声        | 签名生成 + 按需 get_source  |
| 空「域」目录无 SKILL.md | Agent 无法加载          | 一域一 skill 入口           |
| description 过空        | 永不触发                | 补场景与动词                |
| 把 US 写进 skill        | 污染长期知识            | US 走流水线产物             |
| 无禁区                  | Agent 直连 SDK/重复造轮 | anti-patterns 可判定条目    |

---

## 13. 最小示例骨架（可复制改名）

### `project-workflow/SKILL.md`（结构示意）

```markdown
---
name: project-workflow
description: 项目审批流开发与存量理解。基于公司 Flowable BPM SDK 与项目级 SPI。在新增审批流、实现提交审批驳回扩展点、阅读现有流程、做工作流影响分析或技术方案时使用。
---

# 定位
业务审批 = 平台流程定义 + 项目封装驱动 + 业务 SPI 实现。

# 分层
公司 BPM (Flowable) → 公司 SDK → 项目 workflow 门面与 SPI 调度 → 各业务 SPI 实现。

# 硬规则
1. 业务代码禁止直接依赖 Flowable Engine API；流程推进只走项目门面。
2. 新流必须实现 spi-catalog 中全部必选 SPI。
3. SPI 内禁止再次调用 submit/approve 造成重入。
4. 以本仓依赖锁定的 SDK/模块版本为准，禁止擅自升 major。

# 与图谱
理解存量时先按 processKey 查实现图，再按「读图协议」对照 spi-catalog；
全量实现类以图谱为准，不在本 skill 维护第二份清单。

# 任务路由
- 理解存量 → references/spi-catalog.md, existing-code-map.md + 图谱
- 新建审批流 → project-facade.md, spi-catalog.md, new-process-playbook.md, anti-patterns.md
- 评审 → spi-catalog.md, anti-patterns.md

# 入口
门面包与注册方式见 references/project-facade.md。
```

`references/` 按第 6 节逐项补全即可。

---

## 14. 总结

| 维度     | 结论                                                 |
| -------- | ---------------------------------------------------- |
| 机制     | 一目录一 skill；`SKILL.md` 必需；长文 `references/`  |
| 域       | 用单 skill + references 表达，不发明无入口的域文件夹 |
| 内容     | 规范、时序、必选扩展点、playbook、禁区、读图协议     |
| 图谱     | 管事实；Skill 管读法与合规；新建靠 playbook          |
| 多仓     | 索引 + 版本化 skill + 按需源码，不整仓灌上下文       |
| 成功标准 | 触发准、加载省、能判对错、能按步骤新建、可随版本维护 |

按本文落地，Skill 会成为 Agent 的**稳定操作合同**，而不是又一份易过期的设计说明复印件。若下一步需要，可在本规范下只针对 `project-workflow` 生成一整套可填空的 `references` 正文模板（接口名留占位符）。