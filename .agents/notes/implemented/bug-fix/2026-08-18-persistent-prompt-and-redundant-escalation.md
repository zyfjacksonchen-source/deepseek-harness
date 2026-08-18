# Agent Note: Persistent prompt identity and redundant sandbox targets

Status: implemented

English | [中文](2026-08-18-persistent-prompt-and-redundant-escalation.zh.md)

## Problem

`terminal-bash` accepted `dsh> ` as its controlled printable prompt while `tool-bash-persistent` configured Bash with `__DSH_PERSISTENT_BASH_PROMPT__ `. The byte mismatch prevented prompt readiness from settling and left each persistent command on the silence fallback. Separately, model calls sometimes repeated the current `sandbox_permissions`; the tools treated that non-widening target as a failed escalation even though the standing policy already authorized the command.

## Decision

`terminal-bash` now uses the persistent tool's exact 31-byte prompt, including its trailing space. Existing terminal tests lock the same printable value. Bash and PowerShell tools classify a requested target equal to or below the standing mode as redundant: they execute under the standing policy without approval. Only a strictly wider valid target reaches the existing fail-closed `approveEscalation` path; no-sandbox compositions, malformed modes, unavailable approval, rejection, and cancellation remain errors.

## Consequences

Prompt readiness can settle from the private marker instead of waiting for the silence fallback. Redundant permission fields no longer turn an already-authorized command into a tool error or approval prompt. They also do not create a per-call downgrade: the command retains the standing policy, while every actual widening keeps the existing approval and fail-closed behavior. The prompt remains a duplicated private literal across two packages, with both test suites and the byte comparison guarding drift.

## Alternatives considered

- **Export the prompt from one package and add a runtime dependency from the other.** Rejected because one private marker does not justify coupling the terminal backend to a model-facing tool package.
- **Keep rejecting equal or narrower targets.** Rejected because the model's redundant field does not request additional authority and should not block a command the user has already authorized through the standing policy.
- **Treat a narrower target as a per-call downgrade.** Rejected because the current executor contract does not promise that override; silently claiming narrower confinement would be false.

## Verification

- Byte comparison reports identical UTF-8 hex `5f5f4453485f50455253495354454e545f424153485f50524f4d50545f5f20` and length 31 for both constants.
- Terminal, persistent Bash, Bash, PowerShell, and sandbox-escalation suites cover prompt readiness, redundant targets, true widening, malformed input, and missing sandbox composition.
- Real persistent Bash latency is measured with the same process-backed commands before and after the prompt change on macOS and Linux.
