# Agent Note: 跨 owner kind 任务准入

Status: implemented

[English](2026-08-25-cross-owner-kind-job-admission.md) | 中文

## 问题

现有 `maxConcurrentJobsPerOwner` 策略能正确约束每个确切 Agent，但无法表达由无关 Session 共享的生产方资源。两个父 Agent 都可能通过各自的桶，并发启动同一种高成本生产方。若在产品插件内用模块级全局标志、Promise tail 或私有队列串行化这些工作，就会重复 Job 生命周期，并在重载或销毁期间丢失确切 owner 取消语义。

部分生产方会在 Job 结算时释放稀缺资源，而外围 child Agent 的 dispose 可能更晚完成，甚至失败。等待 child 生命周期会在权威生产方资源已经释放后继续占用容量。

## 决策

`JobRegistry` 提供 `startWhenAvailable(spec, signal?)`，`LocalJobRegistry` 将它实现为按 `JobStart.kind` 分组、显式选择的进程级 FIFO。该 lane 在所有 owner 之间只准入 1 个活动 Job。准入后仍通过普通 `start()` 路径创建 Job，因此原来的确切 Agent 继续作为 owner，现有访问、kill、read、通知与清理约定都保持不变。

等待中的请求没有 Job id、快照、生产方执行资源或第二份活动计数。进程内 Service Provider 只保留请求，并从权威的 `running` 与 `stopping` Job 记录派生占用。终止 `JobHooks.done` 结算会提交记录、发布可见集变化，然后在完成监听器可能唤醒 owner 前排出下一项请求。生产方 fiber、child Agent 或 child dispose Promise 都不能释放或占住该 lane。

调用方的 AbortSignal 只会取消仍在排队的请求。确切 owner dispose 会先拒绝该 owner 的等待请求，再取消其已启动 Job。服务 dispose 会同步关闭准入，先拒绝所有等待请求，再取消并等待已启动 Job。每次拒绝都发生在 `run()` 与 id 分配前；已准入的启动方若抛出异常，其请求会被拒绝，下一项 FIFO 请求可以继续尝试仍为空闲的 lane。

普通 `start()` 保持同步、立即且不排队。它观察同一批 Job 记录，但不加入 FIFO，因此需要这项产品级上限的生产方必须把受限 kind 的每一次启动都路由到 `startWhenAvailable()`。lane 容量固定为 1，直到某个有测量依据的消费方证明需要更宽的原生约定；本次改动不增加优先级、重试、持久化、持久队列、通用调度器或公开 Job 状态。

## 验证

Service Definition 测试固定 Promise API。进程内 Service Provider 测试使用由真实 `Session` 支撑的父 Agent，固定跨 owner FIFO 顺序、仅终态释放、owner 范围内的 get 与 kill 权限、中止不执行生产方且不分配 id、排队 owner dispose、启动方失败后继续推进，以及有界服务销毁。真实 Cordis Loader 组合会加载 Service Provider 配置行，并证明两个父 Session 不能同时进入同一种生产方。

## 曾考虑的替代方案

**保留产品插件的全局 boolean、Promise tail 或私有队列。**否决，因为这会在 `JobRegistry` 之外创建第二个生命周期 owner；重载、owner dispose 与服务 dispose 都可能让锁滞留，或在其 Agent 已消失后准入工作。

**使用 `maxConcurrentJobsPerOwner: 1`。**否决，因为两个竞争父对象是不同的确切 Agent，按设计属于不同桶。把现有策略改成一个进程级 owner 桶，会让一个无关生产方拒绝其他所有 Job kind 与 Session。

**等待外围 child Agent dispose。**否决，因为 Job 的 `done` 结算才是生产方资源已经完全停稳的权威。挂起的 child 清理不能占住已经释放的图片或 Provider 槽位。

**增加带可配置并行度、优先级与重试的通用调度器。**否决，因为当前需求恰好是让一个显式选择的 kind 使用 1 个 FIFO 槽位。没有测量或消费方约定能证明需要更多调度词汇。

## 后果

两个无关 owner 可以共享一个稀缺生产方 lane，同时保留普通 Job owner 语义，且不增加产品局部调度器。排队请求有意不显示为 Job；调用方会继续展示现有队列或 child-task 状态，直到准入返回 id。普通 `start()` 按设计可绕过显式选择的 lane，因此集成覆盖必须证明受限 kind 的每个生产方入口都使用新 seam。排队请求只存在于进程本地，并在 teardown 时通过显式拒绝消失，而不是持久化或回放。
