import { API, Logger, PlatformConfig } from 'homebridge';
import * as net from 'net';
import * as sprintf from 'sprintf-js';
import * as parser from 'xml2json';
import { VantageInfusion } from './vantageInfusion';
import { VantageDevice, VantageConfig } from './types';

export class VantagePlatform {
  private log: Logger;
  private config: VantageConfig;
  private api: API;
  private ipaddress: string;
  private lastDiscovery: any;
  private items: VantageDevice[] = [];
  private usecache: boolean;
  private omit: string;
  private range: string;
  private username: string;
  private password: string;
  private pendingrequests = 0;
  private ready = false;
  private callbackPromesedAccessories: ((devices: VantageDevice[]) => void) | undefined;
  private infusion: VantageInfusion;

  constructor(log: Logger, config: PlatformConfig, api: API) {
    this.log = log;
    this.config = config as VantageConfig;
    this.api = api;
    this.ipaddress = this.convertToIP(config.ipaddress);
    this.lastDiscovery = null;

    if (config.usecache === undefined) {
      this.usecache = true;
    } else {
      this.usecache = config.usecache;
    }

    if (config.omit === undefined) {
      this.omit = '';
    } else {
      this.omit = config.omit;
    }

    if (config.range === undefined) {
      this.range = '';
    } else {
      this.range = config.range;
    }

    if (config.username === undefined) {
      this.username = '';
    } else {
      this.username = config.username;
    }

    if (config.password === undefined) {
      this.password = '';
    } else {
      this.password = config.password;
    }

    this.portIsUsable(3001, this.ipaddress, 'STATUS ALL\n', (return3001Value: boolean) => {
      if (return3001Value) {
        console.log('Using insecure port: 3001');
      } else {
        console.log('Using SSL port: 3010');
      }

      this.portIsUsable(2001, this.ipaddress, '<IIntrospection><GetInterfaces><call></call></GetInterfaces></IIntrospection>\n', (return2001Value: boolean) => {
        if (return2001Value) {
          console.log('Using insecure port: 2001');
        } else {
          console.log('Using SSL port: 2010');
        }
        this.initialize(return3001Value, return2001Value);
      });
    });
  }

  private convertToIP(ipaddress: string): string {
    let result = '';
    const vals = ipaddress.split('.');
    for (let i = 0; i < vals.length; i++) {
      result += parseInt(vals[i]).toString();
      if (i < 3) {
        result += '.';
      }
    }
    return result;
  }

  private portIsUsable(port: number, ipaddress: string, text: string, callback: (usable: boolean) => void): void {
    let returnVal = false;
    const command = net.connect({ host: ipaddress, port: port }, () => {
      command.write(sprintf.sprintf(text));
    });
    command.setTimeout(5000, () => command.destroy());
    command.once('connect', () => command.setTimeout(0));
    command.on('data', (data: Buffer) => {
      returnVal = true;
      callback(true);
      command.destroy();
    });
    command.on('close', () => {
      if (!returnVal) {
        callback(false);
      }
      command.destroy();
    });
    command.on('end', () => {
      command.destroy();
    });
    command.on('error', console.error);
  }

  private initialize(is3001Insecure: boolean, is2001Insecure: boolean): void {
    this.infusion = new VantageInfusion({
      ipaddress: this.ipaddress,
      accessories: this.items,
      usecache: this.usecache,
      omit: this.omit,
      range: this.range,
      username: this.username,
      password: this.password,
      isInsecure: is3001Insecure
    });

    if (is2001Insecure) {
      this.infusion.discover();
    } else {
      this.infusion.discoverSSL();
    }

    this.log.info('VantagePlatform for InFusion Controller at ' + this.ipaddress);

    this.infusion.on('loadStatusChange', (vid: number, value: number, command?: number) => {
      this.items.forEach((accessory) => {
        if (accessory.address === vid.toString()) {
          if (accessory.type === 'relay') {
            this.log(sprintf.sprintf('relayStatusChange (VID=%s, Name=%s, Val:%d)', vid, accessory.name, value));
            accessory.bri = parseInt(value.toString());
            accessory.power = ((accessory.bri) > 0);
            if (accessory.switchService !== undefined) {
              accessory.switchService.getCharacteristic(this.api.hap.Characteristic.On).getValue(null, accessory.power);
            }
          } else if (accessory.type === 'rgb' && command !== undefined) {
            this.log(sprintf.sprintf('rgbStatusChange (VID=%s, Name=%s, Val:%d, HSL:%d)', vid, accessory.name, value, command));
            if (command === 0) {
              accessory.hue = parseInt(value.toString());
            }
            if (command === 1) {
              accessory.sat = parseInt(value.toString());
            }
            if (command === 2) {
              accessory.bri = parseInt(value.toString());
            }
            this.log(sprintf.sprintf('rgbStatusChange (VID=%s, Name=%s, Val:%d, HSL:%d, H:%d, S:%d, L:%d)', vid, accessory.name, value, command, accessory.hue, accessory.sat, accessory.bri));
            if (accessory.lightBulbService !== undefined) {
              accessory.lightBulbService.getCharacteristic(this.api.hap.Characteristic.Brightness).getValue(null, accessory.bri);
              accessory.lightBulbService.getCharacteristic(this.api.hap.Characteristic.Saturation).getValue(null, accessory.sat);
              accessory.lightBulbService.getCharacteristic(this.api.hap.Characteristic.Hue).getValue(null, accessory.hue);
            }
          } else {
            this.log(sprintf.sprintf('loadStatusChange (VID=%s, Name=%s, Bri:%d)', vid, accessory.name, value));
            accessory.bri = parseInt(value.toString());
            accessory.power = ((accessory.bri) > 0);
            if (accessory.type === 'rgb') {
              this.log(sprintf.sprintf('rgbStatusChange (VID=%s, Name=%s, H:%d, S:%d, L:%d)', vid, accessory.name, accessory.hue, accessory.sat, accessory.bri));
            }
            if (accessory.lightBulbService !== undefined) {
              accessory.lightBulbService.getCharacteristic(this.api.hap.Characteristic.On).getValue(null, accessory.power);
              if (accessory.type === 'rgb' || accessory.type === 'dimmer') {
                accessory.lightBulbService.getCharacteristic(this.api.hap.Characteristic.Brightness).getValue(null, accessory.bri);
              }
            }
          }
        }
      });
    });

    this.infusion.on('blindStatusChange', (vid: number, value: number) => {
      this.items.forEach((accessory) => {
        if (accessory.address === vid.toString()) {
          this.log(sprintf.sprintf('blindStatusChange (VID=%s, Name=%s, Pos:%d)', vid, accessory.name, value));
          accessory.pos = parseInt(value.toString());
          if (accessory.blindService !== undefined) {
            accessory.blindService.getCharacteristic(this.api.hap.Characteristic.CurrentPosition).getValue(null, accessory.pos);
          }
        }
      });
    });

    this.infusion.on('thermostatIndoorModeChange', (vid: number, mode: number, targetTemp: number) => {
      this.items.forEach((accessory) => {
        if (accessory.address === vid.toString()) {
          if (accessory.thermostatService !== undefined) {
            if (targetTemp === -1) {
              accessory.current = 0;
              if (accessory.temperature <= accessory.heating && mode === 1) {
                accessory.current = 1;
              } else if (accessory.temperature >= accessory.cooling && mode === 2) {
                accessory.current = 2;
              } else if (mode === 3) {
                if (accessory.temperature <= accessory.heating) {
                  accessory.current = 1;
                } else if (accessory.temperature >= accessory.cooling) {
                  accessory.current = 2;
                }
              }
              accessory.mode = mode;
              accessory.thermostatService.getCharacteristic(this.api.hap.Characteristic.CurrentHeatingCoolingState).getValue(null, accessory.current);
              accessory.thermostatService.getCharacteristic(this.api.hap.Characteristic.TargetHeatingCoolingState).getValue(null, accessory.mode);
            } else {
              accessory.targetTemp = Math.min(38, targetTemp);
              if (mode === 1) {
                accessory.heating = Math.min(30, targetTemp);
                accessory.thermostatService.getCharacteristic(this.api.hap.Characteristic.HeatingThresholdTemperature).getValue(null, accessory.heating);
              } else if (mode === 2) {
                accessory.cooling = Math.min(35, targetTemp);
                accessory.thermostatService.getCharacteristic(this.api.hap.Characteristic.CoolingThresholdTemperature).getValue(null, accessory.cooling);
              }
              if (accessory.mode === 1) {
                accessory.targetTemp = accessory.heating;
              } else if (accessory.mode === 2) {
                accessory.targetTemp = accessory.cooling;
              } else if (accessory.mode === 3) {
                accessory.targetTemp = (accessory.temperature <= accessory.heating) ? accessory.heating : accessory.cooling;
              }
              accessory.thermostatService.getCharacteristic(this.api.hap.Characteristic.TargetTemperature).getValue(null, accessory.targetTemp);
            }
          }
        }
      });
    });

    this.infusion.on('thermostatDidChange', (value: number) => {
      this.items.forEach((accessory) => {
        if (accessory.type === 'thermostat') {
          if (accessory.thermostatService !== undefined) {
            this.infusion.Thermostat_GetIndoorTemperature(accessory.address);
            this.infusion.Thermostat_GetState(accessory.address);
            this.infusion.Thermostat_GetHeating(accessory.address);
            this.infusion.Thermostat_GetCooling(accessory.address);
            this.infusion.Thermostat_GetState(accessory.address);
          }
        }
      });
    });

    this.infusion.on('thermostatIndoorTemperatureChange', (vid: number, value: number) => {
      this.items.forEach((accessory) => {
        if (accessory.address === vid.toString()) {
          accessory.temperature = parseFloat(value.toString());
          if (accessory.temperature > 100) {
            accessory.temperature = 100;
            console.log('this accessory: ' + vid + ' is most likely not working. You should omit this device');
          }
          if (accessory.thermostatService !== undefined) {
            accessory.thermostatService.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature).getValue(null, accessory.temperature);
          }
        }
      });
    });

    this.infusion.on('endDownloadConfiguration', (configuration: string) => {
      this.log.debug('VantagePlatform for InFusion Controller (end configuration download)');
      const parsed = JSON.parse(parser.toJson(configuration));
      const dict: { [key: string]: string } = {};
      
      const areas = parsed.Project.Objects.Object.filter((el: any) => {
        const key = Object.keys(el)[0];
        return key === 'Area';
      });
      
      const area: { [key: string]: any } = {};
      for (let i = 0; i < areas.length; i++) {
        const item = areas[i].Area;
        area[item.VID] = item;
      }
      
      const blindItems: { [key: string]: string } = {};
      let range = this.range;
      const omit = this.omit;
      
      if (range !== '') {
        range = range.replace(' ', '');
        const rangeArray = range.split(',');
        if (rangeArray.length !== 2) {
          range = '0,999999999';
        }
      } else {
        range = '0,999999999';
      }
      
      const omitArray = omit !== '' ? omit.replace(' ', '').split(',') : [];

      for (let i = 0; i < parsed.Project.Objects.Object.length; i++) {
        const thisItemKey = Object.keys(parsed.Project.Objects.Object[i])[0];
        const thisItem = parsed.Project.Objects.Object[i][thisItemKey];
        
        if (!omitArray.includes(thisItem.VID) && 
            (parseInt(thisItem.VID) >= parseInt(range.split(',')[0])) && 
            (parseInt(thisItem.VID) <= parseInt(range.split(',')[1])) &&
            (this.isObjectTypeSupported(thisItem.ObjectType))) {
          
          if (thisItem.DeviceCategory === 'HVAC' || this.isThermostatType(thisItem.ObjectType)) {
            if (thisItem.DName !== undefined && thisItem.DName !== '' && (typeof thisItem.DName === 'string')) {
              thisItem.Name = thisItem.DName;
            }
            this.pendingrequests = this.pendingrequests + 1;
            this.log(sprintf.sprintf('New HVAC added (VID=%s, Name=%s, Thermostat)', thisItem.VID, thisItem.Name));
            
            let name = thisItem.Name.toString();
            if (thisItem.Area !== undefined && thisItem.Area !== '') {
              const areaVID = thisItem.Area;
              if (area[areaVID] !== undefined && area[areaVID].Name !== undefined && area[areaVID].Name !== '') {
                name = area[areaVID].Name + ' ' + name;
              }
            }

            name = name.replace('-', '');
            if (dict[name.toLowerCase()] === undefined && name !== '') {
              dict[name.toLowerCase()] = name;
            } else {
              name = name + ' VID' + thisItem.VID;
              dict[name.toLowerCase()] = name;
            }
            
            this.items.push({
              name: name,
              address: thisItem.VID,
              type: 'thermostat',
              vid: thisItem.VID,
              objectType: thisItem.ObjectType,
              temperature: 0,
              targetTemp: 0,
              heating: 0,
              cooling: 0,
              mode: 0,
              current: 0,
              units: 1
            });
            
            this.pendingrequests = this.pendingrequests - 1;
            this.callbackPromesedAccessoriesDo();
          }
          
          if (this.isLoadType(thisItem.ObjectType)) {
            if (thisItem.DName !== undefined && thisItem.DName !== '' && (typeof thisItem.DName === 'string')) {
              thisItem.Name = thisItem.DName;
            }
            this.pendingrequests = this.pendingrequests + 1;
            
            let name = thisItem.Name.toString();
            if (thisItem.Area !== undefined && thisItem.Area !== '') {
              const areaVID = thisItem.Area;
              if (area[areaVID] !== undefined && area[areaVID].Name !== undefined && area[areaVID].Name !== '') {
                name = area[areaVID].Name + ' ' + name;
              }
            }
            
            name = name.replace('-', '');
            if (dict[name.toLowerCase()] === undefined && name !== '') {
              dict[name.toLowerCase()] = name;
            } else {
              name = name + ' VID' + thisItem.VID;
              dict[name.toLowerCase()] = name;
            }
            
            if (this.isRelayType(thisItem)) {
              this.log(sprintf.sprintf('New relay added (VID=%s, Name=%s, RELAY)', thisItem.VID, thisItem.Name));
              this.items.push({
                name: name,
                address: thisItem.VID,
                type: 'relay',
                vid: thisItem.VID,
                objectType: thisItem.ObjectType,
                loadType: thisItem.LoadType,
                bri: 100,
                power: false
              });
            } else if (thisItem.ObjectType === 'Vantage.DDGColorLoad') {
              this.log(sprintf.sprintf('New load added (VID=%s, Name=%s, RGB)', thisItem.VID, thisItem.Name));
              this.items.push({
                name: name,
                address: thisItem.VID,
                type: 'rgb',
                vid: thisItem.VID,
                objectType: thisItem.ObjectType,
                loadType: thisItem.LoadType,
                bri: 100,
                power: false,
                sat: 0,
                hue: 0
              });
            } else {
              this.log(sprintf.sprintf('New load added (VID=%s, Name=%s, DIMMER)', thisItem.VID, thisItem.Name));
              this.items.push({
                name: name,
                address: thisItem.VID,
                type: 'dimmer',
                vid: thisItem.VID,
                objectType: thisItem.ObjectType,
                loadType: thisItem.LoadType,
                bri: 100,
                power: false
              });
            }
            
            this.pendingrequests = this.pendingrequests - 1;
            this.callbackPromesedAccessoriesDo();
          }
          
          if (this.isBlindType(thisItem.ObjectType)) {
            if (thisItem.DName !== undefined && thisItem.DName !== '' && (typeof thisItem.DName === 'string')) {
              thisItem.Name = thisItem.DName;
            }
            this.pendingrequests = this.pendingrequests + 1;
            
            let name = thisItem.Name.toString();
            if (thisItem.Area !== undefined && thisItem.Area !== '') {
              const areaVID = thisItem.Area;
              if (area[areaVID] !== undefined && area[areaVID].Name !== undefined && area[areaVID].Name !== '') {
                name = area[areaVID].Name + ' ' + name;
              }
            }
            
            name = name.replace('-', '');
            if (dict[name.toLowerCase()] === undefined && name !== '') {
              dict[name.toLowerCase()] = name;
            } else {
              name = name + ' VID' + thisItem.VID;
              dict[name.toLowerCase()] = name;
            }
            
            if (thisItem.ObjectType === 'RelayBlind') {
              blindItems[thisItem.OpenLoad] = thisItem.OpenLoad;
              blindItems[thisItem.CloseLoad] = thisItem.CloseLoad;
            }
            
            this.log(sprintf.sprintf('New Blind added (VID=%s, Name=%s, BLIND)', thisItem.VID, thisItem.Name));
            this.items.push({
              name: name,
              address: thisItem.VID,
              type: 'blind',
              vid: thisItem.VID,
              objectType: thisItem.ObjectType,
              pos: 100,
              posState: 2
            });
            
            this.pendingrequests = this.pendingrequests - 1;
            this.callbackPromesedAccessoriesDo();
          }
        }
      }
      
      for (let i = 0; i < this.items.length; i++) {
        if (blindItems[this.items[i].address]) {
          this.items.splice(i, 1);
          i--;
        }
      }
      
      this.log(sprintf.sprintf('Found %f devices', this.items.length));
      if (this.items.length >= 150) {
        this.log(sprintf.sprintf('Number of devices exceeds Apples limit of 149. Only loading first 149 devices. Please omit some loads'));
        this.items.splice(149);
      }
      
      this.log.warn('VantagePlatform for InFusion Controller (end configuration store)');
      this.ready = true;
      this.callbackPromesedAccessoriesDo();
    });
  }

  private isObjectTypeSupported(objectType: string): boolean {
    const supportedTypes = [
      'Area', 'Load', 'Vantage.DDGColorLoad', 'Legrand.MH_Relay_CHILD', 'Legrand.MH_Dimmer_CHILD',
      'Jandy.Aqualink_RS_Pump_CHILD', 'Jandy.Aqualink_RS_Auxiliary_CHILD', 'Thermostat',
      'Vantage.HVAC-Interface_Point_Zone_CHILD', 'Vantage.VirtualThermostat_PORT',
      'Tekmar.tN4_Gateway_482_Zone_-_Slab_Only_CHILD', 'Tekmar.tN4_Gateway_482_Zone_CHILD',
      'Legrand.MH_HVAC_Control_CHILD', 'Blind', 'RelayBlind', 'QISBlind',
      'Lutron.Shade_x2F_Blind_Child_CHILD', 'QubeBlind', 'ESI.RQShadeChannel_CHILD',
      'QMotion.QIS_Channel_CHILD', 'Somfy.UAI-RS485-Motor_CHILD'
    ];
    return supportedTypes.includes(objectType);
  }

  private isThermostatType(objectType: string): boolean {
    const thermostatTypes = [
      'Thermostat', 'Vantage.HVAC-Interface_Point_Zone_CHILD', 'Vantage.VirtualThermostat_PORT',
      'Tekmar.tN4_Gateway_482_Zone_-_Slab_Only_CHILD', 'Tekmar.tN4_Gateway_482_Zone_CHILD',
      'Legrand.MH_HVAC_Control_CHILD'
    ];
    return thermostatTypes.includes(objectType);
  }

  private isLoadType(objectType: string): boolean {
    const loadTypes = [
      'Load', 'Vantage.DDGColorLoad', 'Jandy.Aqualink_RS_Auxiliary_CHILD',
      'Jandy.Aqualink_RS_Pump_CHILD', 'Legrand.MH_Relay_CHILD', 'Legrand.MH_Dimmer_CHILD'
    ];
    return loadTypes.includes(objectType);
  }

  private isBlindType(objectType: string): boolean {
    const blindTypes = [
      'Blind', 'RelayBlind', 'QISBlind', 'Lutron.Shade_x2F_Blind_Child_CHILD',
      'QubeBlind', 'ESI.RQShadeChannel_CHILD', 'QMotion.QIS_Channel_CHILD',
      'Somfy.UAI-RS485-Motor_CHILD'
    ];
    return blindTypes.includes(objectType);
  }

  private isRelayType(item: any): boolean {
    const relayTypes = [
      'Jandy.Aqualink_RS_Pump_CHILD', 'Jandy.Aqualink_RS_Auxiliary_CHILD',
      'Legrand.MH_Relay_CHILD'
    ];
    const relayLoadTypes = [
      'Fluor. Mag non-Dim', 'LED non-Dim', 'Fluor. Electronic non-Dim',
      'Low Voltage Relay', 'Motor', 'High Voltage Relay'
    ];
    return relayTypes.includes(item.ObjectType) || relayLoadTypes.includes(item.LoadType);
  }

  private callbackPromesedAccessoriesDo(): void {
    if (this.callbackPromesedAccessories !== undefined && this.ready && this.pendingrequests === 0) {
      this.log.warn('VantagePlatform for InFusion Controller (is open for business)');
      this.callbackPromesedAccessories(this.items);
    } else {
      this.log.debug(sprintf.sprintf('VantagePlatform for InFusion Controller (%s,%s)', this.ready, this.pendingrequests));
    }
  }

  public getDevices(): Promise<VantageDevice[]> {
    return new Promise((resolve, reject) => {
      if (!this.ready) {
        this.log.debug('VantagePlatform for InFusion Controller (wait for getDevices promise)');
        this.callbackPromesedAccessories = resolve;
      } else {
        resolve(this.items);
      }
    });
  }

  public accessories(callback: (devices: VantageDevice[]) => void): void {
    this.getDevices().then((devices) => {
      this.log.debug('VantagePlatform for InFusion Controller (accessories readed)');
      callback(devices);
    });
  }

  public getInfusion(): VantageInfusion {
    return this.infusion;
  }
} 