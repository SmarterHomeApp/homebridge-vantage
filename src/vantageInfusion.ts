import { EventEmitter } from 'events';
import * as net from 'net';
import * as tls from 'tls';
import * as dgram from 'dgram';
import { Parser } from 'xml2js';
import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import type { VantageDevice } from './types';

const CONFIGURATION_CONTROLLERS = [
  { name: 'areas', vantageTypes: ['Area'] },
  {
    name: 'loads',
    vantageTypes: [
      'Load',
      'Legrand.MH_Relay_CHILD',
      'Legrand.MH_Dimmer_CHILD',
      'Jandy.Aqualink_RS_Pump_CHILD',
      'Jandy.Aqualink_RS_Auxiliary_CHILD',
    ],
  },
  {
    name: 'rgbLoads',
    vantageTypes: ['Vantage.DGColorLoad', 'Vantage.DDGColorLoad'],
  },
  {
    name: 'blinds',
    vantageTypes: [
      'Blind',
      'RelayBlind',
      'QISBlind',
      'QubeBlind',
      'Lutron.Shade_x2F_Blind_Child_CHILD',
      'ESI.RQShadeChannel_CHILD',
      'QMotion.QIS_Channel_CHILD',
      'Somfy.UAI-RS485-Motor_CHILD',
      'Somfy.RS-485_Shade_CHILD',
      'Somfy.URTSI_2_Shade_CHILD',
    ],
  },
  {
    name: 'thermostats',
    vantageTypes: [
      'Thermostat',
      'Vantage.HVAC-Interface_Point_Zone_CHILD',
      'Vantage.Generic_HVAC_RS485_Zone_CHILD',
      'Vantage.Generic_HVAC_RS485_Zone_without_FanSpeed_CHILD',
      'Tekmar.tN4_Gateway_482_Zone_-_Slab_Only_CHILD',
      'Tekmar.tN4_Gateway_482_Zone_CHILD',
      'Legrand.MH_HVAC_Control_CHILD',
      'Vantage.HVAC-IU-Zone_CHILD',
      'Vantage.VirtualThermostat_PORT',
    ],
  },
  {
    name: 'sensors',
    vantageTypes: ['DryContact', 'Temperature', 'LightSensor', 'OmniSensor'],
  },
];

// These are controller configuration query roots, not HomeKit classification rules.
// HomeKit classification happens later from object fields/capabilities.
const CONFIG_OBJECT_TYPES = CONFIGURATION_CONTROLLERS.flatMap((controller) => controller.vantageTypes);

const DISCOVERABLE_OBJECT_TYPES = CONFIG_OBJECT_TYPES.filter((type) => type !== 'Area');

// Organize Home (`Organizer.swift`) matches HomeKit serial numbers to dump VIDs, then
// rooms via VantageAccessory.Area. sanitizeXml stores that as AreaID, so the dump
// copies AreaID back onto Area.

interface Options {
  ipaddress: string;
  username: string;
  password: string;
  usecache: boolean;
  omit: string;
  range: string;
  log: Logger;
  storagePath: string;
  forceSSL?: boolean;
  includeLights?: boolean;
  includeBlinds?: boolean;
  includeThermostats?: boolean;
  includeSensors?: boolean;
  legacyTmpCachePath?: string;
}

interface ValidatedConfiguration {
  objects: any[];
  relevantObjectCount: number;
}

type ThermostatTemperatureRole = 'indoor' | 'cool' | 'heat';

class CandidateConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateConfigurationError';
  }
}

export class VantageInfusion extends EventEmitter {
  private readonly xml = new Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  private command!: net.Socket | tls.TLSSocket;
  private isInsecureCmd = true; // 3001 vs 3010
  private isInsecureCfg = true; // 2001 vs 2010
  private readonly thermostatTemperatureChildren = new Map<string, {
    parentVid: string;
    role: ThermostatTemperatureRole;
  }>();
  
  private getPersistentCachePath(): string {
    const fileName = `vantage-${this.cacheKeyForIp(this.opts.ipaddress)}.dc`;
    // Controller-level cache is intentionally not range-specific; range-split main/child bridge instances share it.
    return path.join(this.getPersistentCacheDirectory(), fileName);
  }

  private getPersistentCacheDirectory(): string {
    return path.join(this.opts.storagePath, 'vantage');
  }

  private getLegacyCachePaths(): string[] {
    return [path.join('/tmp', `vantage-${this.cacheKeyForIp(this.opts.ipaddress)}.dc`)];
  }

  private cacheKeyForIp(ipaddress: string): string {
    return ipaddress.replace(/[^a-zA-Z0-9.-]/g, '_');
  }

  constructor(private readonly opts: Options) {
    super();
  }

  /** Probe ports and open command session */
  async start() {
    await this.ensureControllerAddress();

    if (this.opts.forceSSL) {
      this.isInsecureCmd = false;
      this.isInsecureCfg = false;
    } else {
      let { cmd: cmdResult, cfg: cfgResult } = await this.probeInsecurePorts();

      // Plugin updates SIGTERM child bridges and they both re-probe immediately.
      // A busy InFusion looks identical to a dead IP; retry the configured address
      // before treating it as gone and falling through to mDNS / SSL.
      if (!cmdResult && !cfgResult && this.opts.ipaddress) {
        for (const delayMs of [500, 1500]) {
          this.opts.log.warn(
            `Configured controller ${this.opts.ipaddress} did not respond; retrying port probe in ${delayMs}ms`,
          );
          await this.sleep(delayMs);
          ({ cmd: cmdResult, cfg: cfgResult } = await this.probeInsecurePorts());
          if (cmdResult || cfgResult) break;
        }
      }

      if (!cmdResult && !cfgResult && await this.discoverAndApplyController('configured controller did not respond')) {
        ({ cmd: cmdResult, cfg: cfgResult } = await this.probeInsecurePorts());
      }

      this.isInsecureCmd = !!cmdResult;
      this.isInsecureCfg = !!cfgResult;
    }

    // Legacy-style port logs
    this.opts.log.info(this.isInsecureCmd ? 'Using insecure port: 3001' : 'Using SSL port: 3010');
    this.opts.log.info(this.isInsecureCfg ? 'Using insecure port: 2001' : 'Using SSL port: 2010');

    try {
      await this.startCommand();
    } catch (error) {
      this.opts.log.warn(`Command socket failed to open; retrying configured IP before mDNS: ${this.errorMessage(error)}`);
      await this.sleep(1000);
      try {
        await this.startCommand();
        return;
      } catch (retryError) {
        if (await this.discoverAndApplyController('command socket failed to open')) {
          await this.startCommand();
          return;
        }
        throw retryError;
      }
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async probeInsecurePorts(): Promise<{ cmd: boolean; cfg: boolean }> {
    const cmd = await this.portUsable(3001, 'STATUS ALL\n');
    await this.sleep(150);
    const cfg = await this.portUsable(
      2001,
      '<IIntrospection><GetInterfaces><call></call></GetInterfaces></IIntrospection>\n',
    );
    return { cmd, cfg };
  }

  private async ensureControllerAddress() {
    if (this.opts.ipaddress) return;

    const discovered = await this.discoverAndApplyController('no controller IP configured');
    if (!discovered) {
      throw new Error('No Vantage controller IP configured and mDNS discovery did not find an InFusion controller');
    }
  }

  private async discoverAndApplyController(reason: string): Promise<boolean> {
    this.opts.log.warn(`Attempting Vantage controller mDNS discovery: ${reason}`);
    const discovered = await this.discoverControllerMdns();
    if (!discovered) return false;

    this.opts.ipaddress = discovered.host;
    if (!this.opts.forceSSL) {
      this.isInsecureCmd = !discovered.secure;
      this.isInsecureCfg = !discovered.secure;
    }

    this.opts.log.warn(
      `Discovered Vantage InFusion controller at ${discovered.host} using ${discovered.secure ? 'secure' : 'insecure'} ACI service`,
    );
    return true;
  }

  private discoverControllerMdns(timeoutMs = 3000): Promise<{ host: string; secure: boolean } | undefined> {
    const services = [
      { name: '_secure_aci._tcp.local', secure: true },
      { name: '_aci._tcp.local', secure: false },
    ];

    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let resolved = false;

      const finish = (result?: { host: string; secure: boolean }) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* noop */ }
        resolve(result);
      };

      const timer = setTimeout(() => finish(), timeoutMs);

      socket.on('message', (message, rinfo) => {
        const response = message.toString('latin1').toLowerCase();
        if (!response.includes('aci') || !response.includes('infusion')) return;

        const secure = response.includes('_secure_aci');
        finish({ host: rinfo.address, secure });
      });

      socket.on('error', () => finish());
      socket.bind(0, () => {
        try {
          socket.setMulticastTTL(255);
          for (const service of services) {
            const query = this.buildMdnsPtrQuery(service.name);
            socket.send(query, 0, query.length, 5353, '224.0.0.251');
          }
        } catch {
          finish();
        }
      });
    });
  }

  private buildMdnsPtrQuery(name: string): Buffer {
    const labels = name.split('.');
    const parts: Buffer[] = [
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ];

    for (const label of labels) {
      if (!label) continue;
      const labelBytes = Buffer.from(label);
      parts.push(Buffer.from([labelBytes.length]), labelBytes);
    }

    parts.push(Buffer.from([0x00, 0x00, 0x0c, 0x00, 0x01]));
    return Buffer.concat(parts);
  }

  private portUsable(port: number, probe: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!this.opts.ipaddress) {
        resolve(false);
        return;
      }

      let sawData = false;
      this.opts.log.debug(`Testing ${this.opts.ipaddress}:${port} with probe: "${probe.trim()}"`);

      const sock = net.connect({ host: this.opts.ipaddress, port }, () => {
        this.opts.log.debug(`Connected to ${this.opts.ipaddress}:${port}`);
        // improve send behavior
        sock.setNoDelay(true);
        // keep a post-connect timeout; fail if no reply in time
        sock.setTimeout(8000);
        // write immediately
        this.opts.log.debug(`Sending initial probe on port ${port}`);
        sock.write(probe);
        // send a second probe shortly after to coax a response
        setTimeout(() => {
          if (!sawData) {
            this.opts.log.debug(`Re-sending probe on port ${port}`);
            sock.write(probe);
          }
        }, 150);
      });

      sock.once('connect', () => {
        this.opts.log.debug(`Port ${port} connection established`);
      });

      sock.on('data', (data) => {
        const text = data.toString();
        this.opts.log.debug(`Port ${port} received data: ${text.slice(0,200).replace(/\r/g,'\\r').replace(/\n/g,'\\n')}`);
        sawData = true;
        resolve(true);
        sock.destroy();
      });

      sock.on('timeout', () => {
        this.opts.log.debug(`Port ${port} post-connect timeout`);
        sock.destroy();
      });

      sock.on('close', () => {
        this.opts.log.debug(`Port ${port} closed, sawData: ${sawData}`);
        if (!sawData) resolve(false);
      });

      sock.on('error', (err) => {
        const msg = err instanceof Error ? `${(err as any).code || ''} ${err.message}` : String(err);
        this.opts.log.debug(`Port ${port} error: ${msg}`);
        /* resolve on close path */
      });
    });
  }

  private async startCommand() {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onConnect = (socket: net.Socket | tls.TLSSocket) => {
        settled = true;
        this.command = socket;

        // Legacy “connected” log
        this.opts.log.info(this.isInsecureCmd ? 'connected (command) — Port 3001' : 'connected (command) — Port 3010');

        if (this.opts.username && this.opts.password) {
          this.command.write(`Login ${this.opts.username} ${this.opts.password}\n`);
          const alternateUsername = alternateVantageUsername(this.opts.username);
          if (alternateUsername) {
            this.command.write(`Login ${alternateUsername} ${this.opts.password}\n`);
          }
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

      const rejectOnInitialError = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      if (this.isInsecureCmd) {
        const sock = net.connect({ host: this.opts.ipaddress, port: 3001 }, () => onConnect(sock));
        sock.once('error', rejectOnInitialError);
        this.wireCommandSocket(sock);
      } else {
        const sock = tls.connect(
          3010,
          this.opts.ipaddress,
          { rejectUnauthorized: false, requestCert: true },
          () => onConnect(sock),
        );
        sock.once('error', rejectOnInitialError);
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
      setTimeout(() => this.reconnectCommandSocket(), 5000);
    });
    sock.on('end', () => {
      // Legacy “Port … has ended!!”
      this.opts.log.warn(this.isInsecureCmd ? 'Port 3001 has ended!!' : 'Port 3010 has ended!!');
    });
    sock.on('error', (e) => {
      this.opts.log.debug(`Command socket error: ${String(e)}`);
      try { sock.destroy(); } catch { /* noop */ }
    });
  }

  private async reconnectCommandSocket() {
    try {
      if (!this.opts.forceSSL) {
        const port = this.isInsecureCmd ? 3001 : 3010;
        const reachable = await this.portUsable(port, 'STATUS ALL\n');
        if (!reachable) {
          await this.discoverAndApplyController('command reconnect failed');
        }
      }

      await this.startCommand();
      this.opts.log.info('Command socket reconnected and event subscriptions were re-sent');
    } catch (error) {
      await this.discoverAndApplyController('command reconnect failed');
      this.opts.log.warn(`Command reconnect failed; retrying in 5s: ${this.errorMessage(error)}`);
      setTimeout(() => this.reconnectCommandSocket(), 5000);
    }
  }

  private parseRealtime(buffer: string) {
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (!line) continue;
      const dataItem = line.split(' ');
      // this.opts.log.info(line)
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
          if (this.emitThermostatChildTemperatureIfMapped(dataItem[1], dataItem[2])) {
            continue;
          }
          this.emit('thermostatDidChange', Number.parseInt(dataItem[2] ?? dataItem[1]));
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
        if (line.startsWith('S:DRYCONTACT') || line.startsWith('R:GETDRYCONTACT')) {
          this.emit('contactStatusChange', Number.parseInt(dataItem[1]), this.truthyStatus(dataItem[2]));
        }
        if (line.startsWith('S:LIGHTSENSOR') || line.startsWith('R:GETLIGHTSENSOR')) {
          this.emit('lightSensorChange', Number.parseInt(dataItem[1]), Number.parseFloat(dataItem[2]));
        }
        if (line.startsWith('S:TEMPERATURE') || line.startsWith('R:GETTEMPERATURE')) {
          if (this.emitThermostatChildTemperatureIfMapped(dataItem[1], dataItem[2])) {
            continue;
          }
          this.emit('temperatureSensorChange', Number.parseInt(dataItem[1]), Number.parseFloat(dataItem[2]));
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
    if (this.opts.usecache) {
      await this.migrateLegacyCacheIfNeeded();
    }

    const attempts = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        this.opts.log.info(
          `Attempting fresh Vantage configuration download from ${this.opts.ipaddress}` +
            (attempt > 1 ? ` (retry ${attempt}/${attempts})` : ''),
        );
        const xml = await this.pullConfigurationXml();
        const validation = await this.parseAndValidateConfigurationXml(xml, 'downloaded configuration');
        this.opts.log.info(
          `Fresh Vantage controller configuration validated successfully (${validation.relevantObjectCount} relevant objects)`,
        );

        if (this.opts.usecache) {
          try {
            await this.writePersistentCacheAtomically(xml, validation);
          } catch (error) {
            if (error instanceof CandidateConfigurationError) {
              throw error;
            }
            this.opts.log.warn(`Persistent cache update failed; using live configuration for this run: ${this.errorMessage(error)}`);
          }
        }

        // Always mirror a validated dump to /tmp/vantage.dc for Organize Home and other local tools.
        // This is independent of usecache, which only controls Homebridge's persistent fallback.
        await this.writeLegacyTmpCacheMirror(xml, validation);

        // Legacy: "end configuration download"
        this.opts.log.debug('VantagePlatform for InFusion Controller (end configuration download)');

        const devices = await this.processConfigurationXml(xml, 'downloaded configuration');
        this.opts.log.info('Fresh Vantage controller configuration loaded successfully');
        return devices;
      } catch (error) {
        lastError = error;
        this.opts.log.warn(
          `Fresh controller discovery failed${attempt < attempts ? '; retrying after the controller session is free' : ''}: ${this.errorMessage(error)}`,
        );
        if (attempt < attempts) {
          await this.sleep(2000);
        }
      }
    }

    if (!this.hasCredentials()) {
      this.opts.log.warn(
        'No Vantage username/password configured. If this controller requires authentication, add credentials in the Homebridge plugin config.',
      );
    }

    if (this.opts.usecache) {
      try {
        return await this.loadPersistentCache({ refreshLegacyTmpMirror: true });
      } catch (cacheError) {
        this.opts.log.error(`Persistent cache unavailable; preserving existing Homebridge accessories: ${this.errorMessage(cacheError)}`);
      }
    } else {
      this.opts.log.warn(
        'Local cache is disabled; a failed live download has no last-known-good configuration to fall back to.',
      );
    }

    this.opts.log.error(
      `Live discovery failed; keeping existing Homebridge accessories instead of replacing them: ${this.errorMessage(lastError)}`,
    );
    return [];
  }
  
  private async processConfigurationXml(xml: string, source = 'configuration'): Promise<VantageDevice[]> {
    const { objects } = await this.parseAndValidateConfigurationXml(xml, source);
    const devices: VantageDevice[] = [];
    this.thermostatTemperatureChildren.clear();

    const Areas = objects.filter((el: any) => Object.keys(el)[0] === 'Area');
    const Area: Record<string, any> = {};
    for (const a of Areas) Area[a.Area.VID] = a.Area;
    const thermostatVids = new Set<string>();

    for (const raw of objects) {
      const key = Object.keys(raw)[0];
      const it = raw[key];
      if (!it) continue;
      if (this.isThermostatConfigObject(key, it)) {
        thermostatVids.add(String(it.VID));
      }
    }

    const omit = (this.opts.omit || '').replace(/\s+/g, '');
    const omitSet = new Set<string>(omit ? omit.split(',') : []);

    const [minVID, maxVID] = this.parseVidRange(this.opts.range);

    const blindOpenClose: Record<string, string> = {};
    const seenNames = new Set<string>();

    for (const raw of objects) {
      const key = Object.keys(raw)[0];
      const it = raw[key];
      const objectType = String(it.ObjectType || key);
      const vid = String(it.VID);

      if (omitSet.has(vid)) continue;
      const vidNum = Number.parseInt(vid, 10);
      if (!(vidNum >= minVID && vidNum <= maxVID)) continue;
      if (!this.isDiscoverableConfigObject(key, it)) continue;

      if (key === 'Temperature' || objectType === 'Temperature') {
        const thermostatChild = this.getThermostatTemperatureChild(it, thermostatVids);
        if (thermostatChild) {
          this.thermostatTemperatureChildren.set(vid, thermostatChild);
          this.opts.log.debug(
            `Mapped thermostat child temperature VID ${vid} to thermostat VID ${thermostatChild.parentVid} (${thermostatChild.role})`,
          );
          continue;
        }
      }

      // Area prefix keeps two "LAMP" loads unique in the Home app.
      // sanitizeXml renames a load's <Area>vid</Area> to <AreaID>.
      const areaId = String(it.AreaID || it.Area || '');
      const areaName = String(Area[areaId]?.Name || Area[areaId]?.DName || '').trim();
      let name = String(it.DName || it.Name || '').trim() || `VID${vid}`;
      if (areaName) name = `${areaName} ${name}`;
      const nameKey = name.toLowerCase();
      if (seenNames.has(nameKey)) {
        name = `${name} VID${vid}`;
      }
      seenNames.add(nameKey);

      const pushUnique = (dev: VantageDevice) => {
        if (devices.find((d) => d.vid === vid)) return;
        devices.push(dev);
      };

      if (this.isThermostatConfigObject(key, it)) {
        if (this.opts.includeThermostats === false) continue;
        this.opts.log.info(`New HVAC added (VID=${it.VID}, Name=${name})`);
        pushUnique({
          name,
          address: vid,
          type: 'thermostat',
          vid,
          objectType,
          temperature: 20,
          targetTemp: 20,
          heating: 20,
          cooling: 25,
          mode: 0,
          current: 0,
          units: 1,
        });
        continue;
      }

      if (
        this.isLoadConfigObject(key, it)
      ) {
        if (this.opts.includeLights === false) continue;
        const isColorLoad = this.isColorLoadConfigObject(key, it);
        const isRelay =
          objectType.includes('Relay') ||
          objectType.includes('Pump') ||
          objectType.includes('Auxiliary') ||
          it.LoadType === 'Fluor. Mag non-Dim' ||
          it.LoadType === 'LED non-Dim' ||
          it.LoadType === 'Fluor. Electronic non-Dim' ||
          it.LoadType === 'Low Voltage Relay' ||
          it.LoadType === 'Motor' ||
          it.LoadType === 'High Voltage Relay';

        if (isRelay) {
          this.opts.log.info(`New relay added (VID=${it.VID}, Name=${name}, RELAY)`);
          pushUnique({
            name,
            address: vid,
            type: 'relay',
            vid,
            objectType,
            loadType: it.LoadType,
            bri: 100,
            power: false,
          });
        } else if (isColorLoad) {
          this.opts.log.info(`New load added (VID=${it.VID}, Name=${name}, RGB)`);
          pushUnique({
            name,
            address: vid,
            type: 'rgb',
            vid,
            objectType,
            loadType: it.LoadType,
            bri: 100,
            power: false,
            sat: 0,
            hue: 0,
          });
        } else {
          this.opts.log.info(`New load added (VID=${it.VID}, Name=${name}, DIMMER)`);
          pushUnique({
            name,
            address: vid,
            type: 'dimmer',
            vid,
            objectType,
            loadType: it.LoadType,
            bri: 100,
            power: false,
          });
        }
        continue;
      }

      if (this.isBlindConfigObject(key, it)) {
        if (this.opts.includeBlinds === false) continue;
        if (objectType === 'RelayBlind') {
          blindOpenClose[it.OpenLoad] = it.OpenLoad;
          blindOpenClose[it.CloseLoad] = it.CloseLoad;
        }
        this.opts.log.info(`New Blind added (VID=${it.VID}, Name=${name}, BLIND)`);
        pushUnique({ name, address: vid, type: 'blind', vid, objectType, pos: 100, posState: 2 });
        continue;
      }

      if (key === 'DryContact' || objectType === 'DryContact') {
        if (this.isThermostatHelperDryContact(it, thermostatVids)) {
          this.opts.log.debug(`Skipping thermostat helper dry contact VID ${vid} (${name})`);
          continue;
        }
        if (this.opts.includeSensors === false) continue;
        this.opts.log.info(`New dry contact added (VID=${it.VID}, Name=${name})`);
        pushUnique({ name, address: vid, type: 'contact', vid, objectType, contact: false });
        continue;
      }

      if (key === 'Temperature' || objectType === 'Temperature') {
        if (this.opts.includeSensors === false) continue;
        this.opts.log.info(`New temperature sensor added (VID=${it.VID}, Name=${name})`);
        pushUnique({
          name,
          address: vid,
          type: 'temperatureSensor',
          vid,
          objectType,
          temperature: this.toNumber(it.Value ?? it.SensorValue ?? it.Temperature, 0),
        });
        continue;
      }

      if (key === 'LightSensor' || objectType === 'LightSensor') {
        if (this.opts.includeSensors === false) continue;
        this.opts.log.info(`New light sensor added (VID=${it.VID}, Name=${name})`);
        pushUnique({
          name,
          address: vid,
          type: 'lightSensor',
          vid,
          objectType,
          lightLevel: this.toNumber(it.Value ?? it.SensorValue ?? it.LightLevel, 0.0001),
        });
        continue;
      }

      if (key === 'OmniSensor' || objectType === 'OmniSensor') {
        if (this.opts.includeSensors === false) continue;
        const sensorValue = this.toNumber(it.Value ?? it.SensorValue ?? it.LightLevel ?? it.Temperature, 0);
        if (String(it.Units ?? it.SensorType ?? '').toLowerCase().includes('lux')) {
          this.opts.log.info(`New Omni light sensor added (VID=${it.VID}, Name=${name})`);
          pushUnique({
            name,
            address: vid,
            type: 'lightSensor',
            vid,
            objectType,
            lightLevel: Math.max(0.0001, sensorValue),
          });
        } else {
          this.opts.log.info(`New Omni temperature sensor added (VID=${it.VID}, Name=${name})`);
          pushUnique({
            name,
            address: vid,
            type: 'temperatureSensor',
            vid,
            objectType,
            temperature: sensorValue,
          });
        }
        continue;
      }
    }

    // Drop synthetic relay children of RelayBlind
    const filtered = devices.filter((d) => !blindOpenClose[d.address]);

    // Legacy “Found %f devices”
    this.opts.log.info(`Found ${filtered.length} devices`);

    if (filtered.length >= 150) {
      this.opts.log.warn(
        `Found ${filtered.length} devices, which exceeds the HomeKit bridge limit of 149 accessories.`,
      );
      this.opts.log.warn(
        'Only the first 149 devices will be loaded on this bridge. Split this controller across multiple ' +
          'VantageControls platform instances using VID ranges, and configure additional instances as child bridges.',
      );
      this.opts.log.warn(
        `Suggested VID ranges for this controller: ${this.suggestVidRanges(filtered).join(', ')}`,
      );
      filtered.splice(149);
    }

    return filtered;
  }

  private suggestVidRanges(devices: VantageDevice[]): string[] {
    const vids = devices
      .map((device) => Number.parseInt(String(device.vid), 10))
      .filter((vid) => Number.isFinite(vid))
      .sort((a, b) => a - b);

    if (vids.length <= 149) return ['0-999999999'];

    const targetPerBridge = 125;
    const bridgeCount = Math.max(2, Math.ceil(vids.length / targetPerBridge));
    const chunkSize = Math.ceil(vids.length / bridgeCount);
    const ranges: string[] = [];
    let start = 0;

    for (let index = chunkSize - 1; index < vids.length - 1; index += chunkSize) {
      const end = vids[index];
      ranges.push(`${start}-${end}`);
      start = end + 1;
    }

    ranges.push(`${start}-999999999`);
    return ranges;
  }

  private async parseAndValidateConfigurationXml(xml: string, source: string): Promise<ValidatedConfiguration> {
    const sanitized = this.sanitizeXml(xml);
    let parsedAny: any;

    try {
      parsedAny = await this.xml.parseStringPromise(sanitized);
    } catch (error) {
      const message = `${source} rejected: XML parsing failed: ${this.errorMessage(error)}`;
      this.opts.log.error(message);
      throw new Error(message);
    }

    const parsed = parsedAny?.smarterHome ?? parsedAny;
    const objectNode = parsed?.Project?.Objects?.Object;
    if (!objectNode) {
      const message = `${source} rejected: missing Project.Objects.Object configuration structure`;
      this.opts.log.error(message);
      throw new Error(message);
    }

    const objects = Array.isArray(objectNode) ? objectNode : [objectNode];
    if (objects.length === 0) {
      const message = `${source} rejected: Project.Objects.Object contains no objects`;
      this.opts.log.error(message);
      throw new Error(message);
    }

    const relevantObjectCount = objects.filter((object) => this.isRelevantConfigObject(object)).length;
    if (relevantObjectCount === 0) {
      const summary = this.summarizeConfigObjectTypes(objects);
      const message =
        `${source} rejected: configuration contains no discoverable Vantage objects ` +
        `(${objects.length} objects${summary ? `: ${summary}` : ''})`;
      this.opts.log.error(message);
      throw new Error(message);
    }

    return { objects, relevantObjectCount };
  }

  private isRelevantConfigObject(raw: any): boolean {
    if (!raw || typeof raw !== 'object') return false;

    const key = Object.keys(raw)[0];
    const value = raw[key];
    if (!value || typeof value !== 'object') return false;

    return this.isDiscoverableConfigObject(key, value);
  }

  private summarizeConfigObjectTypes(objects: any[]): string {
    const counts = new Map<string, number>();
    for (const object of objects) {
      const key = object && typeof object === 'object' ? Object.keys(object)[0] : 'unknown';
      counts.set(key || 'unknown', (counts.get(key || 'unknown') || 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([type, count]) => `${type}=${count}`)
      .join(', ');
  }

  private isDiscoverableConfigObject(key: string, it: any): boolean {
    const objectType = this.configObjectType(key, it);
    return (
      DISCOVERABLE_OBJECT_TYPES.includes(key) ||
      DISCOVERABLE_OBJECT_TYPES.includes(objectType) ||
      this.isLoadConfigObject(key, it) ||
      this.isBlindConfigObject(key, it) ||
      this.isThermostatConfigObject(key, it)
    );
  }

  private configObjectType(key: string, it: any): string {
    return String(it?.ObjectType || key);
  }

  private isGroupConfigObject(key: string, it: any): boolean {
    const objectType = this.configObjectType(key, it).toLowerCase();
    return objectType.includes('group') || key.toLowerCase().includes('group') || it.LoadTable || it.BlindTable;
  }

  private hasAnyField(it: any, fields: string[]): boolean {
    return fields.some((field) => it[field] !== undefined && it[field] !== null && it[field] !== '');
  }

  private controllerHasType(controllerName: string, key: string, it: any): boolean {
    const objectType = this.configObjectType(key, it);
    const controller = CONFIGURATION_CONTROLLERS.find((entry) => entry.name === controllerName);
    return Boolean(controller?.vantageTypes.includes(key) || controller?.vantageTypes.includes(objectType));
  }

  private isLoadConfigObject(key: string, it: any): boolean {
    if (this.isGroupConfigObject(key, it)) return false;
    if (this.controllerHasType('loads', key, it) || this.controllerHasType('rgbLoads', key, it)) return true;

    return this.hasAnyField(it, [
      'LoadType',
      'PowerProfile',
      'FixturePower',
      'FixtureDefinition',
      'OverrideLevel',
      'DimmingConfig',
    ]);
  }

  private isColorLoadConfigObject(key: string, it: any): boolean {
    const objectType = this.configObjectType(key, it);
    return key.includes('ColorLoad') || objectType.includes('ColorLoad');
  }

  private isBlindConfigObject(key: string, it: any): boolean {
    if (this.isGroupConfigObject(key, it)) return false;
    if (this.controllerHasType('blinds', key, it)) return true;

    return this.hasAnyField(it, [
      'ShadeType',
      'ShadeOrientation',
      'Movement',
      'OpenLoad',
      'CloseLoad',
      'PowerLoad',
    ]);
  }

  private isThermostatConfigObject(key: string, it: any): boolean {
    if (this.isGroupConfigObject(key, it)) return false;
    if (it.DeviceCategory === 'HVAC' || this.controllerHasType('thermostats', key, it)) return true;

    const objectType = this.configObjectType(key, it);
    const normalized = `${key} ${objectType}`.toLowerCase();
    if (normalized.includes('thermostat') || normalized.includes('hvac')) return true;

    return this.hasAnyField(it, [
      'OperationMode',
      'FanMode',
      'DayMode',
      'ExternalTemperature',
      'Humidistat',
    ]);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private hasCredentials(): boolean {
    return Boolean(this.opts.username && this.opts.password);
  }

  private rememberSuccessfulUsername(username: string) {
    if (username && username !== this.opts.username) {
      this.opts.username = username;
    }
  }

  private toNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private truthyStatus(value: unknown): boolean {
    const normalized = String(value ?? '').trim().toUpperCase();
    return normalized === '1' || normalized === 'ON' || normalized === 'TRUE' || normalized === 'CLOSED';
  }

  private parseVidRange(range: string | undefined): [number, number] {
    const raw = String(range || '0-999999999').trim();
    const match = raw.match(/^(\d+)\s*[-,]\s*(\d+)$/);

    if (!match) {
      this.opts.log.warn(`Invalid Vantage VID range "${raw}"; using default range 0-999999999.`);
      return [0, 999999999];
    }

    const minVID = Number.parseInt(match[1], 10);
    const maxVID = Number.parseInt(match[2], 10);
    if (!Number.isFinite(minVID) || !Number.isFinite(maxVID) || minVID > maxVID) {
      this.opts.log.warn(`Invalid Vantage VID range "${raw}"; using default range 0-999999999.`);
      return [0, 999999999];
    }

    return [minVID, maxVID];
  }

  private getConfigurationObjectTypes(): string[] {
    return [...CONFIG_OBJECT_TYPES];
  }

  private getConfigurationControllers() {
    return CONFIGURATION_CONTROLLERS.map((controller) => ({
      name: controller.name,
      vantageTypes: [...controller.vantageTypes],
    }));
  }

  private emitThermostatChildTemperatureIfMapped(vid: unknown, value: unknown): boolean {
    const childVid = String(vid ?? '').trim();
    const mapping = this.thermostatTemperatureChildren.get(childVid);
    if (!mapping) return false;

    const temperature = Number.parseFloat(String(value));
    if (!Number.isFinite(temperature)) return false;

    this.emit('thermostatChildTemperatureChange', mapping.parentVid, mapping.role, temperature);
    return true;
  }

  private getThermostatTemperatureChild(
    object: any,
    thermostatVids: Set<string>,
  ): { parentVid: string; role: ThermostatTemperatureRole } | undefined {
    const parentVid = this.getParentVid(object) ?? this.getNearbyThermostatVid(object, thermostatVids);
    if (!parentVid || !thermostatVids.has(parentVid)) return undefined;

    const role = this.getThermostatTemperatureRole(object);
    if (!role) return undefined;

    return { parentVid, role };
  }

  private isThermostatHelperDryContact(object: any, thermostatVids: Set<string>): boolean {
    if (!this.getNearbyThermostatVid(object, thermostatVids)) return false;

    const label = this.normalizedObjectLabel(object);
    return label === 'fan' ||
      label === 'night mode' ||
      /^cool \d+$/.test(label) ||
      /^heat \d+$/.test(label);
  }

  private getNearbyThermostatVid(object: any, thermostatVids: Set<string>): string | undefined {
    const vid = Number.parseInt(String(object?.VID), 10);
    if (!Number.isFinite(vid)) return undefined;

    const nearby = [...thermostatVids]
      .map((candidate) => Number.parseInt(candidate, 10))
      .filter((candidate) => Number.isFinite(candidate) && candidate < vid && vid - candidate <= 10)
      .sort((a, b) => b - a)[0];

    return nearby === undefined ? undefined : String(nearby);
  }

  private getParentVid(object: any): string | undefined {
    const candidates = [
      object?.ParentVID,
      object?.ParentVid,
      object?.Parent,
      object?.ParentID,
      object?.ParentId,
      object?.OwnerVID,
      object?.Owner,
      object?.parent?.VID,
      object?.Parent?.VID,
    ];

    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      const normalized = String(candidate).trim();
      if (/^\d+$/.test(normalized)) return normalized;
    }

    return undefined;
  }

  private getThermostatTemperatureRole(object: any): ThermostatTemperatureRole | undefined {
    const position = Number(object?.Position ?? object?.ParentPosition ?? object?.ChildPosition ?? object?.Index);
    if (position === 1) return 'indoor';
    if (position === 3) return 'cool';
    if (position === 4) return 'heat';

    const label = this.normalizedObjectLabel(object);
    if (label.includes('indoor') || label.includes('room') || label.includes('internal sensor')) return 'indoor';
    if (label.includes('cool')) return 'cool';
    if (label.includes('heat')) return 'heat';

    return undefined;
  }

  private normalizedObjectLabel(object: any): string {
    return String(`${object?.DName ?? ''} ${object?.Name ?? ''} ${object?.Description ?? ''}`)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private async loadPersistentCache(options: { refreshLegacyTmpMirror?: boolean } = {}): Promise<VantageDevice[]> {
    const cachePath = this.getPersistentCachePath();
    if (!fs.existsSync(cachePath)) {
      throw new Error(`persistent cache not found at ${cachePath}`);
    }

    const cachedXml = fs.readFileSync(cachePath, 'utf8');
    const validation = await this.parseAndValidateConfigurationXml(
      cachedXml,
      `persistent last-known-good cache ${cachePath}`,
    );
    if (options.refreshLegacyTmpMirror) {
      await this.writeLegacyTmpCacheMirror(cachedXml, validation);
    }
    const devices = await this.processConfigurationXml(cachedXml, `persistent last-known-good cache ${cachePath}`);
    this.opts.log.warn(`Using persistent last-known-good Vantage configuration from ${cachePath}`);
    return devices;
  }

  private async migrateLegacyCacheIfNeeded() {
    const persistentCachePath = this.getPersistentCachePath();
    if (fs.existsSync(persistentCachePath)) return;

    for (const legacyPath of this.getLegacyCachePaths()) {
      if (!fs.existsSync(legacyPath)) continue;

      try {
        const legacyXml = fs.readFileSync(legacyPath, 'utf8');
        const validation = await this.parseAndValidateConfigurationXml(legacyXml, `legacy cache ${legacyPath}`);
        await this.writePersistentCacheAtomically(legacyXml, validation);
        this.opts.log.info(`Migrated legacy Vantage cache from ${legacyPath} to ${persistentCachePath}`);
        return;
      } catch (error) {
        this.opts.log.warn(`Legacy cache rejected from ${legacyPath}: ${this.errorMessage(error)}`);
      }
    }

    const unkeyedLegacyPath = path.join('/tmp', 'vantage.dc');
    if (fs.existsSync(unkeyedLegacyPath)) {
      this.opts.log.warn(
        `Legacy cache ${unkeyedLegacyPath} exists but was not migrated because it is not controller-specific.`,
      );
    }
  }

  /** Escape text for XML (same as sanitize in index.js). */
  private static escapeXml(s: string): string {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * The SmarterHome iOS Organize Home parser (`ParseXMLData.swift`) only accepts
   * text-only elements. Mixed content and attributes make JSONSerialization fail.
   * Nested objects keep xml2js `_` text when present (e.g. Parent VID) and are
   * otherwise omitted. Relay loads stay: they are `<Load>` objects, not DryContacts.
   */
  private static serializeXmlElement(name: string, value: unknown): string {
    if (value === undefined || value === null) return `<${name}></${name}>`;
    if (typeof value !== 'object') {
      return `<${name}>${VantageInfusion.escapeXml(String(value))}</${name}>`;
    }
    if (Array.isArray(value)) {
      return value.map((item) => VantageInfusion.serializeXmlElement(name, item)).join('');
    }

    const record = value as Record<string, unknown>;
    const text = record._;
    if (text !== undefined && text !== null && typeof text !== 'object') {
      return `<${name}>${VantageInfusion.escapeXml(String(text))}</${name}>`;
    }

    const children: string[] = [];
    for (const [key, child] of Object.entries(record)) {
      if (!key || key === '$' || key === '_' || !VantageInfusion.isXmlName(key)) continue;
      if (child !== null && typeof child === 'object') {
        const nestedText = (child as Record<string, unknown>)._;
        if (nestedText !== undefined && nestedText !== null && typeof nestedText !== 'object') {
          children.push(`<${key}>${VantageInfusion.escapeXml(String(nestedText))}</${key}>`);
        }
        continue;
      }
      children.push(
        `<${key}>${child === undefined || child === null ? '' : VantageInfusion.escapeXml(String(child))}</${key}>`,
      );
    }

    return `<${name}>${children.join('')}</${name}>`;
  }

  private static isXmlName(key: string): boolean {
    return /^[:A-Z_a-z][\w:.-]*$/.test(key);
  }

  /** Build cache XML from readObjects (same structure + sanitization as original index.js). */
  private buildCacheXml(readObjects: any[]): string {
    const frag = readObjects.map((o) => {
      const k = Object.keys(o)[0];
      return `<Object>${VantageInfusion.serializeXmlElement(k, o[k])}</Object>`;
    }).join('');
    return `<Project><Objects>${frag}</Objects></Project>`;
  }

  private objectsForLegacyTmpDump(objects: any[]): any[] {
    const dumped = objects.map((raw) => {
      const key = Object.keys(raw)[0];
      if (!key || !raw[key] || typeof raw[key] !== 'object' || Array.isArray(raw[key])) return raw;
      const body = raw[key] as Record<string, unknown>;
      const areaVid = VantageInfusion.organizeHomeAreaVid(body);
      if (!areaVid) return raw;
      return { [key]: { ...body, Area: areaVid } };
    });

    // Organize Home aborts if a HomeKit accessory's Area VID is not in the Area list.
    const areaVids = new Set(
      dumped
        .filter((raw) => {
          const key = Object.keys(raw)[0];
          const body = raw[key] as Record<string, unknown> | undefined;
          return key === 'Area' || String(body?.ObjectType ?? '') === 'Area';
        })
        .map((raw) => String((raw[Object.keys(raw)[0]] as Record<string, unknown>)?.VID ?? '')),
    );
    const missingAreaVids = new Set<string>();
    for (const raw of dumped) {
      const key = Object.keys(raw)[0];
      const body = raw[key] as Record<string, unknown> | undefined;
      if (key === 'Area' || String(body?.ObjectType ?? '') === 'Area') continue;
      const areaVid = VantageInfusion.organizeHomeAreaVid(body);
      if (areaVid && !areaVids.has(areaVid)) missingAreaVids.add(areaVid);
    }
    for (const vid of missingAreaVids) {
      dumped.unshift({
        Area: {
          VID: vid,
          Name: vid === '0' ? 'Unassigned' : `Area ${vid}`,
          ObjectType: 'Area',
        },
      });
    }
    return dumped;
  }

  /** 1.0.8 xml2json wrote this as `Area`; xml2js keeps Infusion's `AreaID`. */
  private static organizeHomeAreaVid(body: Record<string, unknown> | undefined): string {
    if (!body) return '';
    const direct = body.Area;
    if (direct !== undefined && direct !== null && typeof direct !== 'object' && String(direct) !== '') {
      return String(direct);
    }
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      const nested = direct as Record<string, unknown>;
      if (nested._ !== undefined && nested._ !== null && typeof nested._ !== 'object' && String(nested._) !== '') {
        return String(nested._);
      }
      if (nested.VID !== undefined && nested.VID !== null && typeof nested.VID !== 'object' && String(nested.VID) !== '') {
        return String(nested.VID);
      }
    }
    const areaId = body.AreaID;
    if (areaId !== undefined && areaId !== null && typeof areaId !== 'object' && String(areaId) !== '') {
      return String(areaId);
    }
    return '';
  }

  private pullConfigurationXml(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const finishOnce = (socket: net.Socket | tls.TLSSocket, xml: string) => {
        if ((finishOnce as any)._done) return;
        (finishOnce as any)._done = true;

        // legacy event
        this.emit('endDownloadConfiguration', xml);

        try { socket.destroy(); } catch { /* noop */ }
        resolve(xml);
      };

      const failOnce = (socket: net.Socket | tls.TLSSocket, error: unknown) => {
        if ((finishOnce as any)._done) return;
        (finishOnce as any)._done = true;
        try { socket.destroy(); } catch { /* noop */ }
        reject(error);
      };
  
      const onData = (socket: net.Socket | tls.TLSSocket) => {
        this.opts.log.debug('Starting Vantage configuration download');

      let buffer = '';
        let controller = 1;
        let shouldBreak = false;
      const readObjects: any[] = [];
        const objectDict: Record<string, string> = {};
      let writeCount = 0;
  
        // progress watchdog: if we stop seeing new parsable states, finish with what we have
        let lastProgress = Date.now();
        const progress = () => { lastProgress = Date.now(); };
        const hasDiscoverableObjects = () =>
          readObjects.some((object) => this.isRelevantConfigObject(object));

        const finishIfDownloadSettled = (reason: 'watchdog' | 'close') => {
          if ((finishOnce as any)._done) return;
          if (!readObjects.length) {
            if (reason === 'close') {
              failOnce(socket, new Error('Connection ended before Vantage configuration was downloaded'));
            }
            return;
          }
          if (!hasDiscoverableObjects()) {
            if (reason === 'close') {
              failOnce(socket, new Error('Configuration download ended before any discoverable Vantage objects arrived'));
            }
            return;
          }
          const xml = this.buildCacheXml(readObjects);
          clearLoginFallback();
          clearInterval(watchdog);
          finishOnce(socket, xml);
        };

        const watchdog = setInterval(() => {
          if ((finishOnce as any)._done) { clearInterval(watchdog); return; }
          if (Date.now() - lastProgress > 2000) {
            finishIfDownloadSettled('watchdog');
          }
        }, 750);
  
        const writeOpenFilter = () => {
          const type = CONFIG_OBJECT_TYPES[writeCount];
          if (!type) return;
          this.opts.log.debug(`Requesting Vantage object type ${type} on controller ${controller.toString()}`);
          socket.write(
            `<?Master ${controller}?>` +
            `<IConfiguration><OpenFilter><call><Objects><ObjectType>${type}</ObjectType></Objects></call></OpenFilter></IConfiguration>\n`,
          );
          progress();
        };
  
        // Kickoff (+ fallback if login never parses)
        let loginFallback: NodeJS.Timeout | null = null;
        const clearLoginFallback = () => { if (loginFallback) { clearTimeout(loginFallback); loginFallback = null; } };
  
        const writeLogin = (username: string) => {
          this.opts.log.debug(`Sending Vantage configuration login request as ${username}`);
          socket.write(
            `<ILogin><Login><call><User>${username}</User><Password>${this.opts.password}</Password></call></Login></ILogin>\n`,
          );
          progress();
        };

        let loginUsername = this.opts.username;
        let triedAlternateUsername = false;
        const scheduleLoginFallback = () => {
          clearLoginFallback();
          loginFallback = setTimeout(() => {
            const alternateUsername = alternateVantageUsername(loginUsername);
            if (alternateUsername && !triedAlternateUsername) {
              triedAlternateUsername = true;
              loginUsername = alternateUsername;
              this.opts.log.warn(
                `Vantage login as ${this.opts.username} timed out; retrying as ${alternateUsername}.`,
              );
              writeLogin(alternateUsername);
              scheduleLoginFallback();
              return;
            }

            this.opts.log.warn('Vantage login response timed out; attempting configuration download anyway.');
            writeOpenFilter();
          }, 2500);
        };

        if (this.hasCredentials()) {
          writeLogin(loginUsername);
          scheduleLoginFallback();
        } else {
          this.opts.log.debug('No Vantage username/password configured; attempting unauthenticated configuration download');
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
              buffer = '';
              if (ok) {
                this.opts.log.info(`Login successful as ${loginUsername}`);
                this.rememberSuccessfulUsername(loginUsername);
                clearLoginFallback();
                writeCount = 0;
                writeOpenFilter();
              } else {
                const alternateUsername = alternateVantageUsername(loginUsername);
                if (alternateUsername && !triedAlternateUsername) {
                  triedAlternateUsername = true;
                  loginUsername = alternateUsername;
                  this.opts.log.warn(
                    `Vantage controller rejected username ${this.opts.username}; retrying as ${alternateUsername}.`,
                  );
                  writeLogin(alternateUsername);
                  scheduleLoginFallback();
                } else {
                  this.opts.log.error(
                    'Vantage controller rejected the configured username/password. Check the Homebridge plugin credentials.',
                  );
                  clearLoginFallback();
                  writeCount = 0;
                  writeOpenFilter();
                }
              }
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
                  this.opts.log.debug('Reached end of Vantage controller configuration objects');
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
                const type = CONFIG_OBJECT_TYPES[writeCount - 1];
                const item = el[type] ?? el; // tolerate firmwares that return without type wrapper
                if (item) item.ObjectType = type;
                const elemDict: any = {};
                elemDict[type] = item;
                  readObjects.push(elemDict);
                }
  
              buffer = '';
              if (writeCount >= CONFIG_OBJECT_TYPES.length) {
                controller++;
                writeCount = 0;
              }
              // writeOpenFilter()
              // return;
            }

            if (parsed?.IConfiguration?.GetFilterResults) {
            buffer = '';
              if (writeCount >= CONFIG_OBJECT_TYPES.length) {
              controller++;
              writeCount = 0;
            }
              writeOpenFilter()
              return;
            }
  
            // ----- END CONDITION -----
            if (shouldBreak) {
              const xml = this.buildCacheXml(readObjects);
              clearLoginFallback();
              clearInterval(watchdog);
              finishOnce(socket, xml);
            }
          });
        });
  
        socket.on('end', () => {
          this.opts.log.debug(`Vantage configuration socket ended; completed=${shouldBreak}`);
          clearLoginFallback();
          clearInterval(watchdog);
          finishIfDownloadSettled('close');
        });
  
        socket.on('close', () => {
          this.opts.log.debug("closing " + shouldBreak)
          clearLoginFallback();
          clearInterval(watchdog);
          finishIfDownloadSettled('close');
        });

        socket.on('timeout', () => {
          clearLoginFallback();
          clearInterval(watchdog);
          failOnce(socket, new Error('Timed out while downloading Vantage configuration'));
        });

        socket.on('error', (error) => {
          clearLoginFallback();
          clearInterval(watchdog);
          failOnce(socket, error);
        });

        socket.setTimeout(30000);
      };
  
      if (this.isInsecureCfg) {
        const s = net.connect({ host: this.opts.ipaddress, port: 2001 }, () => onData(s));
        s.once('error', (error) => failOnce(s, error));
        s.setTimeout(30000, () => failOnce(s, new Error('Timed out connecting to Vantage configuration port')));
      } else {
        const s = tls.connect(
          2010,
          this.opts.ipaddress,
          { rejectUnauthorized: false, requestCert: true },
          () => onData(s),
        );
        s.once('error', (error) => failOnce(s, error));
        s.setTimeout(30000, () => failOnce(s, new Error('Timed out connecting to Vantage configuration port')));
      }
    });
  }

  private async writePersistentCacheAtomically(xml: string, candidateValidation: ValidatedConfiguration) {
    const cachePath = this.getPersistentCachePath();
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

    await this.validateCandidateAgainstExistingCache(cachePath, candidateValidation);

    try {
      fs.mkdirSync(this.getPersistentCacheDirectory(), { recursive: true });
      fs.writeFileSync(tmpPath, xml, 'utf8');
      const tmpXml = fs.readFileSync(tmpPath, 'utf8');
      const validation = await this.parseAndValidateConfigurationXml(tmpXml, `temporary cache ${tmpPath}`);
      await this.validateCandidateAgainstExistingCache(cachePath, validation);

      fs.renameSync(tmpPath, cachePath);
      this.opts.log.info(
        `Validated controller configuration accepted and persistent cache updated atomically at ${cachePath} ` +
          `(${validation.relevantObjectCount} relevant objects).`,
      );
    } catch (error) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  private getLegacyTmpCachePath(): string {
    return this.opts.legacyTmpCachePath || path.join('/tmp', 'vantage.dc');
  }

  private async writeLegacyTmpCacheMirror(xml: string, candidateValidation: ValidatedConfiguration) {
    const cachePath = this.getLegacyTmpCachePath();
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

    try {
      const tmpXml = this.buildCacheXml(this.objectsForLegacyTmpDump(candidateValidation.objects));
      fs.writeFileSync(tmpPath, tmpXml, 'utf8');
      const writtenXml = fs.readFileSync(tmpPath, 'utf8');
      const validation = await this.parseAndValidateConfigurationXml(
        writtenXml,
        `legacy temporary cache mirror ${tmpPath}`,
      );
      if (validation.relevantObjectCount === 0) {
        throw new Error('legacy cache mirror has no discoverable Vantage objects');
      }

      fs.renameSync(tmpPath, cachePath);
      this.opts.log.info(
        `Legacy /tmp Vantage cache mirror updated at ${cachePath} ` +
          `(${validation.relevantObjectCount} Organize Home objects)`,
      );
    } catch (error) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* preserve original error */
      }
      this.opts.log.warn(`Failed to update legacy /tmp Vantage cache mirror: ${this.errorMessage(error)}`);
    }
  }

  private async validateCandidateAgainstExistingCache(
    cachePath: string,
    candidateValidation: ValidatedConfiguration,
  ) {
    if (!fs.existsSync(cachePath)) return;

    const existingValidation = await this.validateExistingCacheForReplacement(cachePath);
    if (
      existingValidation &&
      existingValidation.relevantObjectCount >= 20 &&
      candidateValidation.relevantObjectCount < existingValidation.relevantObjectCount * 0.5
    ) {
      const message =
        `Downloaded configuration rejected as incomplete: ${candidateValidation.relevantObjectCount} relevant objects ` +
        `vs ${existingValidation.relevantObjectCount} in persistent cache.`;
      this.opts.log.error(message);
      throw new CandidateConfigurationError(message);
    }
  }

  private async validateExistingCacheForReplacement(cachePath: string): Promise<ValidatedConfiguration | undefined> {
    try {
      const existingXml = fs.readFileSync(cachePath, 'utf8');
      return await this.parseAndValidateConfigurationXml(existingXml, `existing cache ${cachePath}`);
    } catch (error) {
      this.opts.log.warn(
        `Existing cache is invalid; replacing it with validated controller configuration: ${this.errorMessage(error)}`,
      );
      return undefined;
    }
  }

  

  // ===== Commands used by platformAccessory handlers =====


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

  async setThermostatTarget(vid: string, value: number, mode?: number, _heating?: number, _cooling?: number) {
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

export function alternateVantageUsername(username: string): string | undefined {
  return username.trim().toLowerCase() === 'admin' ? 'administrator' : undefined;
}
