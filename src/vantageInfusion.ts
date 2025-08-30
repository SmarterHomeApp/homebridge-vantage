import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs';
import * as sprintf from 'sprintf-js';

import * as sleep from 'sleep';
import { EventEmitter } from 'events';
import { VantageInfusionConfig, InterfaceSupportResult } from './types';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const typeThermo = [
  'Thermostat',
  'Vantage.HVAC-Interface_Point_Zone_CHILD',
  'Vantage.VirtualThermostat_PORT',
  'Tekmar.tN4_Gateway_482_Zone_-_Slab_Only_CHILD',
  'Tekmar.tN4_Gateway_482_Zone_CHILD',
  'Legrand.MH_HVAC_Control_CHILD'
];

const typeBlind = [
  'Blind',
  'RelayBlind',
  'QISBlind',
  'Lutron.Shade_x2F_Blind_Child_CHILD',
  'QubeBlind',
  'ESI.RQShadeChannel_CHILD',
  'QMotion.QIS_Channel_CHILD',
  'Somfy.UAI-RS485-Motor_CHILD'
];

const objectTypes = [
  'Area',
  'Load',
  'Vantage.DDGColorLoad',
  'Legrand.MH_Relay_CHILD',
  'Legrand.MH_Dimmer_CHILD',
  'Jandy.Aqualink_RS_Pump_CHILD',
  'Jandy.Aqualink_RS_Auxiliary_CHILD'
].concat(typeThermo).concat(typeBlind);

const useBackup = false;
const useSecure = false;

export class VantageInfusion extends EventEmitter {
  private ipaddress: string;
  private usecache: boolean;
  private accessories: any[];
  private omit: string;
  private range: string;
  private username: string;
  private password: string;
  private command: any;
  private interfaces: { [key: string]: number } = {};
  private isInsecure: boolean;
  private xmlParser: XMLParser;
  private xmlBuilder: XMLBuilder;

  constructor(config: VantageInfusionConfig) {
    super();
    this.ipaddress = config.ipaddress;
    this.usecache = config.usecache;
    this.accessories = config.accessories || [];
    this.omit = config.omit;
    this.range = config.range;
    this.username = config.username;
    this.password = config.password;
    this.isInsecure = config.isInsecure;
    
    // Initialize XML parsers
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_"
    });
    this.xmlBuilder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: "@_"
    });

    if (this.isInsecure && !useSecure) {
      this.startCommand();
    } else {
      this.startCommandSSL();
    }
  }

  private startCommand(): void {
    this.command = net.connect({ host: this.ipaddress, port: 3001 }, () => {
      if (this.username !== '' && this.password !== '') {
        this.command.write(sprintf.sprintf('Login %s %s\n', this.username, this.password));
      }
      console.log('connected');
      this.command.write(sprintf.sprintf('STATUS ALL\n'));
      this.command.write(sprintf.sprintf('ELENABLE 1 AUTOMATION ON\nELENABLE 1 EVENT ON\nELENABLE 1 STATUS ON\nELENABLE 1 STATUSEX ON\nELENABLE 1 SYSTEM ON\nELLOG AUTOMATION ON\nELLOG EVENT ON\nELLOG STATUS ON\nELLOG STATUSEX ON\nELLOG SYSTEM ON\n'));
    });

    this.command.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (let i = 0; i < lines.length; i++) {
        const dataItem = lines[i].split(' ');
        try {
          if (lines[i].startsWith('S:BLIND') || lines[i].startsWith('R:GETBLIND') || (lines[i].startsWith('R:INVOKE') && dataItem[3]?.includes('Blind'))) {
            this.emit('blindStatusChange', parseInt(dataItem[1]), parseInt(dataItem[2]));
          }
          if (lines[i].startsWith('S:LOAD ') || lines[i].startsWith('R:GETLOAD ')) {
            this.emit('loadStatusChange', parseInt(dataItem[1]), parseInt(dataItem[2]));
          }
          if (dataItem[0] === 'R:INVOKE' && dataItem[3]?.includes('RGBLoad.GetHSL')) {
            this.emit('loadStatusChange', parseInt(dataItem[1]), parseInt(dataItem[2]), parseInt(dataItem[4]));
          }
          if (dataItem[0] === 'S:TEMP') {
            this.emit('thermostatDidChange', parseInt(dataItem[2]));
          } else if (dataItem[0] === 'R:INVOKE' && dataItem[3]?.includes('Thermostat.GetIndoorTemperature')) {
            this.emit('thermostatIndoorTemperatureChange', parseInt(dataItem[1]), parseFloat(dataItem[2]));
          } else if (dataItem[0] === 'S:THERMOP' || dataItem[0] === 'R:GETTHERMOP' || dataItem[0] === 'R:THERMTEMP') {
            let modeVal = 0;
            if (dataItem[2]?.includes('OFF')) {
              modeVal = 0;
            } else if (dataItem[2]?.includes('HEAT')) {
              modeVal = 1;
            } else if (dataItem[2]?.includes('COOL')) {
              modeVal = 2;
            } else {
              modeVal = 3;
            }
            if (dataItem[0] === 'S:THERMOP' || dataItem[0] === 'R:GETTHERMOP') {
              this.emit('thermostatIndoorModeChange', parseInt(dataItem[1]), parseInt(modeVal.toString()), -1);
            } else {
              this.emit('thermostatIndoorModeChange', parseInt(dataItem[1]), parseInt(modeVal.toString()), parseFloat(dataItem[3]));
            }
          }
        } catch (error) {
          console.log('unable to update status');
        }

        if (lines[i].startsWith('R:INVOKE') && lines[i].indexOf('Object.IsInterfaceSupported')) {
          this.emit(sprintf.sprintf('isInterfaceSupportedAnswer-%d-%d', parseInt(dataItem[1]), parseInt(dataItem[4])), parseInt(dataItem[2]));
        }
      }
    });

    this.command.on('close', () => {
      console.log('\n\nPort 3001 has closed!!\n\n');
      this.reconnect();
    });

    this.command.on('end', () => {
      console.log('Port 3001 has ended!!');
    });

    this.command.on('error', console.error);
  }

  private reconnect(): void {
    console.log('Attempting reconnect!');
    this.command.removeAllListeners();
    this.command.destroy();
    setTimeout(() => {
      if (this.isInsecure && !useSecure) {
        this.startCommand();
      } else {
        this.startCommandSSL();
      }
    }, 5000);
  }

  private startCommandSSL(): void {
    const options = {
      rejectUnauthorized: false,
      requestCert: true
    };

    const socket = tls.connect(3010, this.ipaddress, options, () => {
      if (this.username !== '' && this.password !== '') {
        socket.write(sprintf.sprintf('Login %s %s\n', this.username, this.password));
      }
      socket.write(sprintf.sprintf('STATUS ALL\n'));
      socket.write(sprintf.sprintf('ELENABLE 1 AUTOMATION ON\nELENABLE 1 EVENT ON\nELENABLE 1 STATUS ON\nELENABLE 1 STATUSEX ON\nELENABLE 1 SYSTEM ON\nELLOG AUTOMATION ON\nELLOG EVENT ON\nELLOG STATUS ON\nELLOG STATUSEX ON\nELLOG SYSTEM ON\n'));
    });

    socket.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (let i = 0; i < lines.length; i++) {
        const dataItem = lines[i].split(' ');
        try {
          if (lines[i].startsWith('S:BLIND') || lines[i].startsWith('R:GETBLIND') || (lines[i].startsWith('R:INVOKE') && dataItem[3]?.includes('Blind'))) {
            this.emit('blindStatusChange', parseInt(dataItem[1]), parseInt(dataItem[2]));
          }
          if (lines[i].startsWith('S:LOAD ') || lines[i].startsWith('R:GETLOAD ')) {
            this.emit('loadStatusChange', parseInt(dataItem[1]), parseInt(dataItem[2]));
          }
          if (dataItem[0] === 'R:INVOKE' && dataItem[3]?.includes('RGBLoad.GetHSL')) {
            this.emit('loadStatusChange', parseInt(dataItem[1]), parseInt(dataItem[2]), parseInt(dataItem[4]));
          }
          if (dataItem[0] === 'S:TEMP') {
            this.emit('thermostatDidChange', parseInt(dataItem[2]));
          } else if (dataItem[0] === 'R:INVOKE' && dataItem[3]?.includes('Thermostat.GetIndoorTemperature')) {
            this.emit('thermostatIndoorTemperatureChange', parseInt(dataItem[1]), parseFloat(dataItem[2]));
          } else if (dataItem[0] === 'S:THERMOP' || dataItem[0] === 'R:GETTHERMOP' || dataItem[0] === 'R:THERMTEMP') {
            let modeVal = 0;
            if (dataItem[2]?.includes('OFF')) {
              modeVal = 0;
            } else if (dataItem[2]?.includes('HEAT')) {
              modeVal = 1;
            } else if (dataItem[2]?.includes('COOL')) {
              modeVal = 2;
            } else {
              modeVal = 3;
            }
            if (dataItem[0] === 'S:THERMOP' || dataItem[0] === 'R:GETTHERMOP') {
              this.emit('thermostatIndoorModeChange', parseInt(dataItem[1]), parseInt(modeVal.toString()), -1);
            } else {
              this.emit('thermostatIndoorModeChange', parseInt(dataItem[1]), parseInt(modeVal.toString()), parseFloat(dataItem[3]));
            }
          }
        } catch (error) {
          console.log('unable to update status');
        }

        if (lines[i].startsWith('R:INVOKE') && lines[i].indexOf('Object.IsInterfaceSupported')) {
          this.emit(sprintf.sprintf('isInterfaceSupportedAnswer-%d-%d', parseInt(dataItem[1]), parseInt(dataItem[4])), parseInt(dataItem[2]));
        }
      }
    });

    socket.on('close', () => {
      console.log('\nPort 3010 has closed!!\n');
      socket.removeAllListeners();
      socket.destroy();
      this.reconnect();
    });

    socket.on('end', () => {
      console.log('Port 3010 has ended !!');
    });

    socket.on('error', console.error);

    this.command = socket;
  }

  public getLoadStatus(vid: string): void {
    this.command.write(sprintf.sprintf('GETLOAD %s\n', vid));
  }

  public getLoadHSL(vid: string, val: string): void {
    this.command.write(sprintf.sprintf('INVOKE %s RGBLoad.GetHSL %s\n', vid, val));
  }

  public isInterfaceSupported(item: any, interfaceName: string): Promise<InterfaceSupportResult> {
    if (this.interfaces[interfaceName] === undefined) {
      return Promise.resolve({ item, interface: interfaceName, support: false });
    } else {
      const interfaceId = this.interfaces[interfaceName];

      return new Promise((resolve) => {
        this.once(sprintf.sprintf('isInterfaceSupportedAnswer-%d-%d', parseInt(item.VID), parseInt(interfaceId.toString())), (support: number) => {
          resolve({ item, interface: interfaceName, support: support === 1 });
        });
        sleep.usleep(5000);
        this.command.write(sprintf.sprintf('INVOKE %s Object.IsInterfaceSupported %s\n', item.VID, interfaceId));
      });
    }
  }

  public discover(): void {
    const configuration = net.connect({ host: this.ipaddress, port: 2001 }, () => {
      console.log('load dc file');

      let buffer = '';
      let xmlResult = '';
      const readObjects: any[] = [];
      let writeCount = 0;
      const objectDict: { [key: string]: string } = {};
      let controller = 1;
      let shouldbreak = false;

      configuration.on('data', (data: Buffer) => {
        buffer = buffer + data.toString().replace('\ufeff', '');

        try {
          if (useBackup) {
            buffer = buffer.replace('<?File Encode="Base64" /', '<File>');
            buffer = buffer.replace('?>', '</File>');

            if (buffer.includes('</File>')) {
              console.log('end');
              const start = buffer.split('<File>');
              const end = buffer.split('</File>');

              const match = buffer.match('<File>' + '(.*?)' + '</File>');
              if (match) {
                buffer = match[1];
                let newtext = Buffer.from(buffer, 'base64').toString();
                newtext = newtext.replace(/[\r\n]/g, '');
                const init = newtext.split('<Objects>');
                const objMatch = newtext.match('<Objects>' + '(.*?)' + '</Objects>');
                if (objMatch) {
                  xmlResult = Buffer.from(init[0] + '<Objects>' + objMatch[1] + '</Objects></Project>').toString('base64');
                  buffer = '<smarterHome>' + start[0] + '<File>' + xmlResult + '</File>' + end[end.length - 1] + '</smarterHome>';
                }
              }
            }
          }
          // libxmljs.parseXml(buffer); // Removed libxmljs
        } catch (e) {
          return false;
        }

        if (writeCount < objectTypes.length) {
          console.log('parse Json: ' + objectTypes[writeCount] + ' on controller: ' + controller.toString());
        }

        const parsed = JSON.parse(parser.toJson(buffer));
        if (parsed.smarterHome !== undefined) {
          if (parsed.smarterHome.IIntrospection !== undefined) {
            const interfaces = parsed.smarterHome.IIntrospection.GetInterfaces.return.Interface;
            for (let i = 0; i < interfaces.length; i++) {
              this.interfaces[interfaces[i].Name] = interfaces[i].IID;
            }
          }
          if (parsed.smarterHome.IBackup !== undefined) {
            const xmlconfiguration = Buffer.from(parsed.smarterHome.IBackup.GetFile.return.File, 'base64').toString('ascii');
            fs.writeFileSync('/tmp/vantage.dc', xmlconfiguration);
            this.emit('endDownloadConfiguration', xmlconfiguration);
            configuration.destroy();
          }
        } else if (parsed.IConfiguration !== undefined) {
          if (parsed.IConfiguration.OpenFilter !== undefined) {
            if (!buffer.includes('<?Master ' + controller.toString() + '?>')) {
              if (controller === 1) {
                const tmpStr = buffer.slice(9);
                const res = tmpStr.split('?');
                controller = parseInt(res[0]);
              } else {
                shouldbreak = true;
              }
            }
            const objectValue = parsed.IConfiguration.OpenFilter.return;
            if (objectDict[objectValue] === undefined && !shouldbreak) {
              buffer = '';
              objectDict[objectValue] = objectValue;
              writeCount++;
              configuration.write('<IConfiguration><GetFilterResults><call><Count>1000</Count><WholeObject>true</WholeObject><hFilter>' + objectValue + '</hFilter></call></GetFilterResults></IConfiguration>\n');
            }
          } else if (parsed.IConfiguration.GetFilterResults !== undefined) {
            const elements = parsed.IConfiguration.GetFilterResults.return.Object;
            if (elements !== undefined && !shouldbreak) {
              if (elements.length === undefined) {
                const element = elements[objectTypes[writeCount - 1]];
                element['ObjectType'] = objectTypes[writeCount - 1];
                const elemDict: { [key: string]: any } = {};
                elemDict[objectTypes[writeCount - 1]] = element;
                readObjects.push(elemDict);
              } else {
                for (let i = 0; i < elements.length; i++) {
                  const element = elements[i][objectTypes[writeCount - 1]];
                  element['ObjectType'] = objectTypes[writeCount - 1];
                  const elemDict: { [key: string]: any } = {};
                  elemDict[objectTypes[writeCount - 1]] = element;
                  readObjects.push(elemDict);
                }
              }
            }

            buffer = '';
            if (writeCount >= objectTypes.length) {
              controller++;
              writeCount = 0;
            }
            configuration.write('<?Master ' + controller.toString() + '?><IConfiguration><OpenFilter><call><Objects><ObjectType>' + objectTypes[writeCount] + '</ObjectType></Objects></call></OpenFilter></IConfiguration>\n');
          }
          if (shouldbreak) {
            const result: any = {};
            result['Project'] = {};
            result['Project']['Objects'] = {};
            result['Project']['Objects']['Object'] = readObjects;
            const options = { sanitize: true };
            const xmlResult = parser.toXml(result, options);
            fs.writeFileSync('/tmp/vantage.dc', xmlResult);
            this.emit('endDownloadConfiguration', xmlResult);
            configuration.destroy();
          }
        } else if (parsed.ILogin !== undefined) {
          if (parsed.ILogin.Login !== undefined) {
            if (parsed.ILogin.Login.return === 'true') {
              console.log('Login successful');
            } else {
              console.log('Login failed trying to get data anyways');
            }
            buffer = '';
            if (useBackup) {
              configuration.write('<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n');
            } else {
              configuration.write('<?Master ' + controller.toString() + '?><IConfiguration><OpenFilter><call><Objects><ObjectType>' + objectTypes[0] + '</ObjectType></Objects></call></OpenFilter></IConfiguration>\n');
            }
          }
        }
        buffer = '';
      });

      if (fs.existsSync('/tmp/vantage.dc') && this.usecache) {
        fs.readFile('/tmp/vantage.dc', 'utf8', (err, data) => {
          if (!err) {
            this.emit('endDownloadConfiguration', data);
          }
        });
      } else if (fs.existsSync('/home/pi/vantage.dc') && this.usecache) {
        fs.readFile('/home/pi/vantage.dc', 'utf8', (err, data) => {
          if (!err) {
            this.emit('endDownloadConfiguration', data);
          }
        });
      } else {
        if (this.username !== '' && this.password !== '') {
          configuration.write('<ILogin><Login><call><User>' + this.username + '</User><Password>' + this.password + '</Password></call></Login></ILogin>\n');
        } else {
          if (useBackup) {
            configuration.write('<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n');
          } else {
            configuration.write('<?Master ' + controller.toString() + '?><IConfiguration><OpenFilter><call><Objects><ObjectType>' + objectTypes[0] + '</ObjectType></Objects></call></OpenFilter></IConfiguration>\n');
          }
        }
      }
    });
  }

  public discoverSSL(): void {
    const options = {
      rejectUnauthorized: false,
      requestCert: true
    };

    const configuration = tls.connect(2010, this.ipaddress, options, () => {
      console.log('load dc file');

      let buffer = '';
      let xmlResult = '';
      const readObjects: any[] = [];
      let writeCount = 0;
      const objectDict: { [key: string]: string } = {};
      let controller = 1;
      let shouldbreak = false;

      configuration.on('data', (data: Buffer) => {
        buffer = buffer + data.toString().replace('\ufeff', '');

        try {
          if (useBackup) {
            buffer = buffer.replace('<?File Encode="Base64" /', '<File>');
            buffer = buffer.replace('?>', '</File>');

            if (buffer.includes('</File>')) {
              console.log('end');
              const start = buffer.split('<File>');
              const end = buffer.split('</File>');

              const match = buffer.match('<File>' + '(.*?)' + '</File>');
              if (match) {
                buffer = match[1];
                let newtext = Buffer.from(buffer, 'base64').toString();
                newtext = newtext.replace(/[\r\n]/g, '');
                const init = newtext.split('<Objects>');
                const objMatch = newtext.match('<Objects>' + '(.*?)' + '</Objects>');
                if (objMatch) {
                  xmlResult = Buffer.from(init[0] + '<Objects>' + objMatch[1] + '</Objects></Project>').toString('base64');
                  buffer = '<smarterHome>' + start[0] + '<File>' + xmlResult + '</File>' + end[end.length - 1] + '</smarterHome>';
                }
              }
            }
          }
          // libxmljs.parseXml(buffer); // Removed libxmljs
        } catch (e) {
          return false;
        }

        if (writeCount < objectTypes.length) {
          console.log('parse Json: ' + objectTypes[writeCount] + ' on controller: ' + controller.toString());
        }

        const parsed = JSON.parse(parser.toJson(buffer));
        if (parsed.smarterHome !== undefined) {
          if (parsed.smarterHome.IIntrospection !== undefined) {
            const interfaces = parsed.smarterHome.IIntrospection.GetInterfaces.return.Interface;
            for (let i = 0; i < interfaces.length; i++) {
              this.interfaces[interfaces[i].Name] = interfaces[i].IID;
            }
          }
          if (parsed.smarterHome.IBackup !== undefined) {
            const xmlconfiguration = Buffer.from(parsed.smarterHome.IBackup.GetFile.return.File, 'base64').toString('ascii');
            fs.writeFileSync('/tmp/vantage.dc', xmlconfiguration);
            this.emit('endDownloadConfiguration', xmlconfiguration);
            configuration.destroy();
          }
        } else if (parsed.IConfiguration !== undefined) {
          if (parsed.IConfiguration.OpenFilter !== undefined) {
            if (!buffer.includes('<?Master ' + controller.toString() + '?>')) {
              if (controller === 1) {
                const tmpStr = buffer.slice(9);
                const res = tmpStr.split('?');
                controller = parseInt(res[0]);
              } else {
                shouldbreak = true;
              }
            }
            const objectValue = parsed.IConfiguration.OpenFilter.return;
            if (objectDict[objectValue] === undefined && !shouldbreak) {
              buffer = '';
              objectDict[objectValue] = objectValue;
              writeCount++;
              configuration.write('<IConfiguration><GetFilterResults><call><Count>1000</Count><WholeObject>true</WholeObject><hFilter>' + objectValue + '</hFilter></call></GetFilterResults></IConfiguration>\n');
            }
          } else if (parsed.IConfiguration.GetFilterResults !== undefined) {
            const elements = parsed.IConfiguration.GetFilterResults.return.Object;
            if (elements !== undefined && !shouldbreak) {
              if (elements.length === undefined) {
                const element = elements[objectTypes[writeCount - 1]];
                element['ObjectType'] = objectTypes[writeCount - 1];
                const elemDict: { [key: string]: any } = {};
                elemDict[objectTypes[writeCount - 1]] = element;
                readObjects.push(elemDict);
              } else {
                for (let i = 0; i < elements.length; i++) {
                  const element = elements[i][objectTypes[writeCount - 1]];
                  element['ObjectType'] = objectTypes[writeCount - 1];
                  const elemDict: { [key: string]: any } = {};
                  elemDict[objectTypes[writeCount - 1]] = element;
                  readObjects.push(elemDict);
                }
              }
            }

            buffer = '';
            if (writeCount >= objectTypes.length) {
              controller++;
              writeCount = 0;
            }
            configuration.write('<?Master ' + controller.toString() + '?><IConfiguration><OpenFilter><call><Objects><ObjectType>' + objectTypes[writeCount] + '</ObjectType></Objects></call></OpenFilter></IConfiguration>\n');
          }
          if (shouldbreak) {
            const result: any = {};
            result['Project'] = {};
            result['Project']['Objects'] = {};
            result['Project']['Objects']['Object'] = readObjects;
            const options = { sanitize: true };
            const xmlResult = parser.toXml(result, options);
            fs.writeFileSync('/tmp/vantage.dc', xmlResult);
            this.emit('endDownloadConfiguration', xmlResult);
            configuration.destroy();
          }
        } else if (parsed.ILogin !== undefined) {
          if (parsed.ILogin.Login !== undefined) {
            if (parsed.ILogin.Login.return === 'true') {
              console.log('Login successful');
            } else {
              console.log('Login failed trying to get data anyways');
            }
            buffer = '';
            if (useBackup) {
              configuration.write('<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n');
            } else {
              configuration.write('<?Master ' + controller.toString() + '?><IConfiguration><OpenFilter><call><Objects><ObjectType>' + objectTypes[0] + '</ObjectType></Objects></call></OpenFilter></IConfiguration>\n');
            }
          }
        }
        buffer = '';
      });

      if (fs.existsSync('/tmp/vantage.dc') && this.usecache) {
        fs.readFile('/tmp/vantage.dc', 'utf8', (err, data) => {
          if (!err) {
            this.emit('endDownloadConfiguration', data);
          }
        });
      } else if (fs.existsSync('/home/pi/vantage.dc') && this.usecache) {
        fs.readFile('/home/pi/vantage.dc', 'utf8', (err, data) => {
          if (!err) {
            this.emit('endDownloadConfiguration', data);
          }
        });
      } else {
        if (this.username !== '' && this.password !== '') {
          configuration.write('<ILogin><Login><call><User>' + this.username + '</User><Password>' + this.password + '</Password></call></Login></ILogin>\n');
        } else {
          if (useBackup) {
            configuration.write('<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n');
          } else {
            configuration.write('<?Master ' + controller.toString() + '?><IConfiguration><OpenFilter><call><Objects><ObjectType>' + objectTypes[0] + '</ObjectType></Objects></call></OpenFilter></IConfiguration>\n');
          }
        }
      }
    });
  }

  public RGBLoad_DissolveHSL(vid: string, h: number, s: number, l: number): void {
    this.command.write(sprintf.sprintf('INVOKE %s RGBLoad.SetHSL %s %s %s %s\n', vid, h, s, l));
  }

  public Thermostat_GetOutdoorTemperature(vid: string): void {
    this.command.write(sprintf.sprintf('INVOKE %s Thermostat.GetOutdoorTemperature\n', vid));
  }

  public Thermostat_GetIndoorTemperature(vid: string): void {
    this.command.write(sprintf.sprintf('INVOKE %s Thermostat.GetIndoorTemperature\n', vid));
  }

  public Thermostat_SetTargetState(vid: string, mode: number): void {
    if (mode === 0) {
      this.command.write(sprintf.sprintf('THERMOP %s OFF\n', vid));
    } else if (mode === 1) {
      this.command.write(sprintf.sprintf('THERMOP %s HEAT\n', vid));
    } else if (mode === 2) {
      this.command.write(sprintf.sprintf('THERMOP %s COOL\n', vid));
    } else {
      this.command.write(sprintf.sprintf('THERMOP %s AUTO\n', vid));
    }
  }

  public Thermostat_GetState(vid: string): void {
    this.command.write(sprintf.sprintf('GETTHERMOP %s\n', vid));
  }

  public Thermostat_GetHeating(vid: string): void {
    this.command.write(sprintf.sprintf('GETTHERMTEMP %s HEAT\n', vid));
  }

  public Thermostat_GetCooling(vid: string): void {
    this.command.write(sprintf.sprintf('GETTHERMTEMP %s COOL\n', vid));
  }

  public Thermostat_SetIndoorTemperature(vid: string, value: number, mode: number, heating: number, cooling: number): void {
    if (mode === 1) {
      this.command.write(sprintf.sprintf('THERMTEMP %s HEAT %s\n', vid, value));
    } else if (mode === 2) {
      this.command.write(sprintf.sprintf('THERMTEMP %s COOL %s\n', vid, value));
    } else if (mode === 3) {
      if (value > cooling) {
        this.command.write(sprintf.sprintf('THERMTEMP %s COOL %s\n', vid, value));
      } else if (value < heating) {
        this.command.write(sprintf.sprintf('THERMTEMP %s HEAT %s\n', vid, value));
      }
    }
  }

  public Load_Dim(vid: string, level: number, time?: number): void {
    const thisTime = time || 1;
    this.command.write(sprintf.sprintf('INVOKE %s Load.Ramp 6 %s %s\n', vid, thisTime, level));
  }

  public setBlindPos(vid: string, pos: number): void {
    this.command.write(sprintf.sprintf('BLIND %s POS %s\n', vid, pos));
  }

  public getBlindPos(vid: string): void {
    this.command.write(sprintf.sprintf('GETBLIND %s \n', vid));
  }

  public setRelay(vid: string, level: number): void {
    this.command.write(sprintf.sprintf('LOAD %s %s\n', vid, level));
  }
} 