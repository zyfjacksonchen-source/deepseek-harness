# Agent Note: 跨 owner kind 任务准入

Status: implemented

[English](2026-08-25-cross-owner-kind-job-admission.md) | 中文

## 问题

现有 `maxConcurrentJobsPerOwner` 策略能正确约束每个确切 Agent，但无法表达由无关 Session 共享的生产方资源。两个父 Agent 都可能通过各自的桶，并发启动同一种高成本生产方。若在产品插件内用模块级全局标志、Promise tail 或私有队列串行化这些工作，就会重复 Job 生命周期，并在重载或销毁期间丢失确切 owner 取消语义。

部分生产方会在 Job 结算时释放稀缺资源，而外围 child Agent 的 dispose 可能更晚完成，甚至失败。等待 child 生命周期会在权威生产方资源已经释放后继续占用容量。

## 决策

`JobRegistry` 提供 `startWhenAvailable(spec, signal?)`；普通校验与每 owner 准入注册真实 Job 后，该方法立即返回 `{ id, admitted: Promise<void> }`。原来的确切 Agent 在等待期间就是 Job owner，因此现有访问、kill、read、通知与清理约定会在生产方执行前生效。`run()` 返回且钩子安装完成后，`admitted` 会 resolve；生产方 `done` 仍负责另一次独立的终态结算。

`LocalJobRegistry` 只延迟 `run()`。每 kind FIFO 只保存 JobId，而每个权威 `TrackedTask` 都携带私有的 waiting、started 或 settled phase 以及全部准入 Promise 状态。等待 Job 对外是 `running`，没有生产方钩子或执行资源，并计入其确切 owner 的普通上限。每个 kind 最多保留 64 个等待项；系统先检查 owner 上限，再在分配 id 或执行生产方前拒绝第 65 个等待项。Job 终态结算会提交记录、发布可见集变化，然后在完成监听器可能唤醒 owner 前排出下一个 id。生产方 fiber、child Agent 或 child dispose Promise 都不能释放或占住该 lane。

调用方的 AbortSignal 与原生 `kill` 只会取消仍在等待的 Job：系统从 FIFO 移除其 id、把记录以 `killed` 结算、拒绝 `admitted`，且不调用 `run()`。确切 owner dispose 与服务 dispose 会对每个匹配的等待项执行同样操作，并在 teardown 返回前结算所有准入 Promise。同步启动器抛错会拒绝 `admitted`、把已经分配的 Job 以 `failed` 结算，并让下一个 FIFO id 尝试已释放的 lane。首次结算优先语义会阻止迟到的生产方结果或重复取消再次释放 lane 或重复通知。

普通 `start()` 保持同步、立即且不排队。它观察同一批 Job 记录，但不加入 FIFO，因此需要这项产品级上限的生产方必须把受限 kind 的每一次启动都路由到 `startWhenAvailable()`，并观察 `admitted`。lane 容量固定为 1，直到某个有测量依据的消费方证明需要更宽的原生约定；本次改动不增加优先级、重试、持久化、持久队列、通用调度器或公开 Job 状态。

## 验证

Service Definition 测试固定同步句柄与 `Promise<void>` 屏障。进程内 Service Provider 测试使用由真实 `Session` 支撑的父 Agent，固定立即原生可见性、排队 kill 与 abort 的终态、跨 owner FIFO 顺序、仅终态释放、owner 范围内的访问权限、不同 kind 独立、owner 与服务 teardown 的 Promise 结算、同步启动器失败保留已分配 id、首次结算优先释放、owner 上限优先级，以及在不分配 id 或执行生产方的前提下拒绝第 65 个等待项。真实 Cordis Loader 组合会加载 Service Provider 配置行，并证明两个父 Session 不能同时启动同一种生产方。

## 曾考虑的替代方案

**保留产品插件的全局 boolean、Promise tail 或私有队列。**否决，因为这会在 `JobRegistry` 之外创建第二个生命周期 owner；重载、owner dispose 与服务 dispose 都可能让锁滞留，或在其 Agent 已消失后准入工作。

**使用 `maxConcurrentJobsPerOwner: 1`。**否决，因为两个竞争父对象是不同的确切 Agent，按设计属于不同桶。把现有策略改成一个进程级 owner 桶，会让一个无关生产方拒绝其他所有 Job kind 与 Session。

**等待外围 child Agent dispose。**否决，因为 Job 的 `done` 结算才是生产方资源已经完全停稳的权威。挂起的 child 清理不能占住已经释放的图片或 Provider 槽位。

**增加带可配置并行度、优先级与重试的通用调度器。**否决，因为当前需求恰好是让一个显式选择的 kind 使用 1 个 FIFO 槽位。没有测量或消费方约定能证明需要更多调度词汇。

## 后果

两个无关 owner 可以共享一个稀缺生产方 lane，同时保留普通 Job owner 语义，且不增加产品局部调度器。等待 Job 会有意通过现有 Job API 保持可见，而不增加公开 waiting 状态；调用方可以立即使用其 id，只在生产方启动时机重要时等待 `admitted`。普通 `start()` 按设计可绕过显式选择的 lane，因此集成覆盖必须证明受限 kind 的每个生产方入口都使用新方法。等待 Job 只存在于进程本地，并通过普通生命周期 teardown 结算，而不是持久化或回放。
