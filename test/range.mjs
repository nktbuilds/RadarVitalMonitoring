import { computeRangeWindow, VITALS_PRESET, HELP, isValidStepLength } from '../source/js/config.js';
console.log('preset window:', computeRangeWindow(VITALS_PRESET));
console.log('default window:', computeRangeWindow({startPoint:80,numPoints:15,stepLength:8}));
console.log('bad step 5:', computeRangeWindow({startPoint:80,numPoints:15,stepLength:5}).valid);
console.log('valid steps:', [1,2,3,4,5,6,7,8,12,24].map(s=>[s,isValidStepLength(s)]).filter(x=>x[1]).map(x=>x[0]).join(','));
console.log('help keys:', Object.keys(HELP).join(','));
