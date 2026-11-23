// Web Bluetooth transport for Bluetooth LE (BLE) OBD adapters.
// Web Bluetooth cannot talk to "classic" Bluetooth adapters, only BLE ones.

const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

// Serial-over-BLE services used by common adapters (OBDLink CX, Vgate iCar Pro
// BLE, Veepeak BLE and generic ELM327 BLE clones).
const SERVICES = [
  uuid16(0xfff0),
  uuid16(0xffe0),
  uuid16(0x18f0),
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
];

export const bluetoothSupported = () => typeof navigator !== 'undefined' && 'bluetooth' in navigator;

/** Adapters this browser has already been given permission to use, if any. */
export async function rememberedAdapters() {
  try {
    if (!bluetoothSupported() || !navigator.bluetooth.getDevices) return [];
    return await navigator.bluetooth.getDevices();
  } catch {
    return [];
  }
}

export class BleTransport {
  constructor({ remembered = false } = {}) {
    this.remembered = remembered;
    this.onData = () => {};
    this.onClose = () => {};
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
  }

  async open() {
    let device;
    if (this.remembered) {
      device = (await rememberedAdapters())[0];
      if (!device) throw new Error('No remembered adapter to reconnect to.');
    } else {
      device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    }
    return this._use(device);
  }

  async _use(device) {
    this.device = device;
    this.device.addEventListener('gattserverdisconnected', () => this.onClose());
    const server = await this.device.gatt.connect();

    let notify = null;
    let write = null;
    for (const service of await server.getPrimaryServices()) {
      const chars = await service.getCharacteristics();
      const n = chars.find((c) => c.properties.notify || c.properties.indicate);
      const w = chars.find((c) => c.properties.writeWithoutResponse) || chars.find((c) => c.properties.write);
      if (n && w) {
        notify = n;
        write = w;
        break;
      }
    }
    if (!notify || !write) {
      this.device.gatt.disconnect();
      throw new Error(
        'This device does not look like a supported BLE OBD adapter. ' +
          'Classic-Bluetooth adapters cannot be used from a web page.'
      );
    }

    this.writeChar = write;
    this.withoutResponse = write.properties.writeWithoutResponse;
    notify.addEventListener('characteristicvaluechanged', (e) => {
      this.onData(this.decoder.decode(e.target.value));
    });
    await notify.startNotifications();
    this.name = this.device.name || 'OBD adapter';
  }

  async write(text) {
    const bytes = this.encoder.encode(text);
    for (let i = 0; i < bytes.length; i += 20) {
      const chunk = bytes.slice(i, i + 20);
      if (this.withoutResponse) await this.writeChar.writeValueWithoutResponse(chunk);
      else await this.writeChar.writeValueWithResponse(chunk);
    }
  }

  async close() {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }
}
