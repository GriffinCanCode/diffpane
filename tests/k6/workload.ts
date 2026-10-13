/* oxlint-disable no-undef -- k6 supplies __ENV, __VU and __ITER at runtime. */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import type { Options } from 'k6/options';

const latency = new Trend('visible_update_ms', true);
const writes = new Trend('filesystem_write_ms', true);
const memory = new Trend('app_rss_bytes');
const updates = new Counter('observed_updates');
const failures = new Rate('update_failures');
const url = __ENV.DIFFPANE_K6_URL;
const params = {
  headers: {
    Authorization: `Bearer ${__ENV.DIFFPANE_K6_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: '15s',
};

export const options: Options = {
  scenarios: {
    concurrent_agents: {
      executor: 'constant-vus',
      vus: 10,
      duration: __ENV.DIFFPANE_K6_DURATION || '60s',
      gracefulStop: '15s',
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    update_failures: ['rate==0'],
    observed_updates: ['count>=40'],
    'visible_update_ms{kind:edit}': ['p(95)<100', 'p(99)<200', 'max<1000'],
    'visible_update_ms{kind:create}': ['p(95)<100', 'p(99)<200', 'max<1000'],
    'visible_update_ms{kind:rename}': ['p(95)<100', 'p(99)<200', 'max<1000'],
    'visible_update_ms{kind:delete}': ['p(95)<100', 'p(99)<200', 'max<1000'],
    // Decimal MB. Never substitute JavaScript heap size or exclude helper processes.
    app_rss_bytes: ['max<100000000'],
  },
  summaryTrendStats: ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max', 'count'],
};

function recordMemory() {
  const response = http.get(`${url}/metrics`, params);
  if (!check(response, { 'memory sample available': response => response.status === 200 })) return;
  memory.add((response.json() as { peakRssBytes: number }).peakRssBytes);
}

export function setup() {
  recordMemory();
}
export function teardown() {
  recordMemory();
}

export default function () {
  // VUs own disjoint paths. Every operation waits for its prior state to be observed,
  // preventing a create/rename/delete sequence from being falsely counted as a save.
  for (const kind of ['edit', 'create', 'rename', 'delete']) {
    const response = http.post(
      `${url}/step`,
      JSON.stringify({ agent: __VU, iteration: __ITER, kind }),
      { ...params, tags: { agent: String(__VU), kind } },
    );
    const ok = check(response, {
      'filesystem step and visible probe succeeded': response => response.status === 200,
    });
    failures.add(!ok, { kind });
    if (ok) {
      const result = response.json() as {
        visibleMs: number | null;
        writeMs: number;
        peakRssBytes: number;
      };
      writes.add(result.writeMs, { kind });
      if (result.visibleMs !== null) {
        latency.add(result.visibleMs, { kind });
        updates.add(1, { kind });
      }
      memory.add(result.peakRssBytes);
    }
    sleep(Number(__ENV.DIFFPANE_K6_PAUSE || '0.05'));
  }
}

export function handleSummary(data: unknown) {
  const summary = data as {
    metrics: Record<
      string,
      { values: Record<string, number>; thresholds?: Record<string, { ok: boolean }> }
    >;
  };
  const lines = ['Diffpane: 10 concurrent agents, actual Electron UI', ''];
  for (const [name, metric] of Object.entries(summary.metrics)) {
    if (!metric.thresholds) continue;
    const passed = Object.values(metric.thresholds).every(threshold => threshold.ok);
    lines.push(`${passed ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(metric.values)}`);
  }
  return {
    [__ENV.DIFFPANE_K6_SUMMARY || 'test-results/k6-summary.json']: JSON.stringify(data, null, 2),
    stdout: `${lines.join('\n')}\n`,
  };
}
