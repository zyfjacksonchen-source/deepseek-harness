# @deepseek-ai/dsh-jobs-local

[English](README.md) | 中文

[`@deepseek-ai/dsh-jobs`](../jobs/README.md) 注册表约定的进程本地实现：`LocalJobRegistry` 把每条记录保存在内存中，按 kind 签发 `<kind>-N` id，并且只交出全新快照，从不交出实时状态。作为插件加载后即注册为 `ctx.jobs`。

## 准入

`maxConcurrentJobsPerOwner` 必须是正的安全整数，默认值为 `10`。调用生产方之前，`start()` 会统计确切 owner 的 `running` 与 `stopping` 记录；所有无 owner 任务共享另一个独立的服务级桶。终止历史不占用容量，处于 `stopping` 的任务只有在生产方 `done` 结算后才释放名额。

达到容量时，`start()` 会在生产方执行和 id 分配前失败；错误会给出上限，并告诉模型使用 `job_kill`、等待任务完全停稳后再重试。这条立即执行路径不会排队或抢占任务，也不会维护第二份可变计数。

`startWhenAvailable()` 是另一条显式选择的准入路径，供需要在所有 owner 之间限制同一 kind 只能有 1 个已启动生产方的生产方使用。它先应用普通的每 owner 活跃 Job 上限，再立即分配并发布真实且限定 owner 作用域的 Job，并返回 `{ id, admitted: Promise<void> }`。等待记录对外保持 `running`，支持原生读取与取消 API，且在准入前没有生产方钩子或执行资源。每 kind FIFO 只保存这些记录的 JobId；每个 Job 的私有 `TrackedTask` phase 持有启动器和 Promise 结算。FIFO 最多保留 64 个等待 Job，因此第 65 个等待项会在分配 id 或执行生产方前失败。Job 终态结算会释放 lane。等待期间的 abort、kill、确切 owner dispose 与服务 dispose 会让 Job 以 `killed` 结算并 reject `admitted`；同步启动器抛错会让已分配的 Job 以 `failed` 结算并 reject `admitted`。普通 `start()` 保持同步并可绕过该 lane，因此受限 kind 的每个生产方都必须使用此方法并观察 `admitted`。

## 生命周期

任务属于其所有者和后端，而不是生产方工具 fiber，因此重载生产方或控制器不会停止任务。某个所有者的第一个任务会把一个会被等待的 effect 附加到对应 `Agent` 对象的 scope 上。所有者的 dispose（资源释放）会终止取消该对象的等待任务、取消其已启动任务、结算每个准入 Promise、等待生产方完全停稳，并移除其快照；复用的 agent（智能体）id 或会话 id 无法重定向旧的清理操作。

服务 dispose 会关闭监听器、取消所有存活任务、等待其记录完成，并从仍存活的所有者 scope 中分离 effect。如果销毁期间的取消操作抛出异常，服务会强制将记录标为失败，并警告工作可能成为孤立工作，而不会死锁。取消操作已返回但 `done` 始终未结算时，系统无法将其与缓慢停止区分开，销毁过程可能因此停滞。

结算遵循首次结算优先原则：最早出现的终止结果（生产方结算、作为 `failed` 隔离处理的 `done` 拒绝，或销毁时的强制失败）只记录一次，随后释放等待方，再只通知监听器一次；各监听器的故障会单独隔离。挂起的等待会在监听器运行前把任务标记为已报告，因此完成报告方不会重复发出通知；销毁时的取消出于同样的理由也会标记：面向正在被销毁的所有者的通知不会有人读到。完成是一次结算最后才宣布的事情，排在记录提交与可见集变更发布之后，因为报告方可能同步开启一个模型轮次，而该结算的其他所有观察者都必须已经看到已结算的记录。

控制器与监听器按注册方所在的 scope 分层，形状与 tools 注册表一致：一次注册归档到其注册上下文的 scope，一次读取则把全局层与所有者的 scope 链求并集。因此一个进程级注册表能逐所有者地回答逐所有者的问题——对自身组合未附加任何控制器的所有者，无论其他组合附加了多少，`start()` 都会拒绝并抛出 `background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)`；一次结算也只会抵达其所有者所属组合注册的监听器。

## 模型体验

通过生产方插件和 [`dsh-tool-jobs`](../tool-jobs/README.md) 间接影响；它们会呈现 job id、输出、状态、取消和完成通知。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **任务只存在于进程本地**：记录会随 harness 进程终止而消失；持久或跨重启执行需要一个单独实现该 seam 的后端。
- **静默无效的取消可能使销毁过程停滞并持续占用容量**：如果 `cancel` 返回后始终未结算 `done`，注册表就无法将其与缓慢停止区分开；该任务会在服务剩余生命周期内持续占用一个桶名额，只有显式抛出异常才能安全地强制标为失败。
- **按 kind 的 FIFO 容量固定为 1**：当前没有消费方用测量证明原生 lane 应当更宽。提高该值需要具体结果，并且仍须让 Job 记录作为活动数量的唯一权威。
