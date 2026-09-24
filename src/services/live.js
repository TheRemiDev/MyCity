// Hub Server-Sent Events : présence en direct, fil d'activité et mises à jour de la carte.

export function createLiveHub({ heartbeatMs = 25_000 } = {}) {
  const clients = new Set();
  let lastOnline = -1;

  function send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function onlineCount() {
    return new Set([...clients].map((c) => c.visitor)).size;
  }

  function broadcastPresence() {
    const online = onlineCount();
    if (online === lastOnline) return;
    lastOnline = online;
    broadcast('presence', { online });
  }

  function broadcast(event, data) {
    for (const client of clients) {
      try {
        send(client.res, event, data);
      } catch {
        clients.delete(client);
      }
    }
  }

  const timer = setInterval(() => {
    for (const client of clients) client.res.write(': ping\n\n');
  }, heartbeatMs);
  timer.unref();

  return {
    attach(req, res, { visitor, userId }) {
      // Garde-fous : pas plus de 8 flux par visiteur ni de 5000 au total.
      let mine = 0;
      for (const c of clients) if (c.visitor === visitor) mine++;
      if (mine >= 8 || clients.size >= 5000) {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30' });
        res.end('Trop de connexions temps réel.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 4000\n\n');
      const client = { res, visitor, userId };
      clients.add(client);
      send(res, 'presence', { online: onlineCount() });
      broadcastPresence();
      req.on('close', () => {
        clients.delete(client);
        broadcastPresence();
      });
    },
    broadcast,
    onlineCount,
    close() {
      clearInterval(timer);
      for (const client of clients) client.res.end();
      clients.clear();
    },
  };
}
