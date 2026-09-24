import { loadConfig } from './src/config.js';
import { createApp } from './src/app.js';

const config = loadConfig();
const { app, close } = createApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`🏙️  MyCity est en ligne sur ${config.baseUrl}`);
  console.log(
    config.stripeSecretKey
      ? '💳 Paiements Stripe activés.'
      : '🧪 Mode démo : aucun STRIPE_SECRET_KEY, les achats sont simulés.',
  );
});

function shutdown() {
  console.log('Arrêt en cours…');
  server.close(() => {
    close();
    process.exit(0);
  });
  server.closeAllConnections?.();
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
