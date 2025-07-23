import { API, Logger, PlatformAccessory, Service, Characteristic } from 'homebridge';
import { VantageHomebridgePlatform } from './index';
import { VantageDevice } from './types';

export class VantageAccessory {
  private service: Service;
  private readonly device: VantageDevice;

  constructor(
    private readonly platform: VantageHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    device: VantageDevice,
  ) {
    this.device = device;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Vantage Controls')
      .setCharacteristic(this.platform.Characteristic.Model, this.getModelName())
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'VID ' + this.device.address);

    // create the appropriate service based on device type
    switch (this.device.type) {
      case 'thermostat':
        this.createThermostatService();
        break;
      case 'dimmer':
      case 'rgb':
        this.createLightbulbService();
        break;
      case 'relay':
        this.createSwitchService();
        break;
      case 'blind':
        this.createWindowCoveringService();
        break;
      default:
        this.createLightbulbService();
        break;
    }
  }

  private getModelName(): string {
    switch (this.device.type) {
      case 'thermostat':
        return 'Thermostat';
      case 'dimmer':
        return 'Dimmer';
      case 'rgb':
        return 'RGB Light';
      case 'relay':
        return 'Switch';
      case 'blind':
        return 'Blind';
      default:
        return 'Light';
    }
  }

  private createThermostatService(): void {
    this.service = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat, this.device.name, 'thermostat');

    // Current Temperature
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    // Target Temperature
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    // Current Heating Cooling State
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    // Target Heating Cooling State
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    // Heating Threshold Temperature
    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onGet(this.getHeatingThresholdTemperature.bind(this));

    // Cooling Threshold Temperature
    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onGet(this.getCoolingThresholdTemperature.bind(this));

    // Temperature Display Units
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    // Initialize thermostat
    const infusion = this.platform['infusion'];
    if (infusion) {
      infusion.Thermostat_GetIndoorTemperature(this.device.address);
      infusion.Thermostat_GetState(this.device.address);
      infusion.Thermostat_GetHeating(this.device.address);
      infusion.Thermostat_GetCooling(this.device.address);
    }
  }

  private createLightbulbService(): void {
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb, this.device.name, 'lightbulb');

    // On/Off
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    // Brightness (for dimmers and RGB)
    if (this.device.type === 'dimmer' || this.device.type === 'rgb') {
      this.service.getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(this.getBrightness.bind(this))
        .onSet(this.setBrightness.bind(this));
    }

    // Hue and Saturation (for RGB only)
    if (this.device.type === 'rgb') {
      this.service.getCharacteristic(this.platform.Characteristic.Hue)
        .onGet(this.getHue.bind(this))
        .onSet(this.setHue.bind(this));

      this.service.getCharacteristic(this.platform.Characteristic.Saturation)
        .onGet(this.getSaturation.bind(this))
        .onSet(this.setSaturation.bind(this));
    }

    // Initialize load
    const infusion = this.platform['infusion'];
    if (infusion) {
      infusion.getLoadStatus(this.device.address);
      if (this.device.type === 'rgb') {
        infusion.getLoadHSL(this.device.address, 'hue');
        infusion.getLoadHSL(this.device.address, 'saturation');
        infusion.getLoadHSL(this.device.address, 'lightness');
      }
    }
  }

  private createSwitchService(): void {
    this.service = this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch, this.device.name, 'switch');

    // On/Off
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    // Initialize relay
    const infusion = this.platform['infusion'];
    if (infusion) {
      infusion.getLoadStatus(this.device.address);
    }
  }

  private createWindowCoveringService(): void {
    this.service = this.accessory.getService(this.platform.Service.WindowCovering) ||
      this.accessory.addService(this.platform.Service.WindowCovering, this.device.name, 'windowcovering');

    // Current Position
    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.getCurrentPosition.bind(this));

    // Target Position
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.getTargetPosition.bind(this))
      .onSet(this.setTargetPosition.bind(this));

    // Position State
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.getPositionState.bind(this));

    // Initialize blind
    const infusion = this.platform['infusion'];
    if (infusion) {
      infusion.getBlindPos(this.device.address);
    }
  }

  // Thermostat methods
  private getCurrentTemperature(): number {
    return (this.device as any).temperature || 0;
  }

  private getTargetTemperature(): number {
    return (this.device as any).targetTemp || 0;
  }

  private setTargetTemperature(value: number): void {
    (this.device as any).targetTemp = value;
    const infusion = this.platform['infusion'];
    if (infusion) {
      const mode = (this.device as any).mode || 0;
      const heating = (this.device as any).heating || 0;
      const cooling = (this.device as any).cooling || 0;
      infusion.Thermostat_SetIndoorTemperature(this.device.address, value, mode, heating, cooling);
    }
  }

  private getCurrentHeatingCoolingState(): number {
    return (this.device as any).current || 0;
  }

  private getTargetHeatingCoolingState(): number {
    return (this.device as any).mode || 0;
  }

  private setTargetHeatingCoolingState(value: number): void {
    (this.device as any).mode = value;
    const infusion = this.platform['infusion'];
    if (infusion) {
      infusion.Thermostat_SetTargetState(this.device.address, value);
    }
  }

  private getHeatingThresholdTemperature(): number {
    return (this.device as any).heating || 0;
  }

  private getCoolingThresholdTemperature(): number {
    return (this.device as any).cooling || 0;
  }

  private getTemperatureDisplayUnits(): number {
    return (this.device as any).units || 1;
  }

  private setTemperatureDisplayUnits(value: number): void {
    (this.device as any).units = value;
  }

  // Lightbulb methods
  private getOn(): boolean {
    return (this.device as any).power || false;
  }

  private setOn(value: boolean): void {
    (this.device as any).power = value;
    const infusion = this.platform['infusion'];
    if (infusion) {
      const bri = (this.device as any).bri || 100;
      infusion.Load_Dim(this.device.address, value ? bri : 0);
    }
  }

  private getBrightness(): number {
    return (this.device as any).bri || 100;
  }

  private setBrightness(value: number): void {
    (this.device as any).bri = value;
    (this.device as any).power = value > 0;
    const infusion = this.platform['infusion'];
    if (infusion) {
      if (this.device.type === 'rgb') {
        const hue = (this.device as any).hue || 0;
        const sat = (this.device as any).sat || 0;
        infusion.RGBLoad_DissolveHSL(this.device.address, hue, sat, value);
      }
      infusion.Load_Dim(this.device.address, value);
    }
  }

  private getHue(): number {
    return (this.device as any).hue || 0;
  }

  private setHue(value: number): void {
    (this.device as any).hue = value;
    (this.device as any).power = true;
    const infusion = this.platform['infusion'];
    if (infusion) {
      const sat = (this.device as any).sat || 0;
      const bri = (this.device as any).bri || 100;
      infusion.RGBLoad_DissolveHSL(this.device.address, value, sat, bri);
    }
  }

  private getSaturation(): number {
    return (this.device as any).sat || 0;
  }

  private setSaturation(value: number): void {
    (this.device as any).sat = value;
    (this.device as any).power = true;
    const infusion = this.platform['infusion'];
    if (infusion) {
      const hue = (this.device as any).hue || 0;
      const bri = (this.device as any).bri || 100;
      infusion.RGBLoad_DissolveHSL(this.device.address, hue, value, bri);
    }
  }

  // Switch methods (same as lightbulb for on/off)
  // getOn and setOn are already defined above

  // Window Covering methods
  private getCurrentPosition(): number {
    return (this.device as any).pos || 100;
  }

  private getTargetPosition(): number {
    return (this.device as any).pos || 100;
  }

  private setTargetPosition(value: number): void {
    (this.device as any).pos = value;
    const infusion = this.platform['infusion'];
    if (infusion) {
      infusion.setBlindPos(this.device.address, value);
    }
  }

  private getPositionState(): number {
    return (this.device as any).posState || 2;
  }
} 