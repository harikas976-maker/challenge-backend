const buildApp = require('./app');
const listenMock = require('../mock-server');

async function start() {
  const app = buildApp({ logger: true });
  listenMock();
  app.addHook('onClose', async () => listenMock.close());
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      app.close().catch(error => { app.log.error(error); process.exitCode = 1; });
    });
  }
  try {
    await app.listen({ port: 3000, host: 'localhost' });
  } catch (error) {
    app.log.error(error);
    await app.close();
    process.exitCode = 1;
  }
}

if (require.main === module) {
  start().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { start };
