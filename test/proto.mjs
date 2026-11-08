import { buildSetupCommand, commands, classifyMessage } from '../source/js/protocol.js';
import { validateConfig, DEFAULTS } from '../source/js/config.js';
console.log('setup cmd:', new TextDecoder().decode(buildSetupCommand(DEFAULTS)));
console.log('sysinfo  :', new TextDecoder().decode(commands.getSystemInfo()));
console.log('validate :', validateConfig(DEFAULTS));
const msg = classifyMessage({ result_info: [[{tick:1}]], payload_size: 60 }, new Uint8Array(60));
console.log('classify result:', msg.type);
const bad = classifyMessage({ status:'error', message:'boom' }, null);
console.log('classify error :', bad.type, bad.data);
