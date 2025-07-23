export interface VantageDevice {
  name: string;
  address: string;
  type: 'thermostat' | 'dimmer' | 'rgb' | 'relay' | 'blind' | 'non-dimmer';
  vid: string;
  objectType: string;
  loadType?: string;
  area?: string;
  dName?: string;
}

export interface VantageConfig {
  platform: string;
  name: string;
  ipaddress: string;
  username?: string;
  password?: string;
  usecache?: boolean;
  omit?: string;
  range?: string;
}

export interface VantageInfusionConfig {
  ipaddress: string;
  accessories: VantageDevice[];
  usecache: boolean;
  omit: string;
  range: string;
  username: string;
  password: string;
  isInsecure: boolean;
}

export interface InterfaceSupportResult {
  item: any;
  interface: string;
  support: boolean;
}

export interface VantageLoadState {
  bri: number;
  power: boolean;
  sat?: number;
  hue?: number;
}

export interface VantageThermostatState {
  temperature: number;
  targetTemp: number;
  heating: number;
  cooling: number;
  mode: number; // 0=off, 1=heat, 2=cool, 3=auto
  current: number; // 0=off, 1=heat, 2=cool
  units: number; // 0=celsius, 1=fahrenheit
}

export interface VantageBlindState {
  pos: number;
  posState: number; // decreasing=0, increasing=1, stopped=2
} 