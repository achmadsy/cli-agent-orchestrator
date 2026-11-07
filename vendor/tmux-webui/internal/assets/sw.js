// Reserved for a separately verified CAO PWA rollout. Baseline does not serve or
// register this worker. No cache deletion, fetch interception or terminal cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = new URL(self.registration.scope);
  const requested = new URL(event.notification.data?.url || './', scope);
  const destination = requested.origin === scope.origin && requested.pathname.startsWith(scope.pathname)
    ? requested.href : scope.href;
  event.waitUntil(self.clients.matchAll({type: 'window'}).then(windows => {
    const client = windows.find(item => item.url.startsWith(scope.href));
    if (client) return client.navigate(destination).then(() => client.focus());
    return self.clients.openWindow(destination);
  }));
});
