heartbeatV2Command
  .command("analytics <agentId>")
  .description("Show analytics for an agent")
  .option("-t, --time-range <range>", "Time range (1h, 24h, 7d, 30d)", "24h")
  .action(async (agentId: string, options) => {
    try {
      const scheduler = getHeartbeatScheduler();

      if (!scheduler) {
        console.error("Heartbeat V2 system is not running");
        process.exit(1);
      }

      const validRanges = ["1h", "24h", "7d", "30d"] as const;
      const timeRange = validRanges.includes(options.timeRange as any)
        ? (options.timeRange as typeof validRanges[number])
        : "24h";

      const analytics = await scheduler.getAnalytics(agentId, timeRange);

      if (!analytics) {
        console.log(`No analytics data for agent "${agentId}"`);
        return;
      }

      console.log(`\n📈 Heartbeat Analytics for "${agentId}" (${timeRange})\n`);
      console.log(`  Total runs: ${analytics.totalRuns}`);
      console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  ✅ OK:       ${analytics.okCount.toString().padStart(5)}`);
      console.log(`  ⚠️  Alerts:   ${analytics.alertCount.toString().padStart(5)}`);
      console.log(`  ⏭️  Skipped:  ${analytics.skippedCount.toString().padStart(5)}`);
      console.log(`  ❌ Errors:   ${analytics.errorCount.toString().padStart(5)}`);
      console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  Avg duration:    ${analytics.avgDurationMs.toFixed(0)}ms`);
      console.log(`  P95 duration:    ${analytics.p95DurationMs.toFixed(0)}ms`);
      console.log(`  Avg interval:    ${(analytics.avgIntervalMs / 60000).toFixed(1)}m`);
      console.log(`  Max consec fail: ${analytics.maxConsecutiveFailures}`);
    } catch (err) {
      console.error("Error getting analytics:", err);
      process.exit(1);
    }
  });