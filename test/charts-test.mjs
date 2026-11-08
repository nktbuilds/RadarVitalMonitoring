globalThis.ResizeObserver = class { constructor() {} observe() {} };
globalThis.window = { devicePixelRatio: 1 };
const ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
const canvas = {
  getContext: () => ctx,
  parentElement: null,
  style: {},
  clientHeight: 190,
  width: 0,
  height: 0,
  getBoundingClientRect: () => ({ width: 400, height: 190 }),
};
const { BarChart, LineChart } = await import('../source/js/charts.js');
const b = new BarChart(canvas);
b.setData([1, 2, 3, 4]);
const l = new LineChart(canvas);
l.setData([1, 2, 3, 4]);
l.setData([], {});
console.log('charts constructed and drew without error');
