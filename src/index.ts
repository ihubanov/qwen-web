import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main() {
  const config = loadConfig();
  const server = await buildServer(config);
  try {
    await server.listen({ port: config.port, host: config.host });
    server.log.info(
      { port: config.port, host: config.host },
      'qwen-web listening',
    );
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
