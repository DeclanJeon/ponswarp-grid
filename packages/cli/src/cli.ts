#!/usr/bin/env node
import { createSignalingHttpServer } from '@ponswarp/signaling/server';
import { CliUsageError, parseCliArgs, usage } from './index.js';
import { runJoin, runSend } from './cli-runtime.js';

async function main(argv: readonly string[]): Promise<number> {
  const command = parseCliArgs(argv);
  switch (command.command) {
    case 'help':
      console.log(usage());
      return 0;
    case 'version':
      console.log('0.1.0');
      return 0;
    case 'serve-signal': {
      await runServeSignal(command.host, command.port);
      return 0;
    }
    case 'send':
      await runSend(command);
      return 0;
    case 'join':
      return runJoin(command);
    case 'status':
    case 'clean':
      throw new CliUsageError(`${command.command} session management is scheduled under the current Ultragoal story sequence`);
  }
}

async function runServeSignal(host: string, port: number): Promise<never> {
  const server = createSignalingHttpServer({ config: { host, port } });
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close();
  };
  process.once('SIGINT', () => { void close().finally(() => process.exit(130)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(143)); });
  await server.listen();
  console.log(`PonsWarp signaling server listening on ${host}:${port}`);
  return new Promise(() => undefined);
}

main(process.argv.slice(2)).then(code => {
  if (code !== 0) process.exitCode = code;
}).catch(error => {
  if (error instanceof CliUsageError) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
