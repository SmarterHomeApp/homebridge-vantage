const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { VantageInfusion, alternateVantageUsername, isFanLoadName } = require('../dist/vantageInfusion');
const { VantagePlatform } = require('../dist/platform');
const { sanitizeHomeKitName } = require('../dist/homekitName');

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function makeInfusion(storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-test-'))) {
  return new VantageInfusion({
    ipaddress: '10.0.0.100',
    username: '',
    password: '',
    usecache: true,
    omit: '',
    range: '0-10000',
    forceSSL: false,
    storagePath,
    log: logger(),
  });
}

function makeInfusionWithRange(range) {
  const infusion = makeInfusionWithOptions({ range });
  return infusion;
}

function makeInfusionWithOptions(options) {
  const infusion = makeInfusion();
  Object.assign(infusion.opts, options);
  return infusion;
}

function xmlObject(type, fields) {
  const body = Object.entries(fields)
    .map(([key, value]) => `<${key}>${String(value)}</${key}>`)
    .join('');
  return `<Object><${type}>${body}</${type}></Object>`;
}

function configuration(objects) {
  return `<Project><Objects>${objects.join('')}</Objects></Project>`;
}

function loads(count, startVid = 1) {
  return Array.from({ length: count }, (_, index) => xmlObject('Load', {
    VID: startVid + index,
    ObjectType: 'Load',
    Name: `Load ${startVid + index}`,
    LoadType: 'LED non-Dim',
  }));
}

test('area-only configuration is rejected as having no discoverable objects', async () => {
  const infusion = makeInfusion();
  const xml = configuration([xmlObject('Area', { VID: 1, Name: 'Kitchen', ObjectType: 'Area' })]);

  await assert.rejects(
    () => infusion.parseAndValidateConfigurationXml(xml, 'area-only test configuration'),
    /no discoverable Vantage objects \(1 objects: Area=1\)/,
  );
});

test('malformed XML is rejected instead of becoming an empty discovery', async () => {
  const infusion = makeInfusion();

  await assert.rejects(
    () => infusion.parseAndValidateConfigurationXml('<Project><Objects>', 'malformed test configuration'),
    /XML parsing failed/,
  );
});

test('a severely partial downloaded configuration does not replace the persistent cache', async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-cache-test-'));
  const infusion = makeInfusion(storagePath);

  const goodXml = configuration(loads(20));
  const goodValidation = await infusion.parseAndValidateConfigurationXml(goodXml, 'good test cache');
  await infusion.writePersistentCacheAtomically(goodXml, goodValidation);

  const cachePath = infusion.getPersistentCachePath();
  const originalCache = fs.readFileSync(cachePath, 'utf8');

  const partialXml = configuration(loads(4));
  const partialValidation = await infusion.parseAndValidateConfigurationXml(partialXml, 'partial test download');

  await assert.rejects(
    () => infusion.writePersistentCacheAtomically(partialXml, partialValidation),
    /appears incomplete|rejected as incomplete/,
  );

  assert.equal(fs.readFileSync(cachePath, 'utf8'), originalCache);
});

test('zero-device discovery preserves cached accessories and rebuilds the VID map', async () => {
  const platform = Object.create(VantagePlatform.prototype);
  let unregistered = 0;

  platform.log = logger();
  platform.infusion = new EventEmitter();
  platform.syncedOnce = false;
  platform.realtimeWired = false;
  platform.accessoriesByVid = new Map();
  platform.accessories = Array.from({ length: 100 }, (_, index) => ({
    UUID: `uuid-${index + 1}`,
    context: { device: { vid: index + 1, type: 'relay', name: `Relay ${index + 1}` } },
  }));
  platform.api = {
    hap: {
      uuid: { generate: (value) => `uuid-${value}` },
      Service: {},
      Characteristic: {},
    },
    unregisterPlatformAccessories() {
      unregistered += 1;
    },
  };

  await platform.syncAccessories([]);

  assert.equal(unregistered, 0);
  assert.equal(platform.accessoriesByVid.size, 100);
  assert.equal(platform.syncedOnce, true);
});

test('stale-removal threshold allows small cleanup but blocks severe drops', () => {
  const platform = Object.create(VantagePlatform.prototype);
  platform.accessories = Array.from({ length: 100 }, (_, index) => ({ UUID: `uuid-${index}` }));

  assert.equal(platform.shouldSkipStaleRemoval(98, 2), false);
  assert.equal(platform.shouldSkipStaleRemoval(2, 98), true);

  platform.accessories = Array.from({ length: 10 }, (_, index) => ({ UUID: `uuid-small-${index}` }));
  assert.equal(platform.shouldSkipStaleRemoval(4, 6), true);
  assert.equal(platform.shouldSkipStaleRemoval(8, 2), false);
});

test('VID range supports preferred dash format and legacy comma format', async () => {
  const xml = configuration(loads(5, 100));

  const dashDevices = await makeInfusionWithRange('101-102').processConfigurationXml(xml, 'dash range test');
  assert.deepEqual(dashDevices.map((device) => device.vid), ['101', '102']);

  const commaDevices = await makeInfusionWithRange('101,102').processConfigurationXml(xml, 'legacy comma range test');
  assert.deepEqual(commaDevices.map((device) => device.vid), ['101', '102']);
});

test('controller configuration download requests core device object types', () => {
  const infusion = makeInfusion();
  const controllers = Object.fromEntries(
    infusion.getConfigurationControllers().map((controller) => [controller.name, controller.vantageTypes]),
  );
  const objectTypes = infusion.getConfigurationObjectTypes();

  for (const objectType of [
    'Area',
    'Load',
    'Vantage.DGColorLoad',
    'Blind',
    'RelayBlind',
    'QISBlind',
    'Somfy.RS-485_Shade_CHILD',
    'Thermostat',
    'Vantage.HVAC-IU-Zone_CHILD',
    'DryContact',
  ]) {
    assert.equal(objectTypes.includes(objectType), true);
  }

  assert.deepEqual(controllers.rgbLoads, ['Vantage.DGColorLoad', 'Vantage.DDGColorLoad']);
  assert.deepEqual(controllers.loads, [
    'Load',
    'Legrand.MH_Relay_CHILD',
    'Legrand.MH_Dimmer_CHILD',
    'Jandy.Aqualink_RS_Pump_CHILD',
    'Jandy.Aqualink_RS_Auxiliary_CHILD',
  ]);
  assert.deepEqual(controllers.blinds, [
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
  ]);
  assert.deepEqual(controllers.thermostats, [
    'Thermostat',
    'Vantage.HVAC-Interface_Point_Zone_CHILD',
    'Vantage.Generic_HVAC_RS485_Zone_CHILD',
    'Vantage.Generic_HVAC_RS485_Zone_without_FanSpeed_CHILD',
    'Tekmar.tN4_Gateway_482_Zone_-_Slab_Only_CHILD',
    'Tekmar.tN4_Gateway_482_Zone_CHILD',
    'Legrand.MH_HVAC_Control_CHILD',
    'Vantage.HVAC-IU-Zone_CHILD',
    'Vantage.VirtualThermostat_PORT',
  ]);
  assert.deepEqual(controllers.sensors, ['DryContact', 'Temperature', 'LightSensor', 'OmniSensor']);
});

test('over-limit device guidance suggests multiple VID ranges', () => {
  const infusion = makeInfusion();
  const devices = Array.from({ length: 177 }, (_, index) => ({
    vid: String(index + 1),
    type: 'relay',
    name: `Relay ${index + 1}`,
    address: String(index + 1),
  }));

  assert.deepEqual(infusion.suggestVidRanges(devices), ['0-89', '90-999999999']);
});

test('device category include flags filter generated accessories', async () => {
  const xml = configuration([
    xmlObject('Load', {
      VID: 1,
      ObjectType: 'Load',
      Name: 'Load 1',
      LoadType: 'LED non-Dim',
    }),
    xmlObject('DryContact', {
      VID: 2,
      ObjectType: 'DryContact',
      Name: 'Contact 1',
    }),
    xmlObject('Temperature', {
      VID: 3,
      ObjectType: 'Temperature',
      Name: 'Temperature 1',
    }),
    xmlObject('Thermostat', {
      VID: 4,
      ObjectType: 'Thermostat',
      DeviceCategory: 'HVAC',
      Name: 'Thermostat 1',
    }),
    xmlObject('Blind', {
      VID: 5,
      ObjectType: 'Blind',
      Name: 'Blind 1',
    }),
  ]);

  const noSensorsOrThermostats = await makeInfusionWithOptions({
    includeSensors: false,
    includeThermostats: false,
  }).processConfigurationXml(xml, 'category filter test');

  assert.deepEqual(noSensorsOrThermostats.map((device) => device.type), ['relay', 'blind']);

  const sensorsOnly = await makeInfusionWithOptions({
    includeLights: false,
    includeBlinds: false,
    includeThermostats: false,
  }).processConfigurationXml(xml, 'sensor-only category filter test');

  assert.deepEqual(sensorsOnly.map((device) => device.type), ['contact', 'temperatureSensor']);
});

test('original exact object families still classify without extra capability fields', async () => {
  const xml = configuration([
    xmlObject('Legrand.MH_Dimmer_CHILD', {
      VID: 10,
      ObjectType: 'Legrand.MH_Dimmer_CHILD',
      Name: 'Legrand Dimmer',
    }),
    xmlObject('QISBlind', {
      VID: 11,
      ObjectType: 'QISBlind',
      Name: 'QIS Shade',
    }),
    xmlObject('Tekmar.tN4_Gateway_482_Zone_CHILD', {
      VID: 12,
      ObjectType: 'Tekmar.tN4_Gateway_482_Zone_CHILD',
      Name: 'Tekmar Zone',
    }),
  ]);

  const devices = await makeInfusion().processConfigurationXml(xml, 'original exact family classification test');
  assert.deepEqual(devices.map((device) => [device.vid, device.type, device.objectType]), [
    ['10', 'dimmer', 'Legrand.MH_Dimmer_CHILD'],
    ['11', 'blind', 'QISBlind'],
    ['12', 'thermostat', 'Tekmar.tN4_Gateway_482_Zone_CHILD'],
  ]);
});

test('capability fields classify load and blind objects without hardcoded subtype names', async () => {
  const xml = configuration([
    xmlObject('Vendor.CustomDimmer_CHILD', {
      VID: 100,
      ObjectType: 'Vendor.CustomDimmer_CHILD',
      Name: 'Custom Dimmer',
      LoadType: 'LED Dim',
      PowerProfile: 1,
    }),
    xmlObject('Vendor.CustomRelay_CHILD', {
      VID: 101,
      ObjectType: 'Vendor.CustomRelay_CHILD',
      Name: 'Custom Relay',
      LoadType: 'High Voltage Relay',
    }),
    xmlObject('Vendor.CustomShade_CHILD', {
      VID: 102,
      ObjectType: 'Vendor.CustomShade_CHILD',
      Name: 'Custom Shade',
      ShadeType: 'Roller Shade',
      ShadeOrientation: 'Horizontal',
      Movement: '0',
    }),
    xmlObject('LoadGroup', {
      VID: 103,
      ObjectType: 'LoadGroup',
      Name: 'Duplicate Light Group',
    }),
    xmlObject('BlindGroup', {
      VID: 104,
      ObjectType: 'BlindGroup',
      Name: 'Duplicate Blind Group',
    }),
  ]);

  const devices = await makeInfusion().processConfigurationXml(xml, 'capability classification test');

  assert.deepEqual(devices.map((device) => [device.vid, device.type, device.objectType]), [
    ['100', 'dimmer', 'Vendor.CustomDimmer_CHILD'],
    ['101', 'relay', 'Vendor.CustomRelay_CHILD'],
    ['102', 'blind', 'Vendor.CustomShade_CHILD'],
  ]);
});

test('admin username is retried as administrator', () => {
  assert.equal(alternateVantageUsername('admin'), 'administrator');
  assert.equal(alternateVantageUsername('Admin'), 'administrator');
  assert.equal(alternateVantageUsername('administrator'), undefined);
  assert.equal(alternateVantageUsername('installer'), undefined);
});

test('HomeKit names drop quotes, trailing punctuation, and keep a letter-or-number ending', () => {
  assert.equal(sanitizeHomeKitName('CONFERENCE ROOM NORA 4" LED'), 'CONFERENCE ROOM NORA 4 LED');
  assert.equal(sanitizeHomeKitName('SPARE SPARE (IN CEILING)'), 'SPARE SPARE IN CEILING');
  assert.equal(sanitizeHomeKitName('RECEPTION DESK?'), 'RECEPTION DESK');
  assert.equal(sanitizeHomeKitName('JACK\'S OFFICE LAMP'), 'JACK\'S OFFICE LAMP');
  assert.equal(sanitizeHomeKitName('???'), 'Vantage');
});

test('loads named fan become HomeKit fans, other loads stay lights', async () => {
  assert.equal(isFanLoadName('Master Fan'), true);
  assert.equal(isFanLoadName('FAN'), true);
  assert.equal(isFanLoadName('Ceiling Fan 1'), true);
  assert.equal(isFanLoadName('Kitchen Light'), false);
  assert.equal(isFanLoadName('Fantastic Light'), false);

  const xml = configuration([
    xmlObject('Load', {
      VID: 10,
      ObjectType: 'Load',
      Name: 'Master Fan',
      LoadType: 'Incandescent',
    }),
    xmlObject('Load', {
      VID: 11,
      ObjectType: 'Load',
      Name: 'Kitchen Light',
      LoadType: 'Incandescent',
    }),
    xmlObject('Load', {
      VID: 12,
      ObjectType: 'Load',
      Name: 'Bath Fan',
      LoadType: 'High Voltage Relay',
    }),
  ]);

  const devices = await makeInfusion().processConfigurationXml(xml, 'fan load classification test');
  assert.deepEqual(devices.map((device) => [device.vid, device.type]), [
    ['10', 'fan'],
    ['11', 'dimmer'],
    ['12', 'fan'],
  ]);
});

test('invalid thermostat sentinel values are not pushed to HomeKit target temperature', () => {
  const platform = Object.create(VantagePlatform.prototype);
  const updates = [];
  const thermostatService = {
    updateCharacteristic(characteristic, value) {
      updates.push([characteristic, value]);
    },
  };

  platform.log = logger();
  platform.infusion = new EventEmitter();
  platform.realtimeWired = false;
  platform.invalidThermostatWarnings = new Set();
  platform.accessoriesByVid = new Map([
    ['23444', {
      context: {
        device: {
          vid: 23444,
          type: 'thermostat',
          name: 'SHADES Thermostat 1',
          temperature: 20,
          heating: 0,
          cooling: 0,
          mode: 3,
        },
      },
      getService() {
        return thermostatService;
      },
    }],
  ]);
  platform.api = {
    hap: {
      Service: { Thermostat: 'Thermostat' },
      Characteristic: {
        CurrentHeatingCoolingState: 'CurrentHeatingCoolingState',
        TargetHeatingCoolingState: 'TargetHeatingCoolingState',
        TargetTemperature: 'TargetTemperature',
        HeatingThresholdTemperature: 'HeatingThresholdTemperature',
        CoolingThresholdTemperature: 'CoolingThresholdTemperature',
        CurrentTemperature: 'CurrentTemperature',
        ContactSensorState: {
          CONTACT_DETECTED: 0,
          CONTACT_NOT_DETECTED: 1,
        },
        CurrentAmbientLightLevel: 'CurrentAmbientLightLevel',
      },
    },
  };

  platform.wireRealtimeListeners();
  platform.infusion.emit('thermostatIndoorTemperatureChange', 23444, 999);
  platform.infusion.emit('thermostatIndoorModeChange', 23444, 1, 999);

  assert.equal(updates.some(([, value]) => value === 999), false);
  assert.ok(updates.some(([characteristic, value]) => characteristic === 'TargetTemperature' && value === 20));
  assert.ok(updates.some(([characteristic, value]) => characteristic === 'CoolingThresholdTemperature' && value === 25));
});

test('thermostat child Temperature objects update the parent thermostat instead of registering duplicate sensors', async () => {
  const infusion = makeInfusion();
  const xml = configuration([
    xmlObject('Thermostat', {
      VID: 100,
      ObjectType: 'Thermostat',
      DeviceCategory: 'HVAC',
      Name: 'Hall Thermostat',
    }),
    xmlObject('Temperature', {
      VID: 101,
      ObjectType: 'Temperature',
      Name: 'Indoor Temperature',
      Parent: 100,
      Position: 1,
    }),
    xmlObject('Temperature', {
      VID: 200,
      ObjectType: 'Temperature',
      Name: 'Outdoor Temperature',
      Value: 70,
    }),
  ]);

  const devices = await infusion.processConfigurationXml(xml, 'thermostat child temperature test');
  assert.deepEqual(devices.map((device) => [device.vid, device.type]), [
    ['100', 'thermostat'],
    ['200', 'temperatureSensor'],
  ]);

  let event;
  infusion.on('thermostatChildTemperatureChange', (...args) => {
    event = args;
  });

  infusion.parseRealtime('S:TEMPERATURE 101 72\n');

  assert.deepEqual(event, ['100', 'indoor', 72]);
});

test('nearby thermostat helper contacts and temperatures are not registered as standalone sensors', async () => {
  const infusion = makeInfusion();
  const xml = configuration([
    xmlObject('Thermostat', {
      VID: 131,
      ObjectType: 'Thermostat',
      DeviceCategory: 'HVAC',
      Name: 'Reception',
    }),
    xmlObject('DryContact', {
      VID: 132,
      ObjectType: 'DryContact',
      Name: 'Fan',
    }),
    xmlObject('DryContact', {
      VID: 133,
      ObjectType: 'DryContact',
      Name: 'Night Mode',
    }),
    xmlObject('DryContact', {
      VID: 134,
      ObjectType: 'DryContact',
      Name: 'Cool 1',
    }),
    xmlObject('DryContact', {
      VID: 135,
      ObjectType: 'DryContact',
      Name: 'Heat 1',
    }),
    xmlObject('Temperature', {
      VID: 136,
      ObjectType: 'Temperature',
      Name: 'Internal Sensor',
    }),
    xmlObject('Temperature', {
      VID: 137,
      ObjectType: 'Temperature',
      Name: 'Cool Set Point',
    }),
    xmlObject('Temperature', {
      VID: 138,
      ObjectType: 'Temperature',
      Name: 'Heat Set Point',
    }),
    xmlObject('DryContact', {
      VID: 200,
      ObjectType: 'DryContact',
      Name: 'Door Contact',
    }),
  ]);

  const devices = await infusion.processConfigurationXml(xml, 'nearby thermostat helper test');
  assert.deepEqual(devices.map((device) => [device.vid, device.type]), [
    ['131', 'thermostat'],
    ['200', 'contact'],
  ]);
});

test('cache XML keeps relay loads and drops nested objects with no text', () => {
  const infusion = makeInfusion();
  const xml = infusion.buildCacheXml([
    {
      Load: {
        VID: '10',
        Name: 'Kitchen',
        LoadType: 'High Voltage Relay',
        Device: { Address: '1.2.3', Channel: '4' },
      },
    },
  ]);

  assert.match(xml, /<VID>10<\/VID>/);
  assert.match(xml, /<LoadType>High Voltage Relay<\/LoadType>/);
  assert.doesNotMatch(xml, /<Device>/);
  assert.doesNotMatch(xml, /\[object Object\]/);
});

test('cache XML emits xml2js mixed-content objects as text-only tags for Organize Home', async () => {
  const infusion = makeInfusion();
  const xml = infusion.buildCacheXml([
    {
      Load: {
        VID: '10',
        ObjectType: 'Load',
        Name: 'Kitchen',
        LoadType: 'Low Voltage Relay',
        Parent: { _: '14', Position: '1' },
        Device: { _: 'raw device text', Address: '1.2.3' },
      },
    },
  ]);

  assert.doesNotMatch(xml, /<_>/);
  assert.doesNotMatch(xml, /<Parent>14<Position>/);
  assert.doesNotMatch(xml, / Position="/);
  assert.match(xml, /<Parent>14<\/Parent>/);
  assert.match(xml, /<Device>raw device text<\/Device>/);
  assert.match(xml, /<LoadType>Low Voltage Relay<\/LoadType>/);

  const parsed = await infusion.parseAndValidateConfigurationXml(xml, 'mixed-content cache xml');
  assert.equal(parsed.relevantObjectCount, 1);
});

test('persistent cache fallback refreshes the Organize Home /tmp dump', async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-cache-test-'));
  const tmpMirrorPath = path.join(storagePath, 'vantage.dc');
  const infusion = makeInfusionWithOptions({
    storagePath,
    legacyTmpCachePath: tmpMirrorPath,
  });

  const cachedXml = configuration(loads(5, 20));
  const validation = await infusion.parseAndValidateConfigurationXml(cachedXml, 'persistent cache mirror test');
  await infusion.writePersistentCacheAtomically(cachedXml, validation);

  await infusion.loadPersistentCache({ refreshLegacyTmpMirror: true });

  assert.equal(fs.readFileSync(tmpMirrorPath, 'utf8'), cachedXml);
});

test('Organize Home tmp dump copies AreaID onto Area so iOS can map rooms', async () => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-cache-test-'));
  const tmpMirrorPath = path.join(storagePath, 'vantage.dc');
  const infusion = makeInfusionWithOptions({
    storagePath,
    legacyTmpCachePath: tmpMirrorPath,
  });

  const xml = configuration([
    xmlObject('Area', { VID: 10, ObjectType: 'Area', Name: 'Conference' }),
    xmlObject('Load', {
      VID: 13,
      ObjectType: 'Load',
      Name: 'TABLE',
      LoadType: 'LED Dim',
      AreaID: 10,
    }),
    xmlObject('Load', {
      VID: 609,
      ObjectType: 'Load',
      Name: 'FAN',
      LoadType: 'High Voltage Relay',
      AreaID: 8,
    }),
    xmlObject('DryContact', { VID: 200, ObjectType: 'DryContact', Name: 'Door', AreaID: 0 }),
  ]);
  const validation = await infusion.parseAndValidateConfigurationXml(xml, 'tmp AreaID mapping test');
  await infusion.writeLegacyTmpCacheMirror(xml, validation);

  const dumped = fs.readFileSync(tmpMirrorPath, 'utf8');
  assert.match(dumped, /<LoadType>High Voltage Relay<\/LoadType>/);
  assert.match(dumped, /<AreaID>10<\/AreaID><Area>10<\/Area>/);
  assert.match(dumped, /<AreaID>8<\/AreaID><Area>8<\/Area>/);
  assert.match(dumped, /<Name>Area 8<\/Name>/);
  assert.match(dumped, /<DryContact>/);
  assert.match(dumped, /<AreaID>0<\/AreaID><Area>0<\/Area>/);
  assert.match(dumped, /<VID>0<\/VID><Name>Unassigned<\/Name><ObjectType>Area<\/ObjectType>/);
});
