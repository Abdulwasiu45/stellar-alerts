import { Command } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { resolveAuth } from '../lib/auth.js';
import { connectDashboardSocket } from '../lib/dashboard-socket.js';
import { fetchDashboardMetrics } from '../lib/metrics-client.js';
import TopTui from '../tui/top-tui.js';

interface TopOptions {
  token?: string;
}

export function registerTopCommand(program: Command): void {
  program
    .command('top')
    .description('Interactive terminal dashboard: live payment ingestion rate, queue latency, and memory usage')
    .option('-t, --token <token>', 'API authentication token (overrides profile)')
    .action((options: TopOptions) => {
      const auth = resolveAuth(options.token, program.opts().apiUrl);

      const { unmount } = render(
        createElement(TopTui, {
          connectFeed: (handlers) => connectDashboardSocket(auth.apiUrl, auth.token, handlers),
          onMetricsPoll: () => fetchDashboardMetrics(auth.apiUrl, auth.token),
          onQuit: () => unmount(),
        }),
      );
    });
}
