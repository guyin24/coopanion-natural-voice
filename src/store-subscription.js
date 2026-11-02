const appendSubscriptions = new WeakMap();

export function subscribeStoreAppend(store, callback) {
  if (typeof store?.onAppend !== 'function') return null;
  const subscriber = { callback };
  let hub = appendSubscriptions.get(store);
  if (hub) {
    hub.subscribers.add(subscriber);
  } else {
    hub = { subscribers: new Set([subscriber]), dispose: null };
    appendSubscriptions.set(store, hub);
    try {
      const disposal = store.onAppend(event => {
        for (const active of hub.subscribers) {
          try { active.callback?.(event); } catch {}
        }
      });
      if (typeof disposal === 'function') hub.dispose = disposal;
      else if (typeof disposal?.dispose === 'function') hub.dispose = () => disposal.dispose();
    } catch (error) {
      appendSubscriptions.delete(store);
      hub.subscribers.clear();
      throw error;
    }
  }

  return () => {
    if (!subscriber.callback) return;
    subscriber.callback = null;
    hub.subscribers.delete(subscriber);
    // The host's void-return API cannot detach its listener. Keep its empty hub
    // for reuse without keeping any stopped World's callback or context alive.
    if (hub.subscribers.size === 0 && hub.dispose) {
      const dispose = hub.dispose;
      hub.dispose = null;
      appendSubscriptions.delete(store);
      dispose();
    }
  };
}
