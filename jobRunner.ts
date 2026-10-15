/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Background jobs (reminders, the leave-year rollover, ZKTeco sync, ride
// expiry, scheduled reports…) must run in ONE process only. Under PM2
// cluster mode (ecosystem.config.cjs) every worker runs this same server,
// and each would otherwise send every reminder once per worker and run
// every job several times at once.
//
//   PM2 cluster:      NODE_APP_INSTANCE is "0", "1", … — only "0" runs jobs.
//   Node's cluster:   only the first worker runs them.
//   One plain process (today's setup): runs them, exactly as before.
//
// RUN_BACKGROUND_JOBS=1 / =0 overrides this, e.g. to run the jobs in a
// separate process of their own.

import cluster from "node:cluster";

export function runsBackgroundJobs(): boolean {
  const forced = process.env.RUN_BACKGROUND_JOBS;
  if (forced === "1" || forced === "true") return true;
  if (forced === "0" || forced === "false") return false;
  const instance = process.env.NODE_APP_INSTANCE;
  if (instance !== undefined && instance !== "") return instance === "0";
  if (cluster.isWorker) return cluster.worker?.id === 1;
  return true;
}
