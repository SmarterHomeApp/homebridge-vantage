import {
  API,
  APIEvent,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { VantageInfusion } from './vantageInfusion';
import type { VantageDevice } from './types';
import { VantagePlatformAccessory } from './platformAccessory';
import { sanitizeHomeKitName } from './homekitName';

export class VantagePlatform implements DynamicPlatformPlugin {
  public readonly accessories: PlatformAccessory[] = [];

  private infusion!: VantageInfusion;
  private syncedOnce = false; // prevent double-sync when both event + promise fire
  private accessoriesByVid = new Map<string, PlatformAccessory>();
  private realtimeWired = false;
  private invalidThermostatWarnings = new Set<string>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    if (!config) {
      this.log.error(`[${PLATFORM_NAME}] Missing platform config — plugin will not start.`);
      return;
    }

    // Construct infusion
    this.infusion = new VantageInfusion({
      ipaddress: config.ipaddress ? String(config.ipaddress) : '',
      username: (config as any).username ?? '',
      password: (config as any).password ?? '',
      usecache: (config as any).usecache ?? true,
      omit: (config as any).omit ?? '',
      range: (config as any).range ?? '0-999999999',
      forceSSL: (config as any).forceSSL ?? false,
      includeLights: (config as any).includeLights ?? true,
      includeBlinds: (config as any).includeBlinds ?? true,
      includeThermostats: (config as any).includeThermostats ?? true,
      includeSensors: (config as any).includeSensors ?? true,
      storagePath: this.api.user.storagePath(),
      log: this.log,
    });

    // ----- Standard HB boot path -----
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
      try {
        await this.infusion.start();
        if (!this.syncedOnce) {
          const devices = await this.infusion.discoverDevices();
          await this.syncAccessories(devices);
          this.finalizeLogs();
        }
      } catch (e: any) {
        this.log.error(`Startup failed: ${e?.message ?? String(e)}`);
      }
    });
  }

  // Cache any restored accessories
  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }

  // Reconcile cached accessories with current device list
  private async syncAccessories(devices: VantageDevice[]) {
    const uuidFor = (d: VantageDevice) => this.api.hap.uuid.generate(String(d.vid));

    if (devices.length === 0 && this.accessories.length > 0) {
      this.log.error(
        `Discovery returned 0 devices; preserving ${this.accessories.length} cached accessories ` +
          'and rebuilding realtime VID map.',
      );
      this.rebuildAccessoryVidMap();
      this.wireRealtimeListeners();
      this.syncedOnce = true;
      return;
    }

    // Map current devices
    const wanted = new Map<string, VantageDevice>();
    for (const d of devices) wanted.set(uuidFor(d), d);

    const toUnregister = this.accessories.filter((acc) => !wanted.has(acc.UUID));
    if (toUnregister.length && this.shouldSkipStaleRemoval(devices.length, toUnregister.length)) {
      this.log.error(
        `Suspicious partial discovery detected; preserving ${this.accessories.length} cached accessories. ` +
          `Discovery returned ${devices.length} devices and would remove ${toUnregister.length}.`,
      );
      this.rebuildAccessoryVidMap();
      this.wireRealtimeListeners();
      this.syncedOnce = true;
      return;
    }

    // Update existing / mark seen
    const seen = new Set<string>();
    const toUpdate: PlatformAccessory[] = [];

    for (const acc of this.accessories) {
      const d = wanted.get(acc.UUID);
      if (d) {
        // Update name/context and re-bind
        acc.displayName = sanitizeHomeKitName(d.name, `VID ${d.vid}`);
        acc.context.device = d;
        new VantagePlatformAccessory(this, acc);
        seen.add(acc.UUID);
        toUpdate.push(acc);

        if (d.vid) this.accessoriesByVid.set(String(d.vid), acc);
      }
    }

    if (toUpdate.length) {
      this.api.updatePlatformAccessories(toUpdate);
      this.log.info(`Updated ${toUpdate.length} existing accessories`);
    }

    // Register new
    const toRegister: PlatformAccessory[] = [];
    for (const d of devices) {
      const uuid = uuidFor(d);
      if (seen.has(uuid)) continue;

      const acc = new this.api.platformAccessory(sanitizeHomeKitName(d.name, `VID ${d.vid}`), uuid);
      acc.context.device = d;
      new VantagePlatformAccessory(this, acc);
      toRegister.push(acc);
      this.accessories.push(acc);

      if (d.vid) this.accessoriesByVid.set(String(d.vid), acc);
    }
    if (toRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
      this.log.info(`Registered ${toRegister.length} new accessories`);
    }

    // Unregister stale
    if (toUnregister.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toUnregister);
      this.log.info(`Unregistered ${toUnregister.length} stale accessories after successful discovery`);
      // Remove from local cache & VID map
      for (const acc of toUnregister) {
        const vid = acc?.context?.device?.vid;
        if (vid) this.accessoriesByVid.delete(String(vid));
        const idx = this.accessories.findIndex((a) => a.UUID === acc.UUID);
        if (idx >= 0) this.accessories.splice(idx, 1);
      }
    }

    // Arm realtime listeners once we know the VID→accessory map
    this.wireRealtimeListeners();

    this.syncedOnce = true;
  }

  private shouldSkipStaleRemoval(discoveredCount: number, staleCount: number): boolean {
    const cachedCount = this.accessories.length;
    if (cachedCount === 0 || staleCount === 0) return false;

    const removalRatio = staleCount / cachedCount;
    const discoveredRatio = discoveredCount / cachedCount;

    // Allow small cleanup, but refuse sudden large percentage drops that look like partial discovery.
    return staleCount >= 5 && removalRatio > 0.5 && discoveredRatio < 0.5;
  }

  private rebuildAccessoryVidMap() {
    this.accessoriesByVid.clear();

    for (const acc of this.accessories) {
      const vid = acc?.context?.device?.vid;

      if (vid !== undefined && vid !== null) {
        this.accessoriesByVid.set(String(vid), acc);
      }
    }
  }

  private wireRealtimeListeners() {
    if (this.realtimeWired) return;
    this.realtimeWired = true;

    const S = this.api.hap.Service;
    const C = this.api.hap.Characteristic;

    // LIGHTS (relay / dimmer / rgb)
    this.infusion.on('loadStatusChange', (vid: number, value: number, command?: number) => {
      const acc = this.accessoriesByVid.get(String(vid));
      if (!acc) return;

      const dev = acc.context.device as VantageDevice;
      if (!dev) return;
      this.log.info("loadStatusChange (VID=%s, Name=%s, Bri:%d)", vid, dev.name, value)

      if (dev.type === 'relay' || dev.type === 'dimmer' || dev.type === 'rgb') {
        (dev as any).bri = Number(value);
        (dev as any).power = (dev as any).bri > 0;
      }

      if (dev.type === 'relay') {
        acc.getService(S.Switch)?.updateCharacteristic(C.On, (dev as any).power);
        return;
      }

      if (dev.type === 'dimmer' || dev.type === 'rgb') {
        const lb = acc.getService(S.Lightbulb);
        lb?.updateCharacteristic(C.On, (dev as any).power);
        
        // Update brightness value without triggering UI updates (modern approach)
        const brightnessChar = lb?.getCharacteristic(C.Brightness);
        if (brightnessChar) {
          brightnessChar.value = (dev as any).bri;
        }

        // RGB incremental HSL feedback
        if (dev.type === 'rgb' && typeof command === 'number') {
          if (command === 0) (dev as any).hue = Number(value);
          if (command === 1) (dev as any).sat = Number(value);
          if (command === 2) (dev as any).bri = Number(value);

          const hueChar = lb?.getCharacteristic(C.Hue);
          const satChar = lb?.getCharacteristic(C.Saturation);
          const briChar = lb?.getCharacteristic(C.Brightness);
          
          if (hueChar) hueChar.value = (dev as any).hue ?? 0;
          if (satChar) satChar.value = (dev as any).sat ?? 0;
          if (briChar) briChar.value = (dev as any).bri ?? 0;
        }
      }
    });

    // BLINDS
    this.infusion.on('blindStatusChange', (vid: number, value: number) => {
      const acc = this.accessoriesByVid.get(String(vid));
      if (!acc) return;

      const dev = acc.context.device as VantageDevice;
      if (!dev) return;
      this.log.info("blindStatusChange (VID=%s, Name=%s, Pos:%d)", vid, dev.name, value);

      (dev as any).pos = Number(value);
      const wc = acc.getService(S.WindowCovering);
      wc?.updateCharacteristic(C.CurrentPosition, (dev as any).pos);
      wc?.updateCharacteristic(C.PositionState, 2); // Stopped
    });

    // THERMOSTATS — temp (legacy event) - loops through ALL thermostats like original
    this.infusion.on('thermostatDidChange', (_value: number) => {
      // Loop through all thermostat accessories and refresh their state
      for (const [vid, acc] of this.accessoriesByVid) {
        const dev = acc.context.device as VantageDevice;
        if (dev && dev.type === 'thermostat') {
          const svc = acc.getService(S.Thermostat);
          if (svc) {
            // Refresh thermostat state (from original code)
            this.infusion.Thermostat_GetIndoorTemperature(vid);
            this.infusion.Thermostat_GetState(vid);
            this.infusion.Thermostat_GetHeating(vid);
            this.infusion.Thermostat_GetCooling(vid);
          }
        }
      }
    });

    // THERMOSTATS — temp
    this.infusion.on('thermostatIndoorTemperatureChange', (vid: number, temp: number) => {
      const acc = this.accessoriesByVid.get(String(vid));
      if (!acc) return;

      const dev = acc.context.device as VantageDevice;
      const temperature = this.normalizeCurrentTemperature(temp);
      if (temperature === undefined) {
        this.logInvalidThermostatValue(
          `${vid}:current`,
          `Thermostat ${vid} reported invalid temperature ${temp}; ignoring update`,
        );
        return;
      }

      (dev as any).temperature = temperature;
      this.log.info(`thermostatIndoorTemperatureChange (VID=${vid}, Name=${dev.name}, Temp=${temperature})`);

      acc.getService(S.Thermostat)
        ?.updateCharacteristic(C.CurrentTemperature, temperature);
    });

    // THERMOSTATS — mode/targets
    this.infusion.on('thermostatIndoorModeChange', (vid: number, mode: number, targetTemp: number) => {
      const acc = this.accessoriesByVid.get(String(vid));
      if (!acc) return;

      const dev = acc.context.device as any;
      const svc = acc.getService(S.Thermostat);
      if (!svc || !dev) return;

      this.log.debug(`thermostatIndoorModeChange (VID=${vid}, Name=${dev.name}, Mode=${mode}, TargetTemp=${targetTemp})`);
      // this.log.info(`Before update - dev.mode=${dev.mode}, dev.targetTemp=${dev.targetTemp}, dev.heating=${dev.heating}, dev.cooling=${dev.cooling}`);

      if (targetTemp === -1) {
        // Only update mode when targetTemp is -1 (mode change without temperature)
        (dev as any).mode = mode;
        // compute current state from thresholds + mode
        let current = 0;
        if ((dev as any).temperature <= (dev as any).heating && mode === 1) current = 1;
        else if ((dev as any).temperature >= (dev as any).cooling && mode === 2) current = 2;
        else if (mode === 3) {
          if ((dev as any).temperature <= (dev as any).heating) current = 1;
          else if ((dev as any).temperature >= (dev as any).cooling) current = 2;
        }
        (dev as any).current = current; // Store the calculated current state
        svc.updateCharacteristic(C.CurrentHeatingCoolingState, current);
        svc.updateCharacteristic(C.TargetHeatingCoolingState, mode);
        this.ensureValidThermostatSetpoints(dev, svc);
      } else {
        const normalizedTarget = this.normalizeTargetTemperature(targetTemp);
        if (normalizedTarget === undefined) {
          this.logInvalidThermostatValue(
            `${vid}:target`,
            `Thermostat ${vid} reported invalid target temperature ${targetTemp}; ignoring setpoint update`,
          );
          svc.updateCharacteristic(C.TargetHeatingCoolingState, mode);
          this.ensureValidThermostatSetpoints(dev, svc);
          return;
        }

        (dev as any).mode = mode;
        (dev as any).targetTemp = normalizedTarget;
        if (mode === 1) {
          (dev as any).heating = Math.min(25, normalizedTarget); // HomeKit max is 25°C
          svc.updateCharacteristic(C.HeatingThresholdTemperature, (dev as any).heating);
        } else if (mode === 2) {
          (dev as any).cooling = Math.min(35, normalizedTarget);
          svc.updateCharacteristic(C.CoolingThresholdTemperature, (dev as any).cooling);
        }

        // Update target temperature based on mode (from original logic)
        if ((dev as any).mode === 1 && this.isValidTargetTemperature((dev as any).heating)) {
          (dev as any).targetTemp = (dev as any).heating;
        } else if ((dev as any).mode === 2 && this.isValidTargetTemperature((dev as any).cooling)) {
          (dev as any).targetTemp = (dev as any).cooling;
        } else if ((dev as any).mode === 3) {
          const target = this.resolveAutoModeTargetTemperature(dev);
          if (target !== undefined) {
            (dev as any).targetTemp = target;
          }
        }

        if (this.isValidTargetTemperature((dev as any).targetTemp)) {
          svc.updateCharacteristic(C.TargetTemperature, (dev as any).targetTemp);
        }
        svc.updateCharacteristic(C.TargetHeatingCoolingState, (dev as any).mode);
        
        // this.log.info(`After update - dev.mode=${dev.mode}, dev.targetTemp=${dev.targetTemp}, dev.heating=${dev.heating}, dev.cooling=${dev.cooling}`);
      }
    });

    this.infusion.on('thermostatChildTemperatureChange', (vid: string, role: string, temperature: number) => {
      const acc = this.accessoriesByVid.get(String(vid));
      if (!acc) return;

      const dev = acc.context.device as any;
      const svc = acc.getService(S.Thermostat);
      if (!svc || !dev || dev.type !== 'thermostat') return;

      const normalized = role === 'indoor'
        ? this.normalizeCurrentTemperature(temperature)
        : this.normalizeTargetTemperature(temperature);
      if (normalized === undefined) {
        this.logInvalidThermostatValue(
          `${vid}:${role}`,
          `Thermostat ${vid} reported invalid ${role} temperature ${temperature}; ignoring update`,
        );
        return;
      }

      if (role === 'indoor') {
        dev.temperature = normalized;
        svc.updateCharacteristic(C.CurrentTemperature, normalized);
        return;
      }

      if (role === 'heat') {
        dev.heating = normalized;
        svc.updateCharacteristic(C.HeatingThresholdTemperature, Math.min(25, Math.max(10, normalized)));
        if (dev.mode === 1) {
          dev.targetTemp = normalized;
          svc.updateCharacteristic(C.TargetTemperature, normalized);
        }
        return;
      }

      if (role === 'cool') {
        dev.cooling = normalized;
        svc.updateCharacteristic(C.CoolingThresholdTemperature, Math.min(35, Math.max(10, normalized)));
        if (dev.mode === 2) {
          dev.targetTemp = normalized;
          svc.updateCharacteristic(C.TargetTemperature, normalized);
        }
      }
    });

    this.infusion.on('contactStatusChange', (vid: number, contact: boolean) => {
      const acc = this.accessoriesByVid.get(String(vid));
      if (!acc) return;

      const dev = acc.context.device as VantageDevice;
      if (!dev || dev.type !== 'contact') return;

      (dev as any).contact = contact;
      acc.getService(S.ContactSensor)?.updateCharacteristic(
        C.ContactSensorState,
        contact ? C.ContactSensorState.CONTACT_DETECTED : C.ContactSensorState.CONTACT_NOT_DETECTED,
      );
    });

    this.infusion.on('temperatureSensorChange', (vid: number, temperature: number) => {
      const acc = this.accessoriesByVid.get(String(vid));
      if (!acc) return;

      const dev = acc.context.device as VantageDevice;
      if (!dev || dev.type !== 'temperatureSensor') return;

      const normalized = Math.min(100, Math.max(-50, Number(temperature)));
      (dev as any).temperature = normalized;
      acc.getService(S.TemperatureSensor)?.updateCharacteristic(C.CurrentTemperature, normalized);
    });

    this.infusion.on('lightSensorChange', (vid: number, lightLevel: number) => {
      const acc = this.accessoriesByVid.get(String(vid));
      if (!acc) return;

      const dev = acc.context.device as VantageDevice;
      if (!dev || dev.type !== 'lightSensor') return;

      const normalized = Math.max(0.0001, Math.min(100000, Number(lightLevel)));
      (dev as any).lightLevel = normalized;
      acc.getService(S.LightSensor)?.updateCharacteristic(C.CurrentAmbientLightLevel, normalized);
    });
  }

  private finalizeLogs() {
    // Legacy “store/open for business” logs
    this.log.warn('VantagePlatform for InFusion Controller (end configuration store)');
    this.log.warn('VantagePlatform for InFusion Controller (is open for business)');
  }

  private normalizeCurrentTemperature(value: number): number | undefined {
    const temperature = Number(value);
    if (!Number.isFinite(temperature) || temperature <= -100 || temperature >= 900) return undefined;
    return Math.min(100, Math.max(-50, temperature));
  }

  private normalizeTargetTemperature(value: number): number | undefined {
    const temperature = Number(value);
    if (!Number.isFinite(temperature) || temperature < 1 || temperature >= 900) return undefined;
    return Math.min(38, Math.max(10, temperature));
  }

  private isValidTargetTemperature(value: unknown): value is number {
    const temperature = Number(value);
    return Number.isFinite(temperature) && temperature >= 10 && temperature <= 38;
  }

  private ensureValidThermostatSetpoints(dev: any, svc: { updateCharacteristic: (characteristic: unknown, value: number) => unknown }) {
    const C = this.api.hap.Characteristic;
    if (!this.isValidTargetTemperature(dev.targetTemp)) {
      dev.targetTemp = 20;
      svc.updateCharacteristic(C.TargetTemperature, 20);
    }
    if (!this.isValidTargetTemperature(dev.heating)) {
      dev.heating = 20;
      svc.updateCharacteristic(C.HeatingThresholdTemperature, 20);
    }
    if (!this.isValidTargetTemperature(dev.cooling)) {
      dev.cooling = 25;
      svc.updateCharacteristic(C.CoolingThresholdTemperature, 25);
    }
  }

  private resolveAutoModeTargetTemperature(dev: any): number | undefined {
    const heating = this.isValidTargetTemperature(dev.heating) ? Number(dev.heating) : undefined;
    const cooling = this.isValidTargetTemperature(dev.cooling) ? Number(dev.cooling) : undefined;

    if (heating === undefined && cooling === undefined) return undefined;
    if (heating === undefined) return cooling;
    if (cooling === undefined) return heating;

    const current = this.normalizeCurrentTemperature(dev.temperature);
    if (current === undefined) return cooling;

    return current <= heating ? heating : cooling;
  }

  private logInvalidThermostatValue(key: string, message: string) {
    if (this.invalidThermostatWarnings.has(key)) {
      return;
    }

    this.invalidThermostatWarnings.add(key);
    this.log.warn(`${message}. Future repeats will be suppressed.`);
  }

  // Exposed for accessory class
  public getInfusion(): VantageInfusion {
    return this.infusion;
  }

  public getApi(): API {
    return this.api;
  }
}
