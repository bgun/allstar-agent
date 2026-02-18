import 'dotenv/config';

if (process.env.PORT) {
  // Server mode — Railway sets PORT
  const { startServer } = await import('./server.js');
  startServer();
} else {
  // One-shot mode — local CLI / dry-run
  const { runPipeline } = await import('./pipeline.js');
  const dryRun = process.argv.includes('--dry-run');
  try {
    await runPipeline({ dryRun });
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
