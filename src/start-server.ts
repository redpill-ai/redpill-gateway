#!/usr/bin/env node

import { serve } from '@hono/node-server';

import app from './index';
import { createNodeWebSocket } from '@hono/node-ws';
import { realTimeHandlerNode } from './handlers/realtimeHandlerNode';
import { requestValidator } from './middlewares/requestValidator';
import { closePostgresPool } from './db/postgres/connection';
import { closeRedisClient } from './db/redis';
import { SpendQueue } from './services/spendQueue';
import { RequestLogQueue } from './services/requestLogQueue';
// MetricsAggregator is ON ICE during data-collection phase. Uncomment
// the import + start/stop calls below once we decide to enable
// metric-driven routing (see virtualKeyValidator for the matching
// switch-on instructions).
// import { MetricsAggregator } from './services/metricsAggregator';

// Extract the port number from the command line arguments
const defaultPort = 8787;
const args = process.argv.slice(2);
const portArg = args.find((arg) => arg.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1]) : defaultPort;

// Static file serving removed - no longer serving index.html

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get(
  '/v1/realtime',
  requestValidator,
  upgradeWebSocket(realTimeHandlerNode)
);

const server = serve({
  fetch: app.fetch,
  port: port,
});

const url = `http://localhost:${port}`;

injectWebSocket(server);

// Main server information
console.log('\x1b[1m%s\x1b[0m', '🚀 Gateway is running at:');
console.log('   ' + '\x1b[1;4;32m%s\x1b[0m', `${url}`);

// Start the spend queue processor
SpendQueue.getInstance().startSpendProcessor();

// Start the request log queue processor (per-request observability sink)
RequestLogQueue.getInstance().startProcessor();

// Start the 24h metrics aggregator (ClickHouse → Redis, every 10 min)
// MetricsAggregator.getInstance().start();

// Ready message
console.log('\n\x1b[32m✨ Ready for connections!\x1b[0m');

// Graceful shutdown
async function gracefulShutdown() {
  try {
    SpendQueue.getInstance().stopSpendProcessor();
    RequestLogQueue.getInstance().stopProcessor();
    // MetricsAggregator.getInstance().stop();
    await Promise.all([closePostgresPool(), closeRedisClient()]);
  } catch (error) {
    console.error(error);
  }
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
