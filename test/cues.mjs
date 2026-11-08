import { Hysteresis, CUE_DELAY_MS } from '../source/js/cues.js';

// A brief blip must not flip the cue state.
const blip = new Hysteresis('ok', CUE_DELAY_MS);
blip.update('harm', 0);
const afterBlip = blip.update('ok', 100);
const blipOk = afterBlip === 'ok';

// A sustained change flips only after the full delay, and back again.
const s = new Hysteresis('ok', CUE_DELAY_MS);
s.update('harm', 0);
const before = s.update('harm', CUE_DELAY_MS - 1);
const at = s.update('harm', CUE_DELAY_MS);
const backEarly = s.update('ok', CUE_DELAY_MS + 10);
const backAt = s.update('ok', CUE_DELAY_MS + 10 + CUE_DELAY_MS);
const sustainOk = before === 'ok' && at === 'harm' && backEarly === 'harm' && backAt === 'ok';

// reset clears the pending transition.
const r = new Hysteresis('ok', CUE_DELAY_MS);
r.update('harm', 0);
r.reset('none');
const resetOk = r.value === 'none' && r.update('harm', 500) === 'none';

console.log(`blip ignored: ${blipOk} | sustained flip: ${sustainOk} | reset: ${resetOk}`);
const ok = blipOk && sustainOk && resetOk;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
