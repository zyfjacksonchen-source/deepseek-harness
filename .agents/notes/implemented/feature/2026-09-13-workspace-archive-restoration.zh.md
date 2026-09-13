# Agent Note: 通过 Workspace 所有者恢复已归档会话

Status: implemented

[English](2026-09-13-workspace-archive-restoration.md) | 中文

## Problem

Workspace 注册表保存已归档 Session 的身份及其原有项目归属，但公开操作只有 `archiveSession`。产品即使在升级后保留旧会话字节，用户仍可能找不到会话。绕过注册表直接修改 storage-domain 状态会与其串行变更竞争，也会绕过重连投影流。

## Decision

`WorkspaceRegistry.unarchiveSession(id)` 通过注册表的操作链，仅从持久归档集合中移除一个身份。Workspace 的 `sessionIds`、顺序、Session 日志和附件保持不变。已可见且已知的会话重复恢复时不写入；未知身份报错。[Workspace Remote 所有者](../../../../packages/api/workspace-controller/src/index.ts) 暴露同一操作，返回完整归档集合，并发布正常的 `archived` follow 增量。Client Workspace 模型仅在没有更新的归档请求或 follow 帧覆盖结果时安装 Host 确认的结果。

所有者不会在启动时自动取消归档。UI 必须响应用户的明确操作才调用恢复。

## Alternatives considered

**从产品插件直接修改 storage-domain JSON。** 这会绕过注册表的串行写入及投影流所有权，并可能丢失并发的归档或项目变更。

**迁移时自动恢复所有历史会话。** 这会改动用户的归档选择，并让其主动隐藏的会话重新出现。

## Consequences

产品可以提供恢复控件，而无需移动或改写历史会话数据。相同归档投影会更新当前客户端和重连客户端。新增 Remote 方法属于 pinned Client/Host 契约，因此产品必须交付两端匹配的版本。注册表与 Remote 测试覆盖定向恢复、重启后的持久性、项目归属不变、未知身份和 follow 更新。
