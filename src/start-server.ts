#!/usr/bin/env node

import { serve } from '@hono/node-server';

import app from './index';
import { createNodeWebSocket } from '@hono/node-ws';
import { realTimeHandlerNode } from './handlers/realtimeHandlerNode';
import { requestValidator } from './middlewares/requestValidator';
import { closePostgresPool } from './db/postgres/connection';
import { closeRedisClient } from './db/redis';
import { SpendQueue } from './services/spendQueue';

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

// Loading animation function
async function showLoadingAnimation() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;

  return new Promise((resolve) => {
    const interval = setInterval(() => {
      process.stdout.write(`\r${frames[i]} Starting AI Gateway...`);
      i = (i + 1) % frames.length;
    }, 80);

    // Stop after 1 second
    setTimeout(() => {
      clearInterval(interval);
      process.stdout.write('\r');
      resolve(undefined);
    }, 1000);
  });
}

// Clear the console and show animation before main output
console.clear();
await showLoadingAnimation();

// Main server information with minimal spacing
console.log('\x1b[1m%s\x1b[0m', '🚀 Your AI Gateway is running at:');
console.log('   ' + '\x1b[1;4;32m%s\x1b[0m', `${url}`);

// Start the spend queue processor
SpendQueue.getInstance().startSpendProcessor();

// Single-line ready message
console.log('\n\x1b[32m✨ Ready for connections!\x1b[0m');

// Graceful shutdown
async function gracefulShutdown() {
  try {
    SpendQueue.getInstance().stopSpendProcessor();
    await Promise.all([closePostgresPool(), closeRedisClient()]);
  } catch (error) {
    console.error(error);
  }
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
