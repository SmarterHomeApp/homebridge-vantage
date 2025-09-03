// src/platformAccessory.ts
import type { PlatformAccessory, Service, Characteristic } from 'homebridge';
import type { VantageDevice } from './types';
import { VantagePlatform } from './platform';

export class VantagePlatformAccessory {
  private Service: typeof Service;
  private Characteristic: typeof Characteristic;

  constructor(
    private readonly platform: VantagePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.Service = this.platform.api.hap.Service;
    this.Characteristic = this.platform.api.hap.Characteristic;
    this.registerServices();
  }

  /** Call this both on create and on restore */
  registerServices() {
    const device = this.accessory.context.device as VantageDevice | undefined;
    if (!device) {
      this.platform.log.warn(`No device context on ${this.accessory.displayName}; leaving as-is`);
      return;
    }

    // Accessory Info (always)
    const info =
      this.accessory.getService(this.Service.AccessoryInformation) ??
      this.accessory.addService(this.Service.AccessoryInformation);

    info.setCharacteristic(this.Characteristic.Manufacturer, 'Vantage Controls');
    info.setCharacteristic(this.Characteristic.Model, device.objectType ?? device.type);
    info.setCharacteristic(this.Characteristic.SerialNumber, `VID ${device.vid}`);

    // Build the correct primary service for the type
    let primary: Service | undefined;

    if (device.type === 'relay') {
      primary =
        this.accessory.getService(this.Service.Switch) ??
        this.accessory.addService(this.Service.Switch, this.accessory.displayName);

      // REQUIRED characteristic
      const on = primary.getCharacteristic(this.Characteristic.On);
      on.removeAllListeners('set'); // avoid duplicate handlers on restore
      on.onSet(async (value) => this.platform.getInfusion().setRelay(device.address, !!value));

      // Category helps iOS
      this.accessory.category = this.platform.api.hap.Categories.SWITCH;
    }

    if (device.type === 'dimmer' || device.type === 'rgb') {
      primary =
        this.accessory.getService(this.Service.Lightbulb) ??
        this.accessory.addService(this.Service.Lightbulb, this.accessory.displayName);

      // On
      const on = primary.getCharacteristic(this.Characteristic.On);
      on.removeAllListeners('set');
      on.onSet(async (value) =>
        this.platform.getInfusion().setRelayOrDim(device.address, !!value, device.bri ?? 100, device.type),
      );

      // Brightness (required for dimmer)
      const bri = primary.getCharacteristic(this.Characteristic.Brightness);
      bri.removeAllListeners('set');
      bri.onSet(async (value) => this.platform.getInfusion().setBrightness(device.address, Number(value)));

      // RGB extras
      if (device.type === 'rgb') {
        const hue = primary.getCharacteristic(this.Characteristic.Hue);
        hue.removeAllListeners('set');
        hue.onSet((v) => this.platform.getInfusion().setHue(device.address, Number(v)));

        const sat = primary.getCharacteristic(this.Characteristic.Saturation);
        sat.removeAllListeners('set');
        sat.onSet((v) => this.platform.getInfusion().setSaturation(device.address, Number(v)));
      } else {
        // Ensure RGB chars aren’t lingering from a previous cache
        this.safeRemoveCharacteristic(primary, this.Characteristic.Hue);
        this.safeRemoveCharacteristic(primary, this.Characteristic.Saturation);
      }

      this.accessory.category = this.platform.api.hap.Categories.LIGHTBULB;
    }

    if (device.type === 'blind') {
      primary =
        this.accessory.getService(this.Service.WindowCovering) ??
        this.accessory.addService(this.Service.WindowCovering, this.accessory.displayName);

      const tgt = primary.getCharacteristic(this.Characteristic.TargetPosition);
      tgt.removeAllListeners('set');
      tgt.onSet((value) => this.platform.getInfusion().setBlindPosition(device.address, Number(value)));

      // Make sure required reads exist (they can be updated via events)
      primary.getCharacteristic(this.Characteristic.CurrentPosition);
      primary.getCharacteristic(this.Characteristic.PositionState);

      this.accessory.category = this.platform.api.hap.Categories.WINDOW_COVERING;
    }

    if (device.type === 'thermostat') {
      primary =
        this.accessory.getService(this.Service.Thermostat) ??
        this.accessory.addService(this.Service.Thermostat, this.accessory.displayName);

      const tgt = primary.getCharacteristic(this.Characteristic.TargetTemperature);
      tgt.removeAllListeners('set');
      tgt.onSet((value) => this.platform.getInfusion().setThermostatTarget(device.address, Number(value)));

      // Make sure required reads exist (they can be updated via events)
      primary.getCharacteristic(this.Characteristic.CurrentTemperature);
      primary.getCharacteristic(this.Characteristic.TargetTemperature);

      this.accessory.category = this.platform.api.hap.Categories.THERMOSTAT;
    }

    if (!primary) {
      this.platform.log.warn(`Unsupported device type ${device.type} for ${this.accessory.displayName}`);
      return;
    }

    // Mark primary (helps Home app pick the right tile)
    try {
      (primary as any).setPrimaryService?.(true);
    } catch {}

    // PRUNE stale/incorrect services (keep AccessoryInformation + current primary)
    for (const s of [...this.accessory.services]) {
      if (s === primary) continue;
      if (s === info) continue;
      // Remove anything else (e.g., an old Switch lingering on a dimmer)
      this.accessory.removeService(s);
    }
  }

  private safeRemoveCharacteristic(svc: Service, C: any) {
    const c = svc.getCharacteristic(C);
    if (c) {
      try {
        svc.removeCharacteristic(c);
      } catch {
        // ignore if Homebridge version doesn’t support removal
      }
    }
  }
}
