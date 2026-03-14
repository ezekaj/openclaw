import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startEventLoopMonitor,
  stopEventLoopMonitor,
  getEventLoopLagMs,
  getEventLoopStats,
  resetEventLoopStats,
  type EventLoopStats,
  type EventLoopMonitorOptions,
} from "./event-loop-lag.js";

describe("event-loop-lag", () => {
  beforeEach(() => {
    resetEventLoopStats();
  });

  afterEach(() => {
    stopEventLoopMonitor();
  });

  it("should return 0 lag before monitoring starts", () => {
    expect(getEventLoopLagMs()).toBe(0);
  });

  it("should return initial stats", () => {
    const stats = getEventLoopStats();
    expect(stats.currentLagMs).toBe(0);
    expect(stats.peakLagMs).toBe(0);
    expect(stats.avgLagMs).toBe(0);
    expect(stats.sampleCount).toBe(0);
    expect(stats.status).toBe("ok");
  });

  it("should start and stop monitoring", () => {
    startEventLoopMonitor();
    // Should not throw
    stopEventLoopMonitor();
  });

  it("should accept options with onWarning callback", () => {
    const warnings: number[] = [];
    const opts: EventLoopMonitorOptions = {
      onWarning: (lagMs) => warnings.push(lagMs),
    };
    startEventLoopMonitor(opts);
    // Should not throw
    stopEventLoopMonitor();
  });

  it("should reset stats", () => {
    startEventLoopMonitor();
    stopEventLoopMonitor();
    resetEventLoopStats();

    const stats = getEventLoopStats();
    expect(stats.currentLagMs).toBe(0);
    expect(stats.peakLagMs).toBe(0);
    expect(stats.sampleCount).toBe(0);
  });

  it("should return EventLoopStats type", () => {
    const stats: EventLoopStats = getEventLoopStats();
    expect(typeof stats.currentLagMs).toBe("number");
    expect(typeof stats.peakLagMs).toBe("number");
    expect(typeof stats.avgLagMs).toBe("number");
    expect(typeof stats.sampleCount).toBe("number");
    expect(["ok", "warn", "critical"]).toContain(stats.status);
  });
});
