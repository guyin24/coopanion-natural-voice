import { DEFAULTS } from './config.js';
import { NaturalVoiceWorld } from './world.js';
import {TONE_TOOL} from './delivery.js';

export const NATURAL_VOICE = {
  id: 'natural-voice', label: '自然语音',
  defaults: () => ({ ...DEFAULTS }),
  create: context => new NaturalVoiceWorld(context),
  describe: { tools: [TONE_TOOL], events: [] },
};

export default NATURAL_VOICE;
