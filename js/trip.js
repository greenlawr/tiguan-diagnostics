// Fuel economy and trip recording.
//
// Preferred source is OBD PID 0x5E (engine fuel rate, litres/hour). If the car
// does not provide it, we estimate from mass air flow (PID 0x10) assuming a
// petrol air:fuel ratio — less exact, but good enough to compare journeys.

export const FUEL = {
  petrolDensity: 745, // g/L
  afr: 14.7, // stoichiometric air:fuel for petrol
  ukGallon: 4.54609, // litres
  mile: 1.609344, // km
};

/** PID 0x5E data bytes -> litres/hour. */
export const fuelRateFrom5E = (d) => (d[0] * 256 + d[1]) / 20;

/** Mass air flow (g/s) -> estimated litres/hour of petrol. */
export const fuelRateFromMaf = (mafGps) => (mafGps / FUEL.afr / FUEL.petrolDensity) * 3600;

/** Miles per UK gallon from a speed (km/h) and fuel rate (L/h). 0 when stationary or cut off. */
export const mpgUk = (speedKmh, fuelLph) =>
  fuelLph > 0 && speedKmh > 0 ? (speedKmh / fuelLph) * (FUEL.ukGallon / FUEL.mile) : 0;

/** Accumulates distance, fuel and samples over a journey. */
export class Trip {
  constructor() {
    this.distanceKm = 0;
    this.fuelL = 0;
    this.seconds = 0;
    this.maxSpeedKmh = 0;
    this.samples = []; // { t, speedKmh, mpg }
  }

  /** Add one reading taken `dt` seconds after the previous. */
  add(speedKmh, fuelLph, dt) {
    if (!(dt > 0) || dt > 30) return; // ignore gaps (phone asleep, lost link)
    this.seconds += dt;
    this.distanceKm += speedKmh * (dt / 3600);
    if (fuelLph != null) this.fuelL += fuelLph * (dt / 3600);
    if (speedKmh > this.maxSpeedKmh) this.maxSpeedKmh = speedKmh;
    this.samples.push({ t: this.seconds, speedKmh, mpg: mpgUk(speedKmh, fuelLph ?? 0) });
    if (this.samples.length > 1200) this.samples.shift();
  }

  get miles() {
    return this.distanceKm / FUEL.mile;
  }
  get gallons() {
    return this.fuelL / FUEL.ukGallon;
  }
  get avgMpg() {
    return this.gallons > 0 ? this.miles / this.gallons : 0;
  }
  get avgSpeedKmh() {
    return this.seconds > 0 ? this.distanceKm / (this.seconds / 3600) : 0;
  }
  get litresPer100km() {
    return this.distanceKm > 0 ? (this.fuelL / this.distanceKm) * 100 : 0;
  }

  summary() {
    return {
      date: new Date().toISOString(),
      seconds: Math.round(this.seconds),
      distanceKm: this.distanceKm,
      miles: this.miles,
      fuelL: this.fuelL,
      avgMpg: this.avgMpg,
      avgSpeedKmh: this.avgSpeedKmh,
      maxSpeedKmh: this.maxSpeedKmh,
      litresPer100km: this.litresPer100km,
    };
  }
}
