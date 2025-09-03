import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { Parser } from 'xml2js';
import type { Logger } from 'homebridge';
import type { VantageDevice } from './types';

const TYPE_THERMO = [
  'Thermostat',
  'Vantage.HVAC-Interface_Point_Zone_CHILD',
  'Vantage.VirtualThermostat_PORT',
  'Tekmar.tN4_Gateway_482_Zone_-_Slab_Only_CHILD',
  'Tekmar.tN4_Gateway_482_Zone_CHILD',
  'Legrand.MH_HVAC_Control_CHILD',
];

const TYPE_BLIND = [
  'Blind',
  'RelayBlind',
  'QISBlind',
  'Lutron.Shade_x2F_Blind_Child_CHILD',
  'QubeBlind',
  'ESI.RQShadeChannel_CHILD',
  'QMotion.QIS_Channel_CHILD',
  'Somfy.UAI-RS485-Motor_CHILD',
];

const OBJECT_TYPES = [
  'Area',
  'Load',
  'Vantage.DDGColorLoad',
  'Legrand.MH_Relay_CHILD',
  'Legrand.MH_Dimmer_CHILD',
  'Jandy.Aqualink_RS_Pump_CHILD',
  'Jandy.Aqualink_RS_Auxiliary_CHILD',
  ...TYPE_THERMO,
  ...TYPE_BLIND,
];

interface Options {
  ipaddress: string;
  username: string;
  password: string;
  usecache: boolean;
  omit: string;
  range: string;
  log: Logger;
  forceSSL?: boolean;
}

export class VantageInfusion extends EventEmitter {
  private readonly xml = new Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  private command!: net.Socket | tls.TLSSocket;
  private isInsecureCmd = true; // 3001 vs 3010
  private isInsecureCfg = true; // 2001 vs 2010

  constructor(private readonly opts: Options) {
    super();
  }

  /** Probe ports and open command session */
  async start() {
    if (this.opts.forceSSL) {
      this.isInsecureCmd = false;
      this.isInsecureCfg = false;
    } else {
      this.isInsecureCmd = await this.portUsable(3001, 'STATUS ALL\n');
      this.isInsecureCfg = await this.portUsable(
        2001,
        '<IIntrospection><GetInterfaces><call></call></GetInterfaces></IIntrospection>\n',
      );
    }

    // Legacy-style port logs
    this.opts.log.info(this.isInsecureCmd ? 'Using insecure port: 3001' : 'Using SSL port: 3010');
    this.opts.log.info(this.isInsecureCfg ? 'Using insecure port: 2001' : 'Using SSL port: 2010');

    await this.startCommand();
  }

  private portUsable(port: number, probe: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let sawData = false;
      const sock = net.connect({ host: this.opts.ipaddress, port }, () => {
        sock.write(probe);
      });
      sock.setTimeout(5000, () => sock.destroy());
      sock.once('connect', () => sock.setTimeout(0));
      sock.on('data', () => {
        sawData = true;
        resolve(true);
        sock.destroy();
      });
      sock.on('close', () => {
        if (!sawData) resolve(false);
      });
      sock.on('error', () => {
        /* resolve on close path */
      });
    });
  }

  private async startCommand() {
    return new Promise<void>((resolve) => {
      const onConnect = (socket: net.Socket | tls.TLSSocket) => {
        this.command = socket;

        // Legacy “connected” log
        this.opts.log.info(this.isInsecureCmd ? 'connected (command) — Port 3001' : 'connected (command) — Port 3010');

        if (this.opts.username && this.opts.password) {
          this.command.write(`Login ${this.opts.username} ${this.opts.password}\n`);
        }
        this.command.write('STATUS ALL\n');
        this.command.write(
          'ELENABLE 1 AUTOMATION ON\n' +
            'ELENABLE 1 EVENT ON\n' +
            'ELENABLE 1 STATUS ON\n' +
            'ELENABLE 1 STATUSEX ON\n' +
            'ELENABLE 1 SYSTEM ON\n' +
            'ELLOG AUTOMATION ON\n' +
            'ELLOG EVENT ON\n' +
            'ELLOG STATUS ON\n' +
            'ELLOG STATUSEX ON\n' +
            'ELLOG SYSTEM ON\n',
        );
        resolve();
      };

      if (this.isInsecureCmd) {
        const sock = net.connect({ host: this.opts.ipaddress, port: 3001 }, () => onConnect(sock));
        this.wireCommandSocket(sock);
      } else {
        const sock = tls.connect(
          3010,
          this.opts.ipaddress,
          { rejectUnauthorized: false, requestCert: true },
          () => onConnect(sock),
        );
        this.wireCommandSocket(sock);
      }
    });
  }

  private wireCommandSocket(sock: net.Socket | tls.TLSSocket) {
    sock.on('data', (data) => this.parseRealtime(String(data)));
    sock.on('close', () => {
      // Legacy “Port … has closed!!” lines
      this.opts.log.warn(this.isInsecureCmd ? '\n\nPort 3001 has closed!!\n\n' : '\n\nPort 3010 has closed!!\n\n');
      this.opts.log.warn('Command port closed – reconnecting in 5s');
      setTimeout(() => this.startCommand(), 5000);
    });
    sock.on('end', () => {
      // Legacy “Port … has ended!!”
      this.opts.log.warn(this.isInsecureCmd ? 'Port 3001 has ended!!' : 'Port 3010 has ended!!');
    });
    sock.on('error', (e) => this.opts.log.debug(`Command socket error: ${String(e)}`));
  }

  private parseRealtime(buffer: string) {
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (!line) continue;
      const dataItem = line.split(' ');
      this.opts.log.info(line)
      try {
        if (
          line.startsWith('S:BLIND') ||
          line.startsWith('R:GETBLIND') ||
          (line.startsWith('R:INVOKE') && (dataItem[3] || '').includes('Blind'))
        ) {
          this.emit('blindStatusChange', Number.parseInt(dataItem[1]), Number.parseInt(dataItem[2]));
        }
        if (line.startsWith('S:LOAD ') || line.startsWith('R:GETLOAD ')) {
          this.emit('loadStatusChange', Number.parseInt(dataItem[1]), Number.parseInt(dataItem[2]));
        }
        if (dataItem[0] === 'R:INVOKE' && (dataItem[3] || '').includes('RGBLoad.GetHSL')) {
          this.emit('loadStatusChange', Number.parseInt(dataItem[1]), Number.parseInt(dataItem[2]), Number.parseInt(dataItem[4]));
        }
        if (dataItem[0] === 'S:TEMP') {
          this.emit('thermostatDidChange', Number.parseInt(dataItem[2]));
        } else if (dataItem[0] === 'R:INVOKE' && (dataItem[3] || '').includes('Thermostat.GetIndoorTemperature')) {
          this.emit('thermostatIndoorTemperatureChange', Number.parseInt(dataItem[1]), Number.parseFloat(dataItem[2]));
        } else if (dataItem[0] === 'S:THERMOP' || dataItem[0] === 'R:GETTHERMOP' || dataItem[0] === 'R:THERMTEMP') {
          let modeVal = 0;
          const token = dataItem[2] || '';
          if (token.includes('OFF')) modeVal = 0;
          else if (token.includes('HEAT')) modeVal = 1;
          else if (token.includes('COOL')) modeVal = 2;
          else modeVal = 3;

          if (dataItem[0] === 'S:THERMOP' || dataItem[0] === 'R:GETTHERMOP') {
            this.emit('thermostatIndoorModeChange', Number.parseInt(dataItem[1]), modeVal, -1);
          } else {
            this.emit(
              'thermostatIndoorModeChange',
              Number.parseInt(dataItem[1]),
              modeVal,
              Number.parseFloat(dataItem[3]),
            );
          }
        }
        if (line.startsWith('R:INVOKE') && line.indexOf('Object.IsInterfaceSupported') >= 0) {
          this.emit(
            `isInterfaceSupportedAnswer-${Number.parseInt(dataItem[1])}-${Number.parseInt(dataItem[4])}`,
            Number.parseInt(dataItem[2]),
          );
        }
      } catch {
        this.opts.log.debug('Realtime parse error for line: ' + line);
      }
    }
  }

  private sanitizeXml(xml: string): string {
    // 1. Escape bare ampersands that are not part of an entity
    xml = xml.replace(/&(?!(?:amp|lt|gt|apos|quot);)/g, "&amp;");

    // 2. Example: fix <Area>16</Area> nested inside <Area>...</Area>
    //    by renaming the inner tag. Adjust this regex to your schema.
    xml = xml.replace(/<Area>(\d+)<\/Area>/g, "<AreaID>$1</AreaID>");
  
    return xml;
  }
  /** XML/config discovery; returns devices (replaces old Discover/DiscoverSSL) */
  async discoverDevices(): Promise<VantageDevice[]> {
    const xml = await this.pullConfigurationXml();
    // Legacy: “end configuration download”
    this.opts.log.debug('VantagePlatform for InFusion Controller (end configuration download)');

    const sanitized = this.sanitizeXml(xml);
    const parsed = await this.xml.parseStringPromise(sanitized).catch(() => ({} as any));
    const devices: VantageDevice[] = [];

    const objects: any[] = parsed?.Project?.Objects?.Object || [];

    const Areas = objects.filter((el: any) => Object.keys(el)[0] === 'Area');
    const Area: Record<string, any> = {};
    for (const a of Areas) Area[a.Area.VID] = a.Area;

    const omit = (this.opts.omit || '').replace(/\s+/g, '');
    const omitSet = new Set<string>(omit ? omit.split(',') : []);

    const rangeStr = (this.opts.range || '0,999999999').replace(/\s+/g, '');
    const [minVID, maxVID] = rangeStr.split(',').map((x) => Number.parseInt(x, 10));

    const blindOpenClose: Record<string, string> = {};

    for (const raw of objects) {
      const key = Object.keys(raw)[0];
      const it = raw[key];
      const vid = String(it.VID);

      if (omitSet.has(vid)) continue;
      const vidNum = Number.parseInt(vid, 10);
      if (!(vidNum >= minVID && vidNum <= maxVID)) continue;
      if (!OBJECT_TYPES.includes(it.ObjectType)) continue;

      // Normalized name (Area + Name, dedup with VID suffix)
      let name: string = String(it.DName || it.Name || '');
      if (it.Area && Area[it.Area]?.Name) name = `${Area[it.Area].Name} ${name}`;
      name = name.replace(/-/g, '') || `VID${vid}`;

      const pushUnique = (dev: VantageDevice) => {
        if (devices.find((d) => d.vid === vid)) return;
        devices.push(dev);
      };

      if (it.DeviceCategory === 'HVAC' || TYPE_THERMO.includes(it.ObjectType)) {
        this.opts.log.info(`New HVAC added (VID=${it.VID}, Name=${it.Name})`);
        pushUnique({
          name,
          address: vid,
          type: 'thermostat',
          vid,
          objectType: it.ObjectType,
          temperature: 0,
          targetTemp: 0,
          heating: 0,
          cooling: 0,
          mode: 0,
          current: 0,
          units: 1,
        });
        continue;
      }

      if (
        key === 'Load' ||
        it.ObjectType === 'Load' ||
        it.ObjectType === 'Legrand.MH_Dimmer_CHILD' ||
        it.ObjectType === 'Legrand.MH_Relay_CHILD' ||
        it.ObjectType === 'Vantage.DDGColorLoad' ||
        it.ObjectType === 'Jandy.Aqualink_RS_Auxiliary_CHILD' ||
        it.ObjectType === 'Jandy.Aqualink_RS_Pump_CHILD'
      ) {
        const isRelay =
          it.ObjectType === 'Jandy.Aqualink_RS_Pump_CHILD' ||
          it.ObjectType === 'Jandy.Aqualink_RS_Auxiliary_CHILD' ||
          it.ObjectType === 'Legrand.MH_Relay_CHILD' ||
          it.LoadType === 'Fluor. Mag non-Dim' ||
          it.LoadType === 'LED non-Dim' ||
          it.LoadType === 'Fluor. Electronic non-Dim' ||
          it.LoadType === 'Low Voltage Relay' ||
          it.LoadType === 'Motor' ||
          it.LoadType === 'High Voltage Relay';

        if (isRelay) {
          this.opts.log.info(`New relay added (VID=${it.VID}, Name=${it.Name}, RELAY)`);
          pushUnique({
            name,
            address: vid,
            type: 'relay',
            vid,
            objectType: it.ObjectType,
            loadType: it.LoadType,
            bri: 100,
            power: false,
          });
        } else if (it.ObjectType === 'Vantage.DDGColorLoad') {
          this.opts.log.info(`New load added (VID=${it.VID}, Name=${it.Name}, RGB)`);
          pushUnique({
            name,
            address: vid,
            type: 'rgb',
            vid,
            objectType: it.ObjectType,
            loadType: it.LoadType,
            bri: 100,
            power: false,
            sat: 0,
            hue: 0,
          });
        } else {
          this.opts.log.info(`New load added (VID=${it.VID}, Name=${it.Name}, DIMMER)`);
          pushUnique({
            name,
            address: vid,
            type: 'dimmer',
            vid,
            objectType: it.ObjectType,
            loadType: it.LoadType,
            bri: 100,
            power: false,
          });
        }
        continue;
      }

      if (TYPE_BLIND.includes(it.ObjectType)) {
        if (it.ObjectType === 'RelayBlind') {
          blindOpenClose[it.OpenLoad] = it.OpenLoad;
          blindOpenClose[it.CloseLoad] = it.CloseLoad;
        }
        this.opts.log.info(`New Blind added (VID=${it.VID}, Name=${it.Name}, BLIND)`);
        pushUnique({ name, address: vid, type: 'blind', vid, objectType: it.ObjectType, pos: 100, posState: 2 });
        continue;
      }
    }

    // Drop synthetic relay children of RelayBlind
    const filtered = devices.filter((d) => !blindOpenClose[d.address]);

    // Legacy “Found %f devices”
    this.opts.log.info(`Found ${filtered.length} devices`);

    if (filtered.length >= 150) {
      // Legacy Apple limit line
      this.opts.log.warn(
        'Number of devices exceeds Apples limit of 149. Only loading first 149 devices. Please omit some loads',
      );
      filtered.splice(149);
    }

    return filtered;
  }

  private pullConfigurationXml(): Promise<string> {
    return new Promise<string>((resolve) => {
      const finishOnce = (socket: net.Socket | tls.TLSSocket, xml: string) => {
        if ((finishOnce as any)._done) return;
        (finishOnce as any)._done = true;
  
        // legacy log + event
        this.opts.log.debug('VantagePlatform for InFusion Controller (end configuration download)');
        this.emit('endDownloadConfiguration', xml);
  
        try { socket.destroy(); } catch { /* noop */ }
        resolve(xml);
      };
  
      const onData = (socket: net.Socket | tls.TLSSocket) => {
        this.opts.log.info('load dc file'); // legacy
  
        let buffer = '';
        let controller = 1;
        let shouldBreak = false;
        const readObjects: any[] = [];
        const objectDict: Record<string, string> = {};
        let writeCount = 0;
  
        // progress watchdog: if we stop seeing new parsable states, finish with what we have
        let lastProgress = Date.now();
        const progress = () => { lastProgress = Date.now(); };
        const watchdog = setInterval(() => {
          if ((finishOnce as any)._done) { clearInterval(watchdog); return; }
          if (readObjects.length && Date.now() - lastProgress > 2000) {
            // Build minimal XML with what we gathered
            const xml =
              '<Project><Objects>' +
              readObjects.map((o) => {
                const k = Object.keys(o)[0];
                const v = o[k];
                const body = Object.keys(v).map((kk) => `<${kk}>${String(v[kk])}</${kk}>`).join('');
                return `<Object><${k}>${body}</${k}></Object>`;
              }).join('') +
              '</Objects></Project>';
            clearInterval(watchdog);
            finishOnce(socket, xml);
          }
        }, 750);
  
        const writeOpenFilter = () => {
          const type = OBJECT_TYPES[writeCount];
          this.opts.log.info(`parse Json: ${type} on controller: ${controller.toString()}`); // legacy text, visible
          socket.write(
            `<?Master ${controller}?>` +
            `<IConfiguration><OpenFilter><call><Objects><ObjectType>${type}</ObjectType></Objects></call></OpenFilter></IConfiguration>\n`,
          );
          progress();
        };
  
        // Kickoff (+ fallback if login never parses)
        let loginFallback: NodeJS.Timeout | null = null;
        const clearLoginFallback = () => { if (loginFallback) { clearTimeout(loginFallback); loginFallback = null; } };
  
        if (this.opts.username && this.opts.password) {
          this.opts.log.info('Kickoff: sending <ILogin>');
          socket.write(
            `<ILogin><Login><call><User>${this.opts.username}</User><Password>${this.opts.password}</Password></call></Login></ILogin>\n`,
          );
          progress();
          loginFallback = setTimeout(() => {
            this.opts.log.warn('Login response timeout — calling writeOpenFilter() anyway');
            writeOpenFilter();
          }, 2500);
        } else {
          this.opts.log.info('Kickoff: writeOpenFilter() (no login)');
          writeOpenFilter();
        }
  
        socket.on('data', (chunk) => {
          buffer += String(chunk).replace('\ufeff', '');
  
          this.xml.parseString(buffer, (err, parsedAny: any) => {
            if (err) return; // wait for more chunks
  
            const parsed = parsedAny?.smarterHome ?? parsedAny;
  
            // ----- LOGIN -----
            if (parsed?.ILogin?.Login) {
              const ok = String(parsed.ILogin.Login.return) === 'true';
              if (ok) this.opts.log.info('Login successful');
              else this.opts.log.warn('Login failed trying to get data anyways');
              buffer = '';
              clearLoginFallback();
              writeCount = 0;
              writeOpenFilter();
              // return;
            }
  
            // ----- OPEN FILTER (handle) -----
            if (parsed?.IConfiguration?.OpenFilter?.return) {
              if (!buffer.includes(`<?Master ${controller}?>`) && buffer.includes(`<?Master`)) {
                if (controller === 1) {
                  try {
                    const tmpStr = buffer.slice(9);
                    const res = tmpStr.split('?');
                    controller = parseInt(res[0])
                  } catch { /* ignore */ }
                } else {
                  this.opts.log.info("breaking")
                  shouldBreak = true;
                }
              }
              const hFilter = parsed.IConfiguration.OpenFilter.return;
              if (!objectDict[hFilter] && !shouldBreak) {
                buffer = '';
                objectDict[hFilter] = hFilter;
                writeCount++;
                socket.write(
                  `<IConfiguration><GetFilterResults><call><Count>1000</Count><WholeObject>true</WholeObject><hFilter>${hFilter}</hFilter></call></GetFilterResults></IConfiguration>\n`,
                );
                progress();
              }
            return;
            }

            // ----- GET FILTER RESULTS -----
            if (parsed?.IConfiguration?.GetFilterResults?.return?.Object) {
              const elements = parsed.IConfiguration.GetFilterResults.return.Object;
              const list = Array.isArray(elements) ? elements : [elements];
  
              for (const el of list) {
                const type = OBJECT_TYPES[writeCount - 1];
                const item = el[type] ?? el; // tolerate firmwares that return without type wrapper
                if (item) item.ObjectType = type;
                const elemDict: any = {};
                elemDict[type] = item;
                readObjects.push(elemDict);
              }
  
              buffer = '';
              if (writeCount >= OBJECT_TYPES.length) {
                controller++;
                writeCount = 0;
              }
              // writeOpenFilter()
              // return;
            }

            if (parsed?.IConfiguration?.GetFilterResults) {
              buffer = '';
              if (writeCount >= OBJECT_TYPES.length) {
                controller++;
                writeCount = 0;
              }
              writeOpenFilter()
              return;
            }
  
            // ----- END CONDITION -----
            if (shouldBreak) {
              const xml =
                '<Project><Objects>' +
                readObjects.map((o) => {
                  const k = Object.keys(o)[0];
                  const v = o[k];
                  const body = Object.keys(v).map((kk) => `<${kk}>${String(v[kk])}</${kk}>`).join('');
                  return `<Object><${k}>${body}</${k}></Object>`;
                }).join('') +
                '</Objects></Project>';
  
              clearLoginFallback();
              clearInterval(watchdog);
              finishOnce(socket, xml);
            }
          });
        });
  
        socket.on('end', () => {
          this.opts.log.info("ending" + shouldBreak)
          if (!(finishOnce as any)._done && readObjects.length) {
            const xml =
              '<Project><Objects>' +
              readObjects.map((o) => {
                const k = Object.keys(o)[0];
                const v = o[k];
                const body = Object.keys(v).map((kk) => `<${kk}>${String(v[kk])}</${kk}>`).join('');
                return `<Object><${k}>${body}</${k}></Object>`;
              }).join('') +
              '</Objects></Project>';
            clearLoginFallback();
            clearInterval(watchdog);
            finishOnce(socket, xml);
          }
        });
  
        socket.on('close', () => {
          this.opts.log.info("closing" + shouldBreak)
          if (!(finishOnce as any)._done && readObjects.length) {
            const xml =
              '<Project><Objects>' +
              readObjects.map((o) => {
                const k = Object.keys(o)[0];
                const v = o[k];
                const body = Object.keys(v).map((kk) => `<${kk}>${String(v[kk])}</${kk}>`).join('');
                return `<Object><${k}>${body}</${k}></Object>`;
              }).join('') +
              '</Objects></Project>';
            clearLoginFallback();
            clearInterval(watchdog);
            finishOnce(socket, xml);
          }
        });
      };
  
      if (this.isInsecureCfg) {
        const s = net.connect({ host: this.opts.ipaddress, port: 2001 }, () => onData(s));
      } else {
        const s = tls.connect(
          2010,
          this.opts.ipaddress,
          { rejectUnauthorized: false, requestCert: true },
          () => onData(s),
        );
      }
    });
  }
  
  

  // ===== Commands used by platformAccessory handlers =====

  async setRelayOrDim(vid: string, on: boolean, bri: number, type: VantageDevice['type']) {
    if (type === 'relay') return this.setRelay(vid, on);
    const level = on ? Math.max(1, Number(bri)) : 0;
    // Ramp (duration=1) to desired level (matches legacy Load.Ramp usage)
    this.command.write(`INVOKE ${vid} Load.Ramp 6 1 ${level}\n`);
  }

  async setBrightness(vid: string, level: number) {
    const lvl = Math.max(0, Math.min(100, Number(level)));
    this.command.write(`INVOKE ${vid} Load.Ramp 6 1 ${lvl}\n`);
  }

  async setHue(vid: string, hue: number) {
    // Note: Full HSL write typically needs current S/L. The platform also updates Saturation/Brightness shortly after.
    this.command.write(`INVOKE ${vid} RGBLoad.SetHSL ${Math.round(hue)} 100 100\n`);
  }

  async setSaturation(vid: string, sat: number) {
    // Similarly, send a best-effort write; brightness updates are handled by setBrightness
    this.command.write(`INVOKE ${vid} RGBLoad.SetHSL 0 ${Math.round(sat)} 100\n`);
  }

  async setRelay(vid: string, on: boolean) {
    const level = on ? 100 : 0;
    this.command.write(`LOAD ${vid} ${level}\n`);
  }

  async setBlindPosition(vid: string, pos: number) {
    this.command.write(`BLIND ${vid} POS ${Math.max(0, Math.min(100, Math.round(pos)))}\n`);
  }

  refreshThermostat(vid: string) {
    this.command.write(`INVOKE ${vid} Thermostat.GetIndoorTemperature\n`);
    this.command.write(`GETTHERMOP ${vid}\n`);
    this.command.write(`GETTHERMTEMP ${vid} HEAT\n`);
    this.command.write(`GETTHERMTEMP ${vid} COOL\n`);
    this.command.write(`GETTHERMOP ${vid}\n`);
  }

  async setThermostatMode(vid: string, mode: number) {
    const out = mode === 0 ? 'OFF' : mode === 1 ? 'HEAT' : mode === 2 ? 'COOL' : 'AUTO';
    this.command.write(`THERMOP ${vid} ${out}\n`);
  }

  async setThermostatTarget(vid: string, value: number, mode?: number, heating?: number, cooling?: number) {
    // Match original logic: set temperature based on mode
    const v = Math.round(value);
    if (mode === 1) {
      this.command.write(`THERMTEMP ${vid} HEAT ${v}\n`);
    } else if (mode === 2) {
      this.command.write(`THERMTEMP ${vid} COOL ${v}\n`);
    } else {
      // If no mode specified, set both (legacy behavior)
      this.command.write(`THERMTEMP ${vid} HEAT ${v}\n`);
      this.command.write(`THERMTEMP ${vid} COOL ${v}\n`);
    }
  }

  // Thermostat getter methods (from original code)
  Thermostat_GetIndoorTemperature(vid: string) {
    this.opts.log.debug(`Thermostat_GetIndoorTemperature ${vid}`);
    this.command.write(`INVOKE ${vid} Thermostat.GetIndoorTemperature\n`);
  }

  Thermostat_GetState(vid: string) {
    this.opts.log.debug(`Thermostat_GetState ${vid}`);
    this.command.write(`GETTHERMOP ${vid}\n`);
  }

  Thermostat_GetHeating(vid: string) {
    this.opts.log.debug(`Thermostat_GetHeating ${vid}`);
    this.command.write(`GETTHERMTEMP ${vid} HEAT\n`);
  }

  Thermostat_GetCooling(vid: string) {
    this.opts.log.debug(`Thermostat_GetCooling ${vid}`);
    this.command.write(`GETTHERMTEMP ${vid} COOL\n`);
  }

  // OPTIONAL: legacy name aliases (harmless no-ops to help grep/muscle memory)
  Discover() {
    return this.discoverDevices();
  }
  DiscoverSSL() {
    this.isInsecureCfg = false;
    return this.discoverDevices();
  }
}
