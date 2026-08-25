# Agent Note：工具注册来源跟随可见的注册表 winner

Status: implemented

[English](2026-08-25-tool-registration-provenance.md) | 中文

## 问题

host 消费方需要识别某个 agent 实际可见的工具由哪个已配置插件注册。工具名称不是身份：第三方全局注册、预设作用域内的第一方注册和 agent-local 遮蔽都可以使用同一个名称。扫描 Loader entry、按名称猜测，或比较全局与作用域定义，都无法在限制、HMR 和 teardown 后区分可见 winner。把来源加入 `ToolDefinition` 还会让 host 组合元数据与面向模型的 schema 并列，容易被带入提示词或会话边界。

## 决策

`ToolRuntime.provenance(name, scope?)` 返回注册表现有可见性视图所解析工具 entry 在注册时的 `{ moduleSpecifier, pluginName }`。`register()` 只读取调用方 Cordis fiber。当该 fiber 具有 Loader 拥有的 `entry` 时，它把 `fiber.entry.options.name` 与 `fiber.name` 复制成冻结快照，与 `ToolDefinition` 一起存放在同一个 `NamedEntries` value 中。没有 Entry 的 fiber 不记录来源。

定义和来源共用一次注册表插入以及现有 `ScopedLayers.effect` 的精确 teardown。限制、祖先遮蔽、精确作用域遮蔽、HMR 替换和 dispose 因此总会一起选择或移除二者。查询绝不会扫描 Loader 状态、接受调用方提供的元数据、维护第二个注册表，也不会在可见 winner 没有来源时回退到隐藏注册。复制只在注册时发生一次，因此 Loader Entry 后续的修改或替换无法改变已经返回的身份。

该 seam 只供 host 使用。`schemas()`、系统提示词组装、工具执行、持久事件和会话协议类型仍只投影已有白名单字段。注册仅增加一次常数时间的可选 Entry 读取，普通模型请求组装不执行来源发现，从而保持正常的 time-to-first-token 路径。

## 备选方案

**扫描 Loader 树或根据工具／插件名称推断软件包。** 被否：注册所有权不是命名约定，HMR 后的 Loader 状态也不能证明哪个定义赢得注册表视图。

**接受注册调用方提供的来源，或把来源加入 `ToolDefinition`。** 被否：调用方可以冒充其他模块，且 host 组合身份不属于面向模型的定义约定。

**维护第二份来源 map，或比较全局与作用域定义。** 被否：第二套生命周期可能与工具 entry 漂移，而且全局／作用域相等性无法识别祖先或精确作用域 winner。

**暴露可变 Loader Entry 或 Cordis Fiber。** 被否：这会使只读 seam 随时间漂移，并暴露超出所需两个字符串的 host 能力。

## 后果

host 可以检查精确的可见注册来源，而无需改变模型或会话协议。作用域内的第一方工具会胜过同名的第三方全局工具；限制会返回 `undefined`；agent-local winner 会报告自身有 Loader 证据的作用域 fiber，没有 Loader 证据时则返回 `undefined`；HMR 与 teardown 会移除退役 winner，而非保留其身份。Loader 之外的直接编程式注册有意不作归因。来源是组合证据，不是签名、权限决定或软件包真实性保证。

该约定由核心注册表测试覆盖全局／作用域直接注册、限制、dispose 和 fiber HMR，并由真实 shipped Web/base/standard 组合覆盖平台选择的 `bash`/`pwsh`、`web_search`、第三方全局遮蔽、agent-local 遮蔽、Loader HMR 快照稳定性和移除。生成的 Cordis/Typert 目录保持公共类型与方法同步。
