# Tiguan Diagnostics

A phone web app that talks to a 2017 VW Tiguan through a Bluetooth OBD-II adapter. No build step, no dependencies, no account, and nothing leaves your phone.

## What it does

Designed for someone who is not a mechanic. Four tabs:

| Tab | What you get |
| --- | --- |
| Check | One button, **Check my car**. Reads the engine warning light, battery, every fault code and every reachable VW control module, then gives a colour-coded verdict. Each fault explains what it means, whether you can keep driving, what to do, and a rough cost guide with a link to live part prices. **"What's changed"** compares each check to the last one. Reports can be shared with a garage and the last 12 are kept on the phone. Also a **My car & MOT** card: store your registration and MOT due date for a countdown, with links to the free official gov.uk MOT/tax checks and a one-tap calendar reminder. |
| Live | Live sensor readings, each with a one-line explanation and a "Normal" / "Running hot" style judgement where one makes sense. |
| Trips | Record a journey and see distance, speed and **real-world fuel economy (mpg)** with live speed and economy graphs. Past trips are saved on the phone. |
| Help | Getting started, **text size**, what the colours mean, **Google Maps on the car screen (Android Auto)**, map and software updates, **an "Android Auto isn't working" check** (with a dealer-ready unit summary), turning off the warning light, a glossary and the technical log. |

It also **remembers your adapter** for one-tap reconnection, and installs to your home screen like a normal app.

Everything except "Turn off warning light" is read-only.

## What you need

1. **An Android phone with Chrome.** (iPhone Safari has no Web Bluetooth.)
2. **A Bluetooth LE (BLE) OBD-II adapter.** A web page cannot use "classic" Bluetooth or WiFi adapters, so check the listing says BLE / Bluetooth 4.0+.
   - Best: **OBDLink CX**. A real STN chip, reliable with the per-module VW scan.
   - Cheaper: **Vgate iCar Pro BLE 4.0** or **Veepeak OBDCheck BLE**.
   - Avoid unbranded "ELM327 v2.1" clones. They usually manage the Faults and Live tabs but often fail the Modules scan.
3. **The app served over HTTPS** (a browser requirement for Bluetooth). See "Install on your phone" below.

## Install on your phone

The app is a PWA: once it's on an `https://` address, Chrome on Android offers **"Install app / Add to Home screen"**, after which it has its own icon, opens full-screen, and works offline.

Recommended hosting (keeps everything else private): put these files in their **own public GitHub repo** and turn on Pages.

1. Create a new **public** repo, e.g. `tiguan-diagnostics` (no README).
2. Copy the contents of this folder to the repo **root** (so `index.html` is at the top).
3. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
4. After a minute it's live at `https://<your-username>.github.io/tiguan-diagnostics/`. Open that in Chrome on Android and tap Install.

Alternatives: **Netlify** or **Cloudflare Pages** can serve a private repo's folder for free without making anything public. For development: `npm start` and open `http://localhost:8080` (localhost is exempt from the HTTPS rule).

## Using it

1. Plug the adapter into the OBD port: under the dashboard on the driver's side, above the pedals.
2. Ignition on (engine can be off or running).
3. Open the app, tap **Connect to my car**, pick the adapter from the list, then tap **Check my car**.

No adapter yet? Tap **Try a demo car** to explore with a simulated vehicle.

## Updating the car's software

This app deliberately does not flash anything.

- **Control modules (engine, gearbox, ABS...)**: firmware is signed by VW and only distributed through the dealer system (ODIS). Flashing over a consumer Bluetooth adapter risks leaving a module dead. Use the Modules tab to note your current software versions, then ask a dealer or VW specialist whether a newer one exists for your part number.
- **Built-in maps**: for Discover Media systems VW has offered map downloads you copy to the SD card yourself. No diagnostic tool is needed.
- **Google Maps on the car screen**: use Android Auto (VW "App-Connect") over USB. The OBD port cannot send anything to the screen. Steps are in the app's Help tab.

## Why Android Auto may not work, and what this app can do

Enabling App-Connect (Android Auto) **cannot be done from this app, or any basic coding tool.** It needs a signed activation code (FEC/SWaP) tied to your specific head unit, plus security access to the module — neither of which a web page can legitimately perform. Attempting coding writes without them is refused by the car and risks the unit.

What the app does instead (Help tab → "Android Auto isn't working — why?") is **read-only**: it reads your touchscreen unit's part number and software, then walks you through a short checklist to place you in one of four cases — hardware not fitted, hardware present but not activated (needs a specialist/coder), a coding/software issue, or simply the cable/USB port. That tells you whether a specialist is needed and what to tell them, so you don't pay for the wrong fix.

## Part costs

Each fault shows a **rough UK cost guide** and a **"check current prices"** link that opens live shopping listings for that part on a 2017 Tiguan. The app has no server or price feed, so it cannot show real-time average prices itself: the built-in figures are ballparks for a sense of scale, and the link is where the real, current number comes from. Figures vary by supplier, genuine-vs-aftermarket, and whether labour is included.

## Limits to know about

- The module scan uses the commonly documented VW Group CAN addresses. It has been tested against the built-in simulator, not yet against a real car. If a system you expect is missing, copy the technical log (Help tab) and adjust `js/vw.js`.
- Cost guides are rough ballparks, not quotes. Detailed advice covers common fault families. Other codes get general advice for the part of the car that reported them, plus a lookup link. Severity ratings are guidance, not a substitute for a mechanic.
- "Turn off warning light" only clears engine/gearbox (standard OBD) faults, and resets the emissions monitors.
- The app does **not** fetch live MOT/tax data (the gov.uk APIs need a key and can't be called from a browser). It stores a reminder and links you to the official free checks.
- Fuel economy uses the car's fuel-rate reading where available, otherwise estimates from air-flow assuming petrol — treat it as a consistent comparison between trips, not a precise figure.

## Development

```
npm test    # protocol tests, including an end-to-end run against the simulated car
npm start   # serve on http://localhost:8080
```

| File | Role |
| --- | --- |
| `js/ble.js` | Web Bluetooth serial link to the adapter |
| `js/elm.js` | ELM327 command queue and CAN addressing |
| `js/isotp.js` | Reassembles multi-frame CAN answers |
| `js/obd.js`, `js/pids.js`, `js/dtc.js` | Standard OBD-II services, live values, code descriptions |
| `js/vw.js` | VW module table and UDS identification / fault reads |
| `js/explain.js` | Plain-English advice and severity for faults and battery voltage |
| `js/report.js` | The health check, plus the change-since-last-check diff |
| `js/trip.js` | Fuel-economy maths and trip recording |
| `js/vehicle.js` | MOT countdown, gov.uk links, calendar reminder |
| `js/appconnect.js` | Read-only "why isn't Android Auto working?" diagnosis |
| `js/simulator.js` | Pretend adapter and car for the demo mode and tests |
