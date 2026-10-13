---
doc_radar:
  sentinels:
    - file: tests/k6/workload.ts
      contains: ['constant-vus', 'vus: 10', 'max<100000000', 'p(95)<100']
    - file: tests/k6/run.ts
      contains: ['sampleMemory', 'armObserver', 'rename', 'latest']
---

# Desktop load testing with k6

Install Grafana k6 2.3 or newer (`brew install k6` on macOS), then `npm ci`.
The workloads and harness are TypeScript; k6 runs locally without a Grafana account.

```sh
npm run test:k6:smoke       # 2,000 files, 4,000 lines, 10 agents for 10 seconds
npm run test:k6             # 50,000 files, 30,000 lines, 10 agents for 60 seconds
npm run test:k6:soak        # same scale for 10 minutes
npm run test:k6:languages   # 50,000 files, real TypeScript language server, 60 seconds
npm run check:k6            # strict TypeScript checking for harness and workload
```

All profiles launch the production Electron renderer in a temporary Git repository
and isolated app profile. They never write to your checkout. k6 uses ten constant
virtual users, each owning separate paths. An iteration performs 32 concurrent
tracked-file edits, creates a file in a new folder, renames that folder, then
deletes it. Agent 1 also atomically replaces the open document. Each virtual user
waits for its previous operation to finish, so creation, movement and deletion
are individually observed rather than coalesced away. The explorer is filtered
to the agents' paths so all ten files fit in its visible viewport.

A loopback-only, token-protected harness translates k6 requests into filesystem
operations. Playwright observes the actual app. Latency starts when the filesystem
write completes and ends after the expected DOM state survives two animation
frames. This includes an opportunity to paint plus IPC transport overhead; it is
not a guarantee about pixels reaching a physical display. Creation requires the
new row, movement requires the new row and absence of the old row, and deletion
requires a previously observed row to disappear. Editor latency is measured for
agent 1, the file the user is viewing. The other nine agents provide concurrent
background load; their invisible editor contents are not assigned invented
rendering latency. After the load, every edited file is verified through the real
document API. One editor model and a bounded explorer DOM are also asserted.

The default scale/soak profiles use plain text to isolate filesystem and UI costs.
The languages profile opens TypeScript and requires its server to reach `ready`.
No profile disables a production feature or changes the app's visuals. These are
defined workloads, not proof of an absolute memory bound for every repository or
all language servers.

## Budgets and reports

The test exits unsuccessfully for any update error, missing correctness check,
per-operation p95 latency of 100 ms or more, p99 of 200 ms or more, a one-second
maximum update, or sampled total memory of 100,000,000 bytes or more (decimal MB).
The 100 MB threshold is fixed; it is not silently increased for Electron.

Memory is the sum of RSS for the app PID and its complete descendant process
tree, including Chromium renderers, GPU/utility processes, worker isolates, Git,
and language servers. Samples run every 100 ms without overlapping. The harness
and k6 are excluded. RSS can count shared pages more than once, and a subprocess
peak shorter than the sampling interval can be missed. It is explicitly not the
JavaScript heap alone, Activity Monitor's physical footprint, or a claim that an
unobserved instantaneous peak stayed below the limit.

Reports are under `test-results/k6-PROFILE/`: `summary.json` contains k6 metrics and
threshold decisions, `process-memory.json` contains whole-app samples and the
process breakdown at the peak, `ui.json` contains model/DOM/frame statistics,
and `before.png`/`after.png` show the real window. Failure reports are retained.
The memory report includes the production renderer bundle's SHA-256.
`process-memory.json` also covers final document verification, which happens
after k6's teardown sample. A memory failure makes both the k6 workload and the
driver fail; a failure during final verification makes the driver fail too.

Use `DIFFPANE_K6_FILES` (400–100,000), `DIFFPANE_K6_DURATION` (a k6 duration), and
`DIFFPANE_K6_PAUSE` (seconds between operations) to change the load. `K6_BIN` selects
a k6 executable. Reports record the configuration and k6 version. The pause
defaults to 0.05 seconds. Since this is a closed workload, slow updates reduce
throughput; compare operation counts as well as latency between runs. Ten VUs
are scheduling clients of the harness, not ten independent operating-system
agent processes.

The manual **Desktop load budgets** GitHub Actions workflow uses pinned k6 2.3.0,
runs the selected profile on macOS, and uploads reports even when budgets fail.
The current Electron architecture exceeds 100 MB: a successful functionality
check must not be presented as a successful memory check.
