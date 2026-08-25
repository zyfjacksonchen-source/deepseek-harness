# @deepseek-ai/dsh-user-questions

[English](README.md) | 中文

用户交互 Service Definition。它定义 `ctx.userQuestions`，供面向模型的工具或权限插件在需要暂停工作并询问人类决定时使用。

## 服务：`UserQuestionService`（ctx 键：`userQuestions`）

### 公开 API

- `ctx.userQuestions.registerProvider(provider): () => void` 注册 UI 侧提供方。同一上下文中只能有一个活跃提供方；dispose（资源释放）会将其注销。
- `ctx.userQuestions.ask(request): Promise<AskUserQuestionAnswer>` 向活跃提供方提问并等待回答。

### 关键类型

- `AskUserQuestionRequest`：`{ questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }], agent?, signal? }`；`detail` 提供辅助文本，提供方会将其随问题一起渲染，而不会将其变成选项标签。如提供 `agent`，它必须与注册表中的存活运行时根 agent（智能体）是同一对象。
- `AskUserQuestionOption`：`{ label, description? }`。
- `AskUserQuestionIntent`：`{ kind: 'plan-review', approve }` 或 `{ kind: 'image-review', approve, sources, output }`；即下文的带标签呈现意图。
- `AskUserQuestionAnswer`：`{ answers: [{ id, selected, custom? }] }`。
- `UserQuestionProvider`：包含 `ask(request)` 的 UI 实现。
- `UserQuestionError`：`HarnessError` 的子类，包含 `EMPTY_QUESTIONS`、`BAD_INTENT`、`NO_PROVIDER`、`DUPLICATE_PROVIDER`、`ASK_ABORTED`、`CALLER_NOT_LIVE` 和 `DELEGATED_CALLER` 等代码。

对于单选题，`custom` 会覆盖选中的选项，且 `selected` 为空。对于多选题，`custom` 可以补充 `selected` 中的标签。UI 可以把跳过的条目保留为 `{ id, selected: [] }`，既维持现有回答形态，也保留该批次中的其他回答。

请求包含 agent 时，`ask()` 会通过当前 `AgentRegistry` 验证该 agent 与注册表中的存活实例是同一对象，并且只允许运行时根调用。持久谱系不构成权限依据：带有历史委托深度的会话恢复为新的运行时根后可以提问；归属于另一个 agent 的存活子级即使持久化记录的委托深度为零也会被拒绝。不含 agent 的程序化请求继续沿用现有提供方路径。

### 呈现意图

`intent` 声明某个问题本身就是一种已知决策，因此认识该标签的 UI 可以照此呈现。`plan-review` 表示 `detail` 是一份待审阅的计划，`dsh-plan-mode` 会在 `exit_plan_mode` 的问题上设置它。`image-review` 携带一至十六个不可变、经会话授权的源图引用与一个不可变候选图引用，使有能力的 UI 能在启用确认前展示证据。意图只改变呈现：遵循它的 UI 回答的仍是通用 UI 会发送的那些选项标签，不认识该标签的 UI 渲染通用选项列表，因此调用方两种情况下读到的回答字段相同。`approve` 指名表示批准的标签，而不依赖选项顺序。若批准标签未命中问题选项、意图没有 `detail`，或图片审核的附件集为空、超限、可变或格式错误，`ask()` 会以 `BAD_INTENT` 拒绝。

## 职责

这是 Service Definition 包。`@deepseek-ai/dsh-tool-ask-user` 等 Consumer 依赖此服务；Web 宿主运行时提供随产品交付的 Service Provider。循环保持不变：工具调用等待 Promise，工具结果随后恢复正常的 agent loop（智能体循环）。

## 模型体验

间接地，通过 `dsh-tool-ask-user`：它会将成功的提供方回答保留为紧凑 JSON，或返回以下失败之一：`Error: ask_user_question was aborted before the user answered`、`Error: ask_user_question requires at least one question`、`Error: human interaction requires the exact live calling agent when an agent is supplied`、`Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result`、`Error: no user-questions provider is registered` 或 `Error: <message>`。等待人类回答不会增加 token。

#### KV Cache 影响

不会直接使 KV Cache 失效；请求前缀的任何变更均由上述消费方负责。

## 已知限制与暂缓事项

- **每个上下文只能有一个提供方**：不支持路由或扇出到多个 UI；第二次注册会抛出 `DUPLICATE_PROVIDER`，未注册任何提供方时，`ask()` 会抛出 `NO_PROVIDER`，而不会降级。
- **证据由调用方负责**：`image-review` 传递不可变图片引用，但自身不执行视觉或语义验证；该决策的持久化后果仍由发起它的 Job 负责。
