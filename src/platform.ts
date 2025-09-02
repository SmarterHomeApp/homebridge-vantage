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

export class VantagePlatform implements DynamicPlatformPlugin {
  public readonly accessories: PlatformAccessory[] = [];

  private infusion!: VantageInfusion;
  private syncedOnce = false; // prevent double-sync when both event + promise fire

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    if (!config || !config.ipaddress) {
      this.log.error(`[${PLATFORM_NAME}] Missing required config "ipaddress" — plugin will not start.`);
      return;
    }

    // Construct infusion
    this.infusion = new VantageInfusion({
      ipaddress: String(config.ipaddress),
      username: (config as any).username ?? '',
      password: (config as any).password ?? '',
      usecache: (config as any).usecache ?? true,
      omit: (config as any).omit ?? '',
      range: (config as any).range ?? '0,999999999',
      forceSSL: (config as any).forceSSL ?? false,
      log: this.log,
    });

    // ----- Legacy event path: keep your old behavior -----
    // this.infusion.on('endDownloadConfiguration', async (_xml: string) => {
    //   // If promise path already completed, ignore; else run discovery+sync now
    //   if (this.syncedOnce) return;
    //   this.log.debug('endDownloadConfiguration event received — running discovery sync');
    //   try {
    //     const devices = await this.infusion.discoverDevices();
    //     await this.syncAccessories(devices);
    //     this.finalizeLogs();
    //   } catch (e: any) {
    //     this.log.error(`Discovery (event) failed: ${e?.message ?? String(e)}`);
    //   }
    // });

    // ----- Standard HB boot path -----
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
      try {
        await this.infusion.start();
        // Promise-based discovery (will no-op if event already handled it)
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

    // Map current devices
    const wanted = new Map<string, VantageDevice>();
    for (const d of devices) wanted.set(uuidFor(d), d);

    // Update existing / mark seen
    const seen = new Set<string>();
    for (const acc of this.accessories) {
      const d = wanted.get(acc.UUID);
      if (d) {
        // Update name/context and re-bind
        acc.displayName = d.name;
        acc.context.device = d;
        new VantagePlatformAccessory(this, acc);
        seen.add(acc.UUID);
      }
    }

    // Register new
    const toRegister: PlatformAccessory[] = [];
    for (const d of devices) {
      const uuid = uuidFor(d);
      if (seen.has(uuid)) continue;

      const acc = new this.api.platformAccessory(d.name, uuid);
      acc.context.device = d;
      new VantagePlatformAccessory(this, acc);
      toRegister.push(acc);
      this.accessories.push(acc);
    }
    if (toRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
      this.log.info(`Registered ${toRegister.length} new accessories`);
    }

    // Unregister stale
    const toUnregister = this.accessories.filter((acc) => !wanted.has(acc.UUID));
    if (toUnregister.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toUnregister);
      this.log.info(`Unregistered ${toUnregister.length} stale accessories`);
      // Remove from local cache
      for (const acc of toUnregister) {
        const idx = this.accessories.findIndex((a) => a.UUID === acc.UUID);
        if (idx >= 0) this.accessories.splice(idx, 1);
      }
    }

    this.syncedOnce = true;
  }

  private finalizeLogs() {
    // Legacy “store/open for business” logs
    this.log.warn('VantagePlatform for InFusion Controller (end configuration store)');
    this.log.warn('VantagePlatform for InFusion Controller (is open for business)');
  }

  // Exposed for accessory class
  public getInfusion(): VantageInfusion {
    return this.infusion;
  }

  public getApi(): API {
    return this.api;
  }
}
