// Live readings (OBD service 01). `d` is the data bytes after the PID.
// `explain` says what the number is in everyday terms; `status` (optional)
// judges whether the value looks healthy.

const u16 = (d) => d[0] * 256 + d[1];
const pct = (d) => (d[0] * 100) / 255;
const trim = (d) => ((d[0] - 128) * 100) / 128;

const ok = (text = 'Normal') => ({ level: 'ok', text });
const info = (text) => ({ level: 'minor', text });
const bad = (text) => ({ level: 'urgent', text });
const warn = (text) => ({ level: 'soon', text });

const trimStatus = (v) => (Math.abs(v) <= 10 ? ok() : Math.abs(v) <= 20 ? info('Slightly off') : warn('Outside normal range'));

export const PIDS = [
  { pid: 0x0c, group: 'Engine', name: 'Engine speed', unit: 'rpm', digits: 0, calc: (d) => u16(d) / 4,
    explain: 'How fast the engine is spinning. Around 700 to 900 when idling.' },
  { pid: 0x0d, group: 'Engine', name: 'Road speed', unit: 'km/h', digits: 0, calc: (d) => d[0],
    explain: 'The speed the car thinks it is travelling.' },
  { pid: 0x04, group: 'Engine', name: 'Engine effort', unit: '%', digits: 0, calc: pct,
    explain: 'How hard the engine is working right now, out of its maximum.' },
  { pid: 0x11, group: 'Engine', name: 'Throttle opening', unit: '%', digits: 0, calc: pct,
    explain: 'How far open the engine\'s air valve is. Rises as you press the accelerator.' },

  { pid: 0x05, group: 'Temperatures', name: 'Engine coolant', unit: '°C', digits: 0, calc: (d) => d[0] - 40,
    explain: 'Engine temperature. Settles at about 85 to 100 once warmed up.',
    status: (v) => (v > 112 ? bad('Too hot. Stop when safe') : v > 105 ? warn('Running hot') : v < 70 ? info('Still warming up') : ok()) },
  { pid: 0x5c, group: 'Temperatures', name: 'Engine oil', unit: '°C', digits: 0, calc: (d) => d[0] - 40,
    explain: 'Oil temperature. Best to drive gently until this passes about 70.',
    status: (v) => (v > 135 ? bad('Too hot. Ease off') : v < 70 ? info('Still warming up') : ok()) },
  { pid: 0x0f, group: 'Temperatures', name: 'Air entering engine', unit: '°C', digits: 0, calc: (d) => d[0] - 40,
    explain: 'Temperature of the air being drawn into the engine.' },
  { pid: 0x46, group: 'Temperatures', name: 'Outside air', unit: '°C', digits: 0, calc: (d) => d[0] - 40,
    explain: 'Outside temperature as measured by the car.' },

  { pid: 0x2f, group: 'Fuel and air', name: 'Fuel in tank', unit: '%', digits: 0, calc: pct,
    explain: 'How full the fuel tank is.',
    status: (v) => (v < 10 ? info('Running low') : ok('OK')) },
  { pid: 0x06, group: 'Fuel and air', name: 'Fuel correction (right now)', unit: '%', digits: 1, calc: trim,
    explain: 'How much the engine is adding or removing fuel to keep the mix right. Close to zero is ideal.', status: trimStatus },
  { pid: 0x07, group: 'Fuel and air', name: 'Fuel correction (learned)', unit: '%', digits: 1, calc: trim,
    explain: 'The long-term version of the above. A big number suggests an air leak or fuel delivery issue.', status: trimStatus },
  { pid: 0x10, group: 'Fuel and air', name: 'Air flow into engine', unit: 'g/s', digits: 1, calc: (d) => u16(d) / 100,
    explain: 'How much air the engine is breathing in each second. Rises with speed and effort.' },
  { pid: 0x0b, group: 'Fuel and air', name: 'Intake pressure', unit: 'kPa', digits: 0, calc: (d) => d[0],
    explain: 'Air pressure inside the engine intake. Above about 100 means the turbo is boosting.' },
  { pid: 0x33, group: 'Fuel and air', name: 'Outside air pressure', unit: 'kPa', digits: 0, calc: (d) => d[0],
    explain: 'Atmospheric pressure. About 100 at sea level.' },
  { pid: 0x0e, group: 'Fuel and air', name: 'Spark timing', unit: '°', digits: 1, calc: (d) => d[0] / 2 - 64,
    explain: 'When the spark plugs fire relative to the piston. The engine adjusts this constantly.' },
  { pid: 0x5e, group: 'Fuel and air', name: 'Fuel use rate', unit: 'L/h', digits: 1, calc: (d) => (d[0] * 256 + d[1]) / 20,
    explain: 'How much fuel the engine is burning per hour right now. Used for the trip economy figures.' },

  { pid: 0x42, group: 'Electrical', name: 'System voltage', unit: 'V', digits: 1, calc: (d) => u16(d) / 1000,
    explain: 'Electrical voltage. About 12.5 with the engine off, 13 to 14.8 with it running.',
    status: (v) => (v > 15.1 ? warn('Too high') : v < 11.8 ? warn('Low') : ok()) },

  { pid: 0x1f, group: 'This trip', name: 'Engine running time', unit: 's', digits: 0, calc: u16,
    explain: 'Seconds since the engine was started.' },
  { pid: 0x21, group: 'This trip', name: 'Distance driven with warning light on', unit: 'km', digits: 0, calc: u16,
    explain: 'How far the car has been driven since the engine warning light came on.' },
  { pid: 0x31, group: 'This trip', name: 'Distance since faults were last cleared', unit: 'km', digits: 0, calc: u16,
    explain: 'How far the car has been driven since someone last reset the fault memory.' },
];
