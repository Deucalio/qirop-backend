import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';

const app = createApp();

const server = app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`🚀 Qirop backend listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

/*
 * Production traffic arrives through Vercel's /api rewrite, which keeps a pool
 * of connections to this server and reuses them. Node's default is to drop a
 * connection after 5s idle; when that close didn't reach Vercel, it sent the
 * next request down a dead connection, waited its full 30s and answered 502 —
 * roughly every other request, worst when moving between pages. Holding idle
 * connections well past any proxy's reuse window means the proxy, never this
 * server, is the side that closes them.
 *
 * headersTimeout must exceed keepAliveTimeout, or a request arriving on a
 * connection near the end of its idle window can be cut off mid-headers.
 */
server.keepAliveTimeout = 120_000;
server.headersTimeout = 121_000;

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received — shutting down gracefully...`);
  server.close(() => {
    // eslint-disable-next-line no-console
    console.log('HTTP server closed.');
  });
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
