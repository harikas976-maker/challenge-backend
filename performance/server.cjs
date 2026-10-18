// A fresh real application and mock instance, bound to a free loopback port.
const buildApp = require('../services/app');
const listenMock = require('../mock-server');

async function main() {
  const app = buildApp({ logger: true });
  listenMock();
  app.addHook('onClose', async () => listenMock.close());
  process.on('message', async message => {
    if (message === 'stop') {
      await app.close();
      process.disconnect();
    }
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  process.send({ port: app.server.address().port });
}
main().catch(error => { console.error(error); process.exit(1); });
