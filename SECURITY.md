# Security Policy / 安全策略

## Supported versions / 支持版本

Only the latest published `0.11.x` receives security fixes. 仅最新已发布的 `0.11.x` 会收到安全修复。

## Reporting a vulnerability / 报告漏洞

**Do not open a public issue for security problems.** 请勿在公开 issue 报告安全问题。

Use GitHub's private vulnerability reporting (Security tab → Report a vulnerability) on this repository, or contact the maintainer directly (@kenz1117). You will get an acknowledgement within 7 days. 可用仓库 Security 页的私密漏洞报告，或直接联系维护者；7 天内确认。

## What this plugin handles / 本插件接触的数据

Worth knowing before you report — this plugin:

- ingests **full session content** (user and assistant text) into local SQLite databases under `~/.dsh/engram/`;
- renders that content in the panel (loopback HTTP, see below);
- optionally calls external LLM endpoints (the judge "Jev", remote embedders) with content you configured it to send.

Secrets are redacted before storage (`src/security/redact.ts` — PEM/Bearer/`sk-`/`ghp_`/AKIA patterns, locale-specific labelled rules, plus your own deny-list in config). The panel defaults to loopback HTTP with peer/Host checks and write actions further gated by Origin/Content-Type. Optional `panelAccess: 'lan'` deliberately grants read/write access to the trusted private network; it does not provide user authentication and must not be exposed to untrusted networks. Jev endpoint overrides are restricted to the configured provider's origin before host credentials are attached.

## In scope / 范围

- Anything that lets panel content or stored memories escape the machine without explicit user configuration;
- secret redaction bypasses;
- path traversal in backup/restore or mirror export;
- the loopback API's write-path authentication (peer/origin checks).

## Out of scope / 不在范围

- Issues requiring a malicious DSH host or a compromised machine (the host already owns the session);
- SSRF via admin-level config files (`cordis.yml`) — whoever writes those already controls the process.
