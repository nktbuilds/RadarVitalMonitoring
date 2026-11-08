import { describePortInfo } from '../source/js/config.js';
console.log(describePortInfo({ usbVendorId: 0x1a86, usbProductId: 0x7523 }));
console.log(describePortInfo({ usbVendorId: 0x10c4, usbProductId: 0xea60 }));
console.log(describePortInfo({ usbVendorId: 0x0483, usbProductId: 0xa42d }));
console.log(describePortInfo({}));
