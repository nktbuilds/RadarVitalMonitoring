# Radar Vital Monitoring

Companion code for the video: https://youtu.be/zZ-v6Gz_YCc

A browser-based breathing and heart-rate monitor for the SparkFun XM125
(Acconeer A121, 60 GHz radar). The page configures the radar over Web Serial,
streams Sparse IQ data, and estimates breathing and heart rate from the phase
of the reflected signal. Everything runs in the browser, with no build step and
no server-side code.

## Requirements

- Chrome or Edge (Web Serial)
- SparkFun XM125 over USB
- Python 3, only to serve the files locally

## Run

```bash
cd source
python3 -m http.server 8000
```

Open http://localhost:8000 in Chrome or Edge.

Web Serial only works in a secure context. `http://localhost` counts; a LAN or
WSL IP does not.

Click **Demo** to try the UI without hardware. Click **Connect**, pick the XM125
serial port, and start streaming.

## Tests

```bash
node test/run-all.mjs
```

## Notes and limitations

- Breathing rate works well for a seated, still subject.
- Heart rate is conditional: it works seated and still, but is not reliable
  while standing or after exercise, where body sway and breathing harmonics
  dominate the chest motion.
- Aim the radar at the sternum from about 0.3 to 0.6 m and check the target
  distance readout.
- The Acconeer SDK and documentation are not included in this repository.

## License

MIT. See [LICENSE](LICENSE).
