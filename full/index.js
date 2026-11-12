import marketDefinition from '../src/index.js';
import { NaturalVoiceWorld } from '../src/world.js';
import * as bubbleSync from './pet-sync.js';
import { subscribeStoreAppend } from './store-subscription.js';

export class FullNaturalVoiceWorld extends NaturalVoiceWorld {
  unsubscribeStore = null;

  constructor(context, options) {
    super(context, { ...options, bubbleSync });
  }

  async start(host) {
    await super.start(host);
    this.unsubscribeStore = subscribeStoreAppend(host.store, () => {
      try {
        this.poll();
      } catch (error) {
        this.report(error);
      }
    });
  }

  async stop() {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    await super.stop();
  }
}

export default {
  ...marketDefinition,
  create: context => new FullNaturalVoiceWorld(context),
};
