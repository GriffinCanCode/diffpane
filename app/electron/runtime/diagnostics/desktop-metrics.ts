import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { app } from 'electron'
import type { ProcessMetric } from 'electron'
import type { createDiagnostics } from '../../../shared/diagnostics/diagnostics.ts'
import { attempt } from '../../../shared/recovery/app-errors.ts'

const sampleIntervalMs = 30_000
const processGroups = ['main', 'renderer', 'gpu', 'other'] as const

function processGroup(type: ProcessMetric['type']): (typeof processGroups)[number] {
  if (type === 'Browser') return 'main'
  if (type === 'Tab') return 'renderer'
  if (type === 'GPU') return 'gpu'
  return 'other'
}

function sampleProcesses(diagnostics: ReturnType<typeof createDiagnostics>, includeCpu: boolean) {
  const empty = { count: 0, workingSetBytes: 0, cpuPercent: 0 }
  const totals = { main: { ...empty }, renderer: { ...empty }, gpu: { ...empty }, other: { ...empty } }
  for (const { type, memory, cpu } of app.getAppMetrics()) {
    const total = totals[processGroup(type)]
    total.count += 1
    total.workingSetBytes += memory.workingSetSize * 1_024
    total.cpuPercent += cpu.percentCPUUsage
  }
  for (const group of processGroups) {
    const total = totals[group]
    diagnostics.metric(`desktop.process.${group}.count`, total.count, 'count')
    diagnostics.metric(`desktop.process.${group}.working-set`, total.workingSetBytes, 'bytes')
    if (includeCpu) diagnostics.metric(`desktop.process.${group}.cpu`, total.cpuPercent, 'percent')
  }
}

export function startDesktopMetrics(diagnostics: ReturnType<typeof createDiagnostics>): () => void {
  const eventLoop = attempt(() => {
    const utilization = performance.eventLoopUtilization()
    const delay = monitorEventLoopDelay({ resolution: 50 })
    delay.enable()
    return { delay, utilization }
  })
  if (!eventLoop.ok) diagnostics.error('desktop.main.event-loop.sample', eventLoop.error)

  let processSampled = false
  const timer = setInterval(() => {
    if (eventLoop.ok) {
      const { delay, utilization } = eventLoop.value
      const sampled = attempt(() => {
        const next = performance.eventLoopUtilization()
        const { utilization: fraction } = performance.eventLoopUtilization(next, utilization)
        eventLoop.value.utilization = next
        const delayP95Ms = delay.count ? delay.percentile(95) / 1_000_000 : undefined
        const delayMaxMs = delay.max / 1_000_000
        delay.reset()
        diagnostics.metric('desktop.main.event-loop.utilization', fraction * 100, 'percent')
        if (delayP95Ms !== undefined) {
          diagnostics.metric('desktop.main.event-loop.delay-p95', delayP95Ms, 'ms')
          diagnostics.metric('desktop.main.event-loop.delay-max', delayMaxMs, 'ms')
        }
      })
      if (!sampled.ok) diagnostics.error('desktop.main.event-loop.sample', sampled.error)
    }

    const sampled = attempt(() => sampleProcesses(diagnostics, processSampled))
    if (sampled.ok) processSampled = true
    else diagnostics.error('desktop.process.sample', sampled.error)
  }, sampleIntervalMs).unref()

  return () => {
    clearInterval(timer)
    if (eventLoop.ok) eventLoop.value.delay.disable()
  }
}
