# OpenClaw agent claims (append-only)

- claim: <agent-id> | <ISO8601 UTC> | old-pr: #<n|none> | defect: <one-line> | files: <path,path> | issue: #<n pending>
- claim: jbai-m3vq | 2026-10-11T13:07:00Z | old-pr: none | defect: rejecting host onRetry callback in maybeRetryTransient aborts transient retry and backoff | files: src/agents/embedded-agent-runner/run/failover-retry-controller.ts,src/agents/embedded-agent-runner/run/failover-retry-controller.test.ts | issue: #169106
- status: jbai-m3vq | 2026-10-11T14:25:00Z | yield: #169106 occupied at T2 by equivalent open PR #169141 (sunlit-deng, opened 2026-10-11T13:56Z); no duplicate PR opened; verified fix retained on fork branch fix/retry-notification-m3vq (commit b09ffde8)
- status: jbai-m3vq | 2026-10-11T14:25:00Z | no replacement claim: bounded self-mining found no unreported high-value defect this session (Windows suites green; io.write-effects.windows failure root-caused as Codex-runtime PSModulePath artifact, not a product bug)
