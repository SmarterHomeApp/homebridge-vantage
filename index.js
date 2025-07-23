var net = require('net');
var tls = require('tls');
var sprintf = require("sprintf-js").sprintf, inherits = require("util").inherits, Promise = require('promise');
var parser = require('xml2json'), libxmljs = require("libxmljs"), sleep = require('sleep');
var events = require('events'), util = require('util'), fs = require('fs');
var Accessory, Characteristic, Service, UUIDGen;
var typeThermo = ["Thermostat", "Vantage.HVAC-Interface_Point_Zone_CHILD", "Vantage.VirtualThermostat_PORT", "Tekmar.tN4_Gateway_482_Zone_-_Slab_Only_CHILD", "Tekmar.tN4_Gateway_482_Zone_CHILD", "Legrand.MH_HVAC_Control_CHILD"]
var typeBlind = ["Blind", "RelayBlind", "QISBlind", "Lutron.Shade_x2F_Blind_Child_CHILD", "QubeBlind", "ESI.RQShadeChannel_CHILD", "QMotion.QIS_Channel_CHILD","Somfy.UAI-RS485-Motor_CHILD"]
var objecTypes = ["Area", "Load", "Vantage.DDGColorLoad", "Legrand.MH_Relay_CHILD", "Legrand.MH_Dimmer_CHILD", "Jandy.Aqualink_RS_Pump_CHILD", "Jandy.Aqualink_RS_Auxiliary_CHILD"].concat(typeThermo.concat(typeBlind))
var useBackup = false;
var useSecure = false

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	Accessory = homebridge.platformAccessory;
	UUIDGen = homebridge.hap.uuid;

	inherits(VantageLoad, Accessory);
	process.setMaxListeners(0);
	homebridge.registerPlatform("homebridge-vantage", "VantageControls", VantagePlatform);
};

var portIsUsable = function (port, ipaddress, text, callback) {
	var returnVal = false
	var command = net.connect({ host: ipaddress, port: port }, () => {
		command.write(sprintf(text));
	});
	command.setTimeout(5e3, () => command.destroy());
	command.once('connect', () => command.setTimeout(0));
	command.on('data', (data) => {
		returnVal = true
		callback(true)
		command.destroy();
	});
	command.on("close", () => {
		if (!returnVal)
			callback(false)
		command.destroy();
	})
	command.on("end", () => {
		command.destroy();
	})
	command.on("error", console.error)
};

class VantageInfusion {
	constructor(ipaddress, accessories, usecache, omit, range, username, password, isInsecure) {
		util.inherits(VantageInfusion, events.EventEmitter);
		this.ipaddress = ipaddress;
		this.usecache = usecache;
		this.accessories = accessories || [];
		this.omit = omit
		this.range = range
		this.username = username
		this.password = password
		this.command = {};
		this.interfaces = {};
		this.isInsecure = isInsecure
		if (this.isInsecure && !useSecure)
			this.StartCommand();
		else
			this.StartCommandSSL();
	}

	/**
	 * Start the command session. The InFusion controller (starting from the 3.2 version of the
	 * firmware) must be configured without encryption or password protection. Support to SSL
	 * and password protected connection will be introduced in the future, the IoT world is
	 * a bad place! 
	 */
	StartCommand() {
		this.command = net.connect({ host: this.ipaddress, port: 3001 }, () => {
			if (this.username != "" && this.password != "") {
				this.command.write(sprintf("Login %s %s\n", this.username, this.password));
			}
			console.log("connected")
			this.command.write(sprintf("STATUS ALL\n"));
			this.command.write(sprintf("ELENABLE 1 AUTOMATION ON\nELENABLE 1 EVENT ON\nELENABLE 1 STATUS ON\nELENABLE 1 STATUSEX ON\nELENABLE 1 SYSTEM ON\nELLOG AUTOMATION ON\nELLOG EVENT ON\nELLOG STATUS ON\nELLOG STATUSEX ON\nELLOG SYSTEM ON\n"));
		});

		this.command.on('data', (data) => {
			/* Data received */
			var lines = data.toString().split('\n');
			for (var i = 0; i < lines.length; i++) {
				var dataItem = lines[i].split(" ");
				// console.log(dataItem);
				try {
					if (lines[i].startsWith("S:BLIND") || lines[i].startsWith("R:GETBLIND") || (lines[i].startsWith("R:INVOKE") && dataItem[3].includes("Blind"))) {
						/* Live update about load level (even if it's a RGB load') */
						this.emit("blindStatusChange", parseInt(dataItem[1]), parseInt(dataItem[2]));
					}
					if (lines[i].startsWith("S:LOAD ") || lines[i].startsWith("R:GETLOAD ")) {
						/* Live update about load level (even if it's a RGB load') */
						this.emit("loadStatusChange", parseInt(dataItem[1]), parseInt(dataItem[2]));
					}
					if (dataItem[0] == "R:INVOKE" && dataItem[3].includes("RGBLoad.GetHSL")) {
						/* Live update about load level (even if it's a RGB load') */
						this.emit("loadStatusChange", parseInt(dataItem[1]), parseInt(dataItem[2]), parseInt(dataItem[4]));
					}
					if (dataItem[0] == "S:TEMP") {
						//console.log("now lets set the temp!" + parseInt(dataItem[2]));
						this.emit(sprintf("thermostatDidChange"), parseInt(dataItem[2]));
						// this.emit(sprintf("thermostatIndoorTemperatureChange"), parseInt(dataItem[2]));
					}
					else if (dataItem[0] == "R:INVOKE" && dataItem[3].includes("Thermostat.GetIndoorTemperature")) {
						//console.log("lets get the indoor temp!")
						this.emit(sprintf("thermostatIndoorTemperatureChange"), parseInt(dataItem[1]), parseFloat(dataItem[2]));
					}
					else if (dataItem[0] == "S:THERMOP" || dataItem[0] == "R:GETTHERMOP" || dataItem[0] == 'R:THERMTEMP') {
						var modeVal = 0;
						if (dataItem[2].includes("OFF"))
							modeVal = 0;
						else if (dataItem[2].includes("HEAT"))
							modeVal = 1;
						else if (dataItem[2].includes("COOL"))
							modeVal = 2;
						else
							modeVal = 3;
						// console.log(parseInt(modeVal));
						if (dataItem[0] == "S:THERMOP" || dataItem[0] == "R:GETTHERMOP")
							this.emit(sprintf("thermostatIndoorModeChange"), parseInt(dataItem[1]), parseInt(modeVal), -1);
						else
							this.emit(sprintf("thermostatIndoorModeChange"), parseInt(dataItem[1]), parseInt(modeVal), parseFloat(dataItem[3]));
					}
				} catch (error) {
					console.log("unable to update status")
				}

				/* Non-state feedback */
				if (lines[i].startsWith("R:INVOKE") && lines[i].indexOf("Object.IsInterfaceSupported")) {
					this.emit(sprintf("isInterfaceSupportedAnswer-%d-%d", parseInt(dataItem[1]), parseInt(dataItem[4])), parseInt(dataItem[2]));
				}
			}
		});

		this.command.on("close", () => {
			console.log("\n\nPort 3001 has closed!!\n\n");
			this.reconnect()
		})

		this.command.on("end", () => {
			console.log("Port 3001 has ended!!");
			// this.reconnect()
		})

		this.command.on("error", console.error)
	}

	// function that reconnect the client to the server
	reconnect() {
		console.log("Attempting reconnect!");
		this.command.removeAllListeners()
		this.command.destroy();
		setTimeout(() => {
			if (this.isInsecure && !useSecure)
				this.StartCommand()
			else
				this.StartCommandSSL()
		}, 5000)
	}

	StartCommandSSL() {
		const options = {
			rejectUnauthorized: false,
			requestCert: true
		};
		var self = this
		const socket = tls.connect(3010, this.ipaddress, options, function () {
			if (self.username != "" && self.password != "") {
				socket.write(sprintf("Login %s %s\n", self.username, self.password));
			}
			socket.write(sprintf("STATUS ALL\n"));
			socket.write(sprintf("ELENABLE 1 AUTOMATION ON\nELENABLE 1 EVENT ON\nELENABLE 1 STATUS ON\nELENABLE 1 STATUSEX ON\nELENABLE 1 SYSTEM ON\nELLOG AUTOMATION ON\nELLOG EVENT ON\nELLOG STATUS ON\nELLOG STATUSEX ON\nELLOG SYSTEM ON\n"));
		}.bind(this));

		socket.on('data', (data) => {
			/* Data received */
			var lines = data.toString().split('\n');
			for (var i = 0; i < lines.length; i++) {
				var dataItem = lines[i].split(" ");
				// console.log(dataItem);
				try {
					if (lines[i].startsWith("S:BLIND") || lines[i].startsWith("R:GETBLIND") || (lines[i].startsWith("R:INVOKE") && dataItem[3].includes("Blind"))) {
						/* Live update about load level (even if it's a RGB load') */
						this.emit("blindStatusChange", parseInt(dataItem[1]), parseInt(dataItem[2]));
					}
					if (lines[i].startsWith("S:LOAD ") || lines[i].startsWith("R:GETLOAD ")) {
						/* Live update about load level (even if it's a RGB load') */
						self.emit("loadStatusChange", parseInt(dataItem[1]), parseInt(dataItem[2]));
					}
					if (dataItem[0] == "R:INVOKE" && dataItem[3].includes("RGBLoad.GetHSL")) {
						/* Live update about load level (even if it's a RGB load') */
						this.emit("loadStatusChange", parseInt(dataItem[1]), parseInt(dataItem[2]), parseInt(dataItem[4]));
					}
					if (dataItem[0] == "S:TEMP") {
						//console.log("now lets set the temp!" + parseInt(dataItem[2]));
						self.emit(sprintf("thermostatDidChange"), parseInt(dataItem[2]));
						// self.emit(sprintf("thermostatIndoorTemperatureChange"), parseInt(dataItem[2]));
					}
					else if (dataItem[0] == "R:INVOKE" && dataItem[3].includes("Thermostat.GetIndoorTemperature")) {
						//console.log("lets get the indoor temp!")
						self.emit(sprintf("thermostatIndoorTemperatureChange"), parseInt(dataItem[1]), parseFloat(dataItem[2]));
					}
					else if (dataItem[0] == "S:THERMOP" || dataItem[0] == "R:GETTHERMOP" || dataItem[0] == 'R:THERMTEMP') {
						var modeVal = 0;
						if (dataItem[2].includes("OFF"))
							modeVal = 0;
						else if (dataItem[2].includes("HEAT"))
							modeVal = 1;
						else if (dataItem[2].includes("COOL"))
							modeVal = 2;
						else
							modeVal = 3;
						// console.log(parseInt(modeVal));
						if (dataItem[0] == "S:THERMOP" || dataItem[0] == "R:GETTHERMOP")
							self.emit(sprintf("thermostatIndoorModeChange"), parseInt(dataItem[1]), parseInt(modeVal), -1);
						else
							self.emit(sprintf("thermostatIndoorModeChange"), parseInt(dataItem[1]), parseInt(modeVal), parseFloat(dataItem[3]));
					}
				} catch (error) {
					console.log("unable to update status")
				}

				/* Non-state feedback */
				if (lines[i].startsWith("R:INVOKE") && lines[i].indexOf("Object.IsInterfaceSupported")) {
					self.emit(sprintf("isInterfaceSupportedAnswer-%d-%d", parseInt(dataItem[1]), parseInt(dataItem[4])), parseInt(dataItem[2]));
				}
			}
		});

		socket.on('close', () => {
			console.log("\nPort 3010 has closed!!\n");
			socket.removeAllListeners()
			socket.destroy()
			self.reconnect()
		});

		socket.on('end', () => {
			console.log("Port 3010 has ended !!");
			// self.reconnect()
		});

		socket.on("error", console.error)

		this.command = socket
	}

	getLoadStatus(vid) {
		this.command.write(sprintf("GETLOAD %s\n", vid));
	}

	getLoadHSL(vid, val) {
		this.command.write(sprintf("INVOKE %s RGBLoad.GetHSL %s\n", vid, val));
	}

	/**
	 * Send the IsInterfaceSupported request to the InFusion controller,
	 * it needs the VID of the object and the IID (InterfaceId) taken 
	 * previously with the configuration session
	 * @return true, false or a promise!
	 */
	isInterfaceSupported(item, interfaceName) {
		if (this.interfaces[interfaceName] === undefined) {
			return new Promise((resolve, reject) => {
				resolve({ 'item': item, 'interface': interfaceName, 'support': false });
			});
		} else {
			/**
			 * Sample
			 *   OUT| INVOKE 2774 Object.IsInterfaceSupported 32
			 *    IN| R:INVOKE 2774 0 Object.IsInterfaceSupported 32
			 */
			var interfaceId = this.interfaces[interfaceName];

			return new Promise((resolve, reject) => {
				this.once(sprintf("isInterfaceSupportedAnswer-%d-%d", parseInt(item.VID), parseInt(interfaceId)), (_support) => {
					resolve({ 'item': item, 'interface': interfaceName, 'support': _support });
				}
				);
				sleep.usleep(5000);
				this.command.write(sprintf("INVOKE %s Object.IsInterfaceSupported %s\n", item.VID, interfaceId));
			});
		}
	}

	/**
	 * Start the discovery procedure that use the local cache or download from the InFusion controller
	 * the last configuration saved on the SD card (usually the developer save a backup copy of the configuration
	 * on this support but in some cases it can be different from the current running configuration, I need to
	 * check how to download it with a single pass procedure)
	 */
	Discover() {
		var configuration = net.connect({ host: this.ipaddress, port: 2001 }, () => {
			/**
			 * List interfaces, list configuration and then check if a specific interface 
			 * is supported by the recognized devices. 
			 */
			console.log("load dc file")

			var buffer = "";
			var xmlResult = ""
			var readObjects = []
			var writeCount = 0
			var objectDict = {}
			var controller = 1;
			var shouldbreak = false
			configuration.on('data', (data) => {
				buffer = buffer + data.toString().replace("\ufeff", "");

				try {
					if (useBackup) {
						buffer = buffer.replace('<?File Encode="Base64" /', '<File>');
						buffer = buffer.replace('?>', '</File>');

						if (buffer.includes("</File>")) {
							console.log("end");
							var start = buffer.split("<File>")
							var end = buffer.split("</File>")

							buffer = buffer.match("<File>" + "(.*?)" + "</File>");
							buffer = buffer[1]
							var newtext = new Buffer(buffer, 'base64');
							newtext = newtext.toString()
							newtext = newtext.replace(/[\r\n]/g, '');
							var init = newtext.split("<Objects>")
							newtext = newtext.match("<Objects>" + "(.*?)" + "</Objects>");
							if (newtext == null) {
								console.log("null");
							}
							xmlResult = new Buffer(init[0] + "<Objects>" + newtext[1] + "</Objects></Project>");
							xmlResult = xmlResult.toString('base64');
							buffer = "<smarterHome>" + start[0] + "<File>" + xmlResult + "</File>" + end[end.length - 1] + "</smarterHome>"
						}
					}
					libxmljs.parseXml(buffer);
				} catch (e) {
					return false;
				}
				if (writeCount < objecTypes.length)
					console.log("parse Json: " + objecTypes[writeCount] + " on controller: " + controller.toString())
				var parsed = JSON.parse(parser.toJson(buffer));
				if (parsed.smarterHome !== undefined) {
					if (parsed.smarterHome.IIntrospection !== undefined) {
						var interfaces = parsed.smarterHome.IIntrospection.GetInterfaces.return.Interface;
						for (var i = 0; i < interfaces.length; i++) {
							this.interfaces[interfaces[i].Name] = interfaces[i].IID;
						}
					}
					if (parsed.smarterHome.IBackup !== undefined) {
						var xmlconfiguration = Buffer.from(parsed.smarterHome.IBackup.GetFile.return.File, 'base64').toString("ascii"); // Ta-da
						fs.writeFileSync("/tmp/vantage.dc", xmlconfiguration); /* TODO: create a platform-independent temp file */
						this.emit("endDownloadConfiguration", xmlconfiguration);
						configuration.destroy();
					}
				}
				else if (parsed.IConfiguration != undefined) {
					if (parsed.IConfiguration.OpenFilter != undefined) {
						if (!buffer.includes("<?Master " + controller.toString() + "?>")) {
							if (controller == 1) {
								var tmpStr = buffer.slice(9);
								var res = tmpStr.split("?");
								controller = parseInt(res[0])
							}
							else
								shouldbreak = true
						}
						var objectValue = parsed.IConfiguration.OpenFilter.return
						if (objectDict[objectValue] == undefined && !shouldbreak) {
							buffer = ""
							objectDict[objectValue] = objectValue
							writeCount++
							configuration.write("<IConfiguration><GetFilterResults><call><Count>1000</Count><WholeObject>true</WholeObject><hFilter>" + objectValue + "</hFilter></call></GetFilterResults></IConfiguration>\n")
						}

					}
					else if (parsed.IConfiguration.GetFilterResults != undefined) {
						var elements = parsed.IConfiguration.GetFilterResults.return.Object
						if (elements != undefined && !shouldbreak) {
							if (elements.length == undefined) {
								var element = elements[objecTypes[writeCount - 1]]
								element["ObjectType"] = objecTypes[writeCount - 1]
								var elemDict = {};
								elemDict[objecTypes[writeCount - 1]] = element
								readObjects.push(elemDict)
							}
							else {
								for (var i = 0; i < elements.length; i++) {
									var element = elements[i][objecTypes[writeCount - 1]]
									element["ObjectType"] = objecTypes[writeCount - 1]
									var elemDict = {};
									elemDict[objecTypes[writeCount - 1]] = element
									readObjects.push(elemDict)
								}
							}
						}

						buffer = ""
						if (writeCount >= objecTypes.length) {
							controller++
							writeCount = 0
						}
						configuration.write("<?Master " + controller.toString() + "?><IConfiguration><OpenFilter><call><Objects><ObjectType>" + objecTypes[writeCount] + "</ObjectType></Objects></call></OpenFilter></IConfiguration>\n")
					}
					if (shouldbreak) {
						var result = {}
						result["Project"] = {}
						result["Project"]["Objects"] = {}
						result["Project"]["Objects"]["Object"] = readObjects
						var options = { sanitize: true };
						result = parser.toXml(result, options)
						fs.writeFileSync("/tmp/vantage.dc", result); /* TODO: create a platform-independent temp file */
						this.emit("endDownloadConfiguration", result);
						configuration.destroy();
					}
				}
				else if (parsed.ILogin != undefined) {
					if (parsed.ILogin.Login != undefined) {
						if (parsed.ILogin.Login.return == "true") {
							console.log("Login successful")
						}
						else {
							console.log("Login failed trying to get data anyways")
						}
						buffer = ""
						if (useBackup)
							configuration.write("<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n");
						else
							configuration.write("<?Master " + controller.toString() + "?><IConfiguration><OpenFilter><call><Objects><ObjectType>" + objecTypes[0] + "</ObjectType></Objects></call></OpenFilter></IConfiguration>\n")
					}
				}
				buffer = "";
			});

			/* Aehm, async method becomes sync... */
			//configuration.write("<IIntrospection><GetInterfaces><call></call></GetInterfaces></IIntrospection>\n");

			if (fs.existsSync('/tmp/vantage.dc') && this.usecache) {
				fs.readFile('/tmp/vantage.dc', 'utf8', function (err, data) {
					if (!err) {
						this.emit("endDownloadConfiguration", data);
					}
				}.bind(this));
			} else if (fs.existsSync('/home/pi/vantage.dc') && this.usecache) {
				fs.readFile('/home/pi/vantage.dc', 'utf8', function (err, data) {
					if (!err) {
						this.emit("endDownloadConfiguration", data);
					}
				}.bind(this));
			} else {
				if (this.username != "" && this.password != "") {
					configuration.write("<ILogin><Login><call><User>" + this.username + "</User><Password>" + this.password + "</Password></call></Login></ILogin>\n")
				}
				else {
					if (useBackup)
						configuration.write("<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n");
					else
						configuration.write("<?Master " + controller.toString() + "?><IConfiguration><OpenFilter><call><Objects><ObjectType>" + objecTypes[0] + "</ObjectType></Objects></call></OpenFilter></IConfiguration>\n")
				}
			}
		});
	}

	DiscoverSSL() {
		const options = {
			rejectUnauthorized: false,
			requestCert: true
		};
		var self = this
		var configuration = tls.connect(2010, this.ipaddress, options, function () {
			/**
			 * List interfaces, list configuration and then check if a specific interface 
			 * is supported by the recognized devices. 
			 */
			console.log("load dc file")

			var buffer = "";
			var xmlResult = ""
			var readObjects = []
			var writeCount = 0
			var objectDict = {}
			var controller = 1;
			var shouldbreak = false
			configuration.on('data', (data) => {
				buffer = buffer + data.toString().replace("\ufeff", "");

				try {
					if (useBackup) {
						buffer = buffer.replace('<?File Encode="Base64" /', '<File>');
						buffer = buffer.replace('?>', '</File>');

						if (buffer.includes("</File>")) {
							console.log("end");
							var start = buffer.split("<File>")
							var end = buffer.split("</File>")

							buffer = buffer.match("<File>" + "(.*?)" + "</File>");
							buffer = buffer[1]
							var newtext = new Buffer(buffer, 'base64');
							newtext = newtext.toString()
							newtext = newtext.replace(/[\r\n]/g, '');
							var init = newtext.split("<Objects>")
							newtext = newtext.match("<Objects>" + "(.*?)" + "</Objects>");
							if (newtext == null) {
								console.log("null");
							}
							xmlResult = new Buffer(init[0] + "<Objects>" + newtext[1] + "</Objects></Project>");
							xmlResult = xmlResult.toString('base64');
							buffer = "<smarterHome>" + start[0] + "<File>" + xmlResult + "</File>" + end[end.length - 1] + "</smarterHome>"
						}
					}
					libxmljs.parseXml(buffer);
				} catch (e) {
					return false;
				}
				if (writeCount < objecTypes.length)
					console.log("parse Json: " + objecTypes[writeCount] + " on controller: " + controller.toString())
				var parsed = JSON.parse(parser.toJson(buffer));
				if (parsed.smarterHome !== undefined) {
					if (parsed.smarterHome.IIntrospection !== undefined) {
						var interfaces = parsed.smarterHome.IIntrospection.GetInterfaces.return.Interface;
						for (var i = 0; i < interfaces.length; i++) {
							self.interfaces[interfaces[i].Name] = interfaces[i].IID;
						}
					}
					if (parsed.smarterHome.IBackup !== undefined) {
						var xmlconfiguration = Buffer.from(parsed.smarterHome.IBackup.GetFile.return.File, 'base64').toString("ascii"); // Ta-da
						fs.writeFileSync("/tmp/vantage.dc", xmlconfiguration); /* TODO: create a platform-independent temp file */
						self.emit("endDownloadConfiguration", xmlconfiguration);
						configuration.destroy();
					}
				}
				else if (parsed.IConfiguration != undefined) {
					if (parsed.IConfiguration.OpenFilter != undefined) {
						if (!buffer.includes("<?Master " + controller.toString() + "?>")) {
							if (controller == 1) {
								var tmpStr = buffer.slice(9);
								var res = tmpStr.split("?");
								controller = parseInt(res[0])
							}
							else
								shouldbreak = true
						}
						var objectValue = parsed.IConfiguration.OpenFilter.return
						if (objectDict[objectValue] == undefined && !shouldbreak) {
							buffer = ""
							objectDict[objectValue] = objectValue
							writeCount++
							configuration.write("<IConfiguration><GetFilterResults><call><Count>1000</Count><WholeObject>true</WholeObject><hFilter>" + objectValue + "</hFilter></call></GetFilterResults></IConfiguration>\n")
						}

					}
					else if (parsed.IConfiguration.GetFilterResults != undefined) {
						var elements = parsed.IConfiguration.GetFilterResults.return.Object
						if (elements != undefined && !shouldbreak) {
							if (elements.length == undefined) {
								var element = elements[objecTypes[writeCount - 1]]
								element["ObjectType"] = objecTypes[writeCount - 1]
								var elemDict = {};
								elemDict[objecTypes[writeCount - 1]] = element
								readObjects.push(elemDict)
							}
							else {
								for (var i = 0; i < elements.length; i++) {
									var element = elements[i][objecTypes[writeCount - 1]]
									element["ObjectType"] = objecTypes[writeCount - 1]
									var elemDict = {};
									elemDict[objecTypes[writeCount - 1]] = element
									readObjects.push(elemDict)
								}
							}
						}

						buffer = ""
						if (writeCount >= objecTypes.length) {
							controller++
							writeCount = 0
						}
						configuration.write("<?Master " + controller.toString() + "?><IConfiguration><OpenFilter><call><Objects><ObjectType>" + objecTypes[writeCount] + "</ObjectType></Objects></call></OpenFilter></IConfiguration>\n")
					}
					if (shouldbreak) {
						var result = {}
						result["Project"] = {}
						result["Project"]["Objects"] = {}
						result["Project"]["Objects"]["Object"] = readObjects
						var options = { sanitize: true };
						result = parser.toXml(result, options)
						fs.writeFileSync("/tmp/vantage.dc", result); /* TODO: create a platform-independent temp file */
						self.emit("endDownloadConfiguration", result);
						configuration.destroy();
					}
				}
				else if (parsed.ILogin != undefined) {
					if (parsed.ILogin.Login != undefined) {
						if (parsed.ILogin.Login.return == "true") {
							console.log("Login successful")
						}
						else {
							console.log("Login failed trying to get data anyways")
						}
						buffer = ""
						if (useBackup)
							configuration.write("<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n");
						else
							configuration.write("<?Master " + controller.toString() + "?><IConfiguration><OpenFilter><call><Objects><ObjectType>" + objecTypes[0] + "</ObjectType></Objects></call></OpenFilter></IConfiguration>\n")
					}
				}
				buffer = "";
			});

			/* Aehm, async method becomes sync... */
			//configuration.write("<IIntrospection><GetInterfaces><call></call></GetInterfaces></IIntrospection>\n");

			if (fs.existsSync('/tmp/vantage.dc') && self.usecache) {
				fs.readFile('/tmp/vantage.dc', 'utf8', function (err, data) {
					if (!err) {
						self.emit("endDownloadConfiguration", data);
					}
				}.bind(self));
			} else if (fs.existsSync('/home/pi/vantage.dc') && self.usecache) {
				fs.readFile('/home/pi/vantage.dc', 'utf8', function (err, data) {
					if (!err) {
						self.emit("endDownloadConfiguration", data);
					}
				}.bind(self));
			} else {
				if (self.username != "" && self.password != "") {
					configuration.write("<ILogin><Login><call><User>" + self.username + "</User><Password>" + self.password + "</Password></call></Login></ILogin>\n")
				}
				else {
					if (useBackup)
						configuration.write("<IBackup><GetFile><call>Backup\\Project.dc</call></GetFile></IBackup>\n");
					else
						configuration.write("<?Master " + controller.toString() + "?><IConfiguration><OpenFilter><call><Objects><ObjectType>" + objecTypes[0] + "</ObjectType></Objects></call></OpenFilter></IConfiguration>\n")
				}
			}
		});
	}

	/**
	 * Send the set HSL color request to the controller 
	 */
	RGBLoad_DissolveHSL(vid, h, s, l) {
		this.command.write(sprintf("INVOKE %s RGBLoad.SetHSL %s %s %s %s\n", vid, h, s, l))
	}

	Thermostat_GetOutdoorTemperature(vid) {
		this.command.write(sprintf("INVOKE %s Thermostat.GetOutdoorTemperature\n", vid))
	}

	Thermostat_GetIndoorTemperature(vid) {
		this.command.write(sprintf("INVOKE %s Thermostat.GetIndoorTemperature\n", vid))
	}

	Thermostat_SetTargetState(vid, mode) {
		if (mode == 0)
			this.command.write(sprintf("THERMOP %s OFF\n", vid))
		else if (mode == 1)
			this.command.write(sprintf("THERMOP %s HEAT\n", vid))
		else if (mode == 2)
			this.command.write(sprintf("THERMOP %s COOL\n", vid))
		else
			this.command.write(sprintf("THERMOP %s AUTO\n", vid))
	}

	Thermostat_GetState(vid) {
		this.command.write(sprintf("GETTHERMOP %s\n", vid))
	}

	Thermostat_GetHeating(vid) {
		this.command.write(sprintf("GETTHERMTEMP %s HEAT\n", vid))
	}

	Thermostat_GetCooling(vid) {
		this.command.write(sprintf("GETTHERMTEMP %s COOL\n", vid))
	}

	Thermostat_SetIndoorTemperature(vid, value, mode, heating, cooling) {
		// console.log(mode)
		if (mode == 1)
			this.command.write(sprintf("THERMTEMP %s HEAT %s\n", vid, value))
		else if (mode == 2)
			this.command.write(sprintf("THERMTEMP %s COOL %s\n", vid, value))
		else if (mode == 3) {
			if (value > cooling) {
				this.command.write(sprintf("THERMTEMP %s COOL %s\n", vid, value))
			}
			else if (value < heating) {
				this.command.write(sprintf("THERMTEMP %s HEAT %s\n", vid, value))
			}
		}
	}

	/**
	 * Send the set light level to the controller
	 */
	Load_Dim(vid, level, time) {
		// TODO: reduce feedback (or command) rate
		var thisTime = time || 1;
		this.command.write(sprintf("INVOKE %s Load.Ramp 6 %s %s\n", vid, thisTime, level));
	}

	/** blind commands*/
	setBlindPos(vid, pos) {
		// TODO: reduce feedback (or command) rate
		this.command.write(sprintf("BLIND %s POS %s\n", vid, pos));
	}
	getBlindPos(vid) {
		// TODO: reduce feedback (or command) rate
		this.command.write(sprintf("GETBLIND %s \n", vid));
	}

	/** relay commands*/
	setRelay(vid, level) {
		// TODO: reduce feedback (or command) rate
		this.command.write(sprintf("LOAD %s %s\n", vid, level));
	}

}

function convertToIP(ipaddress) {
	var result = ""
	var vals = ipaddress.split(".")
	for (var i = 0; i < vals.length; i++) {
		result += parseInt(vals[i]).toString()
		if (i < 3)
			result += "."
	}
	return result
}

class VantagePlatform {

	constructor(log, config, api) {
		this.log = log;
		this.config = config || {};
		this.api = api;
		this.ipaddress = convertToIP(config.ipaddress)
		this.lastDiscovery = null;
		this.items = [];
		if (config.usecache == undefined)
			this.usecache = true
		else
			this.usecache = config.usecache
		if (config.omit == undefined)
			this.omit = ""
		else
			this.omit = config.omit
		if (config.range == undefined)
			this.range = ""
		else
			this.range = config.range
		if (config.username == undefined)
			this.username = ""
		else
			this.username = config.username
		if (config.password == undefined)
			this.password = ""
		else
			this.password = config.password
		portIsUsable(3001, this.ipaddress, "STATUS ALL\n", function (return3001Value) { //default to insecure port: 3001 true, 3010 false
			if (return3001Value)
				console.log("Using insecure port: 3001");
			else
				console.log("Using SSL port: 3010");

			portIsUsable(2001, this.ipaddress, "<IIntrospection><GetInterfaces><call></call></GetInterfaces></IIntrospection>\n", function (return2001Value) {
				if (return2001Value)
					console.log("Using insecure port: 2001");
				else
					console.log("Using SSL port: 2010");
				this.initialize(return3001Value, return2001Value)
			}.bind(this));
		}.bind(this));
		this.pendingrequests = 0;
		this.ready = false;
		this.callbackPromesedAccessories = undefined;
		this.getAccessoryCallback = null;
	}

	initialize(is3001Insecure, is2001Insecure) {
		this.infusion = new VantageInfusion(this.ipaddress, this.items, this.usecache, this.omit, this.range, this.username, this.password, is3001Insecure);
		if (is2001Insecure && !useSecure)
			this.infusion.Discover();
		else
			this.infusion.DiscoverSSL();

		this.log.info("VantagePlatform for InFusion Controller at " + this.ipaddress);

		this.infusion.on('loadStatusChange', (vid, value, command) => {
			this.items.forEach(function (accessory) {
				if (accessory.address == vid) {
					if (accessory.type == "relay") {
						this.log(sprintf("relayStatusChange (VID=%s, Name=%s, Val:%d)", vid, accessory.name, value));
						accessory.bri = parseInt(value);
						accessory.power = ((accessory.bri) > 0);
						//console.log(accessory);
						if (accessory.switchService !== undefined) {
							/* Is it ready? */
							accessory.switchService.getCharacteristic(Characteristic.On).getValue(null, accessory.power);
						}
					}
					else if (accessory.type == "rgb" && command != undefined) {
						this.log(sprintf("rgbStatusChange (VID=%s, Name=%s, Val:%d, HSL:%d)", vid, accessory.name, value, command));
						if (command == 0)
							accessory.hue = parseInt(value)
						if (command == 1)
							accessory.sat = parseInt(value)
						if (command == 2)
							accessory.bri = parseInt(value)
						this.log(sprintf("rgbStatusChange (VID=%s, Name=%s, Val:%d, HSL:%d, H:%d, S:%d, L:%d)", vid, accessory.name, value, command, accessory.hue, accessory.sat, accessory.bri));
						if (accessory.switchService !== undefined) {
							/* Is it ready? */
							accessory.lightBulbService.getCharacteristic(Characteristic.Brightness).getValue(null, accessory.bri);
							accessory.lightBulbService.getCharacteristic(Characteristic.Saturation).getValue(null, accessory.sat);
							accessory.lightBulbService.getCharacteristic(Characteristic.Hue).getValue(null, accessory.hue);
						}
					}
					else {
						this.log(sprintf("loadStatusChange (VID=%s, Name=%s, Bri:%d)", vid, accessory.name, value));
						accessory.bri = parseInt(value);
						accessory.power = ((accessory.bri) > 0);
						if (accessory.type == "rgb") {
							this.log(sprintf("rgbStatusChange (VID=%s, Name=%s, H:%d, S:%d, L:%d)", vid, accessory.name, accessory.hue, accessory.sat, accessory.bri));
						}
						if (accessory.lightBulbService !== undefined) {
							/* Is it ready? */
							accessory.lightBulbService.getCharacteristic(Characteristic.On).getValue(null, accessory.power);
							if (accessory.type == "rgb" || accessory.type == "dimmer") {
								accessory.lightBulbService.getCharacteristic(Characteristic.Brightness).getValue(null, accessory.bri);
							}
						}
					}
				}
			}.bind(this));
		});

		this.infusion.on('blindStatusChange', (vid, value) => {
			this.items.forEach(function (accessory) {
				if (accessory.address == vid) {
					this.log(sprintf("blindStatusChange (VID=%s, Name=%s, Pos:%d)", vid, accessory.name, value));
					accessory.pos = parseInt(value);
					if (accessory.blindService !== undefined) {
						/* Is it ready? */
						accessory.blindService.getCharacteristic(Characteristic.CurrentPosition).getValue(null, accessory.pos);
					}
				}
			}.bind(this));
		});

		// this.infusion.on('thermostatOutdoorTemperatureChange', (vid, value) => {
		// 	this.items.forEach(function (accessory) {
		// 		if (accessory.address == vid) {
		// 			accessory.temperature = parseFloat(value);
		// 			if (accessory.thermostatService !== undefined) {
		// 				/* Is it ready? */
		// 				accessory.thermostatService.getCharacteristic(Characteristic.CurrentTemperature).getValue(null, accessory.temperature);
		// 			}
		// 		}
		// 	}.bind(this));
		// });

		this.infusion.on('thermostatIndoorModeChange', (vid, mode, targetTemp) => {
			this.items.forEach(function (accessory) {
				//console.log(accessory)
				if (accessory.address == vid) {
					//console.log(accessory)
					if (accessory.thermostatService !== undefined) {
						/* Is it ready? */
						//console.log(accessory.thermostatService);
						if (targetTemp == -1) {
							accessory.current = 0
							if (accessory.temperature <= accessory.heating && mode == 1)
								accessory.current = 1
							else if (accessory.temperature >= accessory.cooling && mode == 2)
								accessory.current = 2
							else if (mode == 3) {
								if (accessory.temperature <= accessory.heating)
									accessory.current = 1
								else if (accessory.temperature >= accessory.cooling)
									accessory.current = 2
							}
							// console.log("mode: " + mode + " currstate: " + accessory.current + " heat: " + accessory.heating + " cool: " + accessory.cooling)
							accessory.mode = mode;
							accessory.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).getValue(null, accessory.current);
							accessory.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).getValue(null, accessory.mode);

						}
						else {
							accessory.targetTemp = Math.min(38, targetTemp)
							if (mode == 1) {
								accessory.heating = Math.min(30, targetTemp)
								accessory.thermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).getValue(null, accessory.heating);
							}
							else if (mode == 2) {
								accessory.cooling = Math.min(35, targetTemp)
								accessory.thermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).getValue(null, accessory.cooling);
							}
							if (accessory.mode == 1)
								accessory.targetTemp = accessory.heating
							else if (accessory.mode == 2)
								accessory.targetTemp = accessory.cooling
							else if (accessory.mode == 3)
								accessory.targetTemp = (accessory.temperature <= accessory.heating) ? accessory.heating : accessory.cooling
							accessory.thermostatService.getCharacteristic(Characteristic.TargetTemperature).getValue(null, accessory.targetTemp);
						}
					}
				}
			}.bind(this));
		});

		this.infusion.on('thermostatDidChange', (value) => {
			this.items.forEach(function (accessory) {
				if (accessory.type == "thermostat") {
					if (accessory.thermostatService !== undefined) {
						this.infusion.Thermostat_GetIndoorTemperature(accessory.address);
						this.infusion.Thermostat_GetState(accessory.address);
						this.infusion.Thermostat_GetHeating(accessory.address);
						this.infusion.Thermostat_GetCooling(accessory.address);
						this.infusion.Thermostat_GetState(accessory.address);
					}
				}
			}.bind(this));
		});

		this.infusion.on('thermostatIndoorTemperatureChange', (vid, value) => {
			this.items.forEach(function (accessory) {
				//console.log(accessory)
				if (accessory.address == vid) {
					accessory.temperature = parseFloat(value);
					if (accessory.temperature > 100) {
						accessory.temperature = 100
						console.log("this accessory: " + vid + " is most likely not working. You should omit this device")
					}
					//console.log(accessory)
					if (accessory.thermostatService !== undefined) {
						/* Is it ready? */
						//console.log(accessory.thermostatService);
						accessory.thermostatService.getCharacteristic(Characteristic.CurrentTemperature).getValue(null, accessory.temperature);
					}
				}
			}.bind(this));
		});

		this.infusion.on('endDownloadConfiguration', (configuration) => {
			this.log.debug("VantagePlatform for InFusion Controller (end configuration download)");
			var parsed = JSON.parse(parser.toJson(configuration));
			//this.log("input=    %s",configuration);
			var dict = {};
			var Areas = parsed.Project.Objects.Object.filter(function (el) {
				var key = Object.keys(el)[0]
				return key == "Area"
			});
			var Area = {};
			for (var i = 0; i < Areas.length; i++) {
				var item = Areas[i].Area
				Area[item.VID] = item
			}
			var blindItems = {};
			var range = this.range
			var omit = this.omit
			if (range != "") {
				range = range.replace(' ', '');
				range = range.split(",")
				if (range.length != 2)
					range = ["0", "999999999"]
			}
			else
				range = ["0", "999999999"]
			if (omit != "") {
				omit = omit.replace(' ', '');
				omit = omit.split(",")
			}

			for (var i = 0; i < parsed.Project.Objects.Object.length; i++) {
				var thisItemKey = Object.keys(parsed.Project.Objects.Object[i])[0];
				var thisItem = parsed.Project.Objects.Object[i][thisItemKey];
				if (!omit.includes(thisItem.VID) && (parseInt(thisItem.VID) >= parseInt(range[0])) && (parseInt(thisItem.VID) <= parseInt(range[1])) &&
					(objecTypes.includes(thisItem.ObjectType))) {
					if (thisItem.DeviceCategory == "HVAC" || typeThermo.includes(thisItem.ObjectType)) {
						if (thisItem.DName !== undefined && thisItem.DName != "" && (typeof thisItem.DName === 'string')) thisItem.Name = thisItem.DName;
						this.pendingrequests = this.pendingrequests + 1;
						this.log(sprintf("New HVAC added (VID=%s, Name=%s, Thermostat)", thisItem.VID, thisItem.Name));
						//added
						var name = thisItem.Name
						name = name.toString()
						if (thisItem.Area !== undefined && thisItem.Area != "") {
							var areaVID = thisItem.Area
							if (Area[areaVID] !== undefined && Area[areaVID].Name !== undefined && Area[areaVID].Name != "")
								name = Area[areaVID].Name + " " + name
						}

						name = name.replace('-', '');
						if (dict[name.toLowerCase()] === undefined && name != "")
							dict[name.toLowerCase()] = name
						else {
							name = name + " VID" + thisItem.VID
							dict[name.toLowerCase()] = name
						}
						this.items.push(new VantageThermostat(this.log, this, name, thisItem.VID, "thermostat"));
						this.pendingrequests = this.pendingrequests - 1;
						this.callbackPromesedAccessoriesDo();
					}
					if (thisItem.ObjectType == "Load" || thisItem.ObjectType == "Vantage.DDGColorLoad" || thisItem.ObjectType == "Jandy.Aqualink_RS_Auxiliary_CHILD" || thisItem.ObjectType == "Jandy.Aqualink_RS_Pump_CHILD" || thisItem.ObjectType == "Legrand.MH_Relay_CHILD" || thisItem.ObjectType == "Legrand.MH_Dimmer_CHILD") {

						//this.log.warn(sprintf("New light asked (VID=%s, Name=%s, ---)", thisItem.VID, thisItem.Name));
						if (thisItem.DName !== undefined && thisItem.DName != "" && (typeof thisItem.DName === 'string')) thisItem.Name = thisItem.DName;
						this.pendingrequests = this.pendingrequests + 1;
						//this.log(sprintf("New load asked (VID=%s, Name=%s, ---)", thisItem.VID, thisItem.Name));
						//added below
						var name = thisItem.Name
						name = name.toString()
						if (thisItem.Area !== undefined && thisItem.Area != "") {
							var areaVID = thisItem.Area
							if (Area[areaVID] !== undefined && Area[areaVID].Name !== undefined && Area[areaVID].Name != "")
								name = Area[areaVID].Name + " " + name
						}
						// if (thisItem.LoadType == "Low Voltage Relay" || thisItem.LoadType == "High Voltage Relay")
						// 	name = name + " RELAY"
						name = name.replace('-', '');
						if (dict[name.toLowerCase()] === undefined && name != "")
							dict[name.toLowerCase()] = name
						else {
							name = name + " VID" + thisItem.VID
							dict[name.toLowerCase()] = name
						}
						if (thisItem.ObjectType == "Jandy.Aqualink_RS_Pump_CHILD" || thisItem.ObjectType == "Jandy.Aqualink_RS_Auxiliary_CHILD" || thisItem.LoadType == "Fluor. Mag non-Dim" || thisItem.LoadType == "LED non-Dim" || thisItem.LoadType == "Fluor. Electronic non-Dim" || thisItem.LoadType == "Low Voltage Relay" || thisItem.LoadType == "Motor" || thisItem.LoadType == "High Voltage Relay" || thisItem.ObjectType == "Legrand.MH_Relay_CHILD") {
							if (thisItem.ObjectType == "Jandy.Aqualink_RS_Pump_CHILD" || thisItem.ObjectType == "Jandy.Aqualink_RS_Auxiliary_CHILD" || thisItem.LoadType == "Low Voltage Relay" || thisItem.LoadType == "High Voltage Relay") {
								this.log(sprintf("New relay added (VID=%s, Name=%s, RELAY)", thisItem.VID, thisItem.Name));
								this.items.push(new VantageSwitch(this.log, this, name, thisItem.VID, "relay"));
							}
							else {
								this.log(sprintf("New load added (VID=%s, Name=%s, NON-DIMMER)", thisItem.VID, thisItem.Name));
								this.items.push(new VantageLoad(this.log, this, name, thisItem.VID, "non-dimmer"));
							}
						}
						else {
							if (thisItem.ObjectType == "Vantage.DDGColorLoad") {
								this.log(sprintf("New load added (VID=%s, Name=%s, RGB)", thisItem.VID, thisItem.Name));
								this.items.push(new VantageLoad(this.log, this, name, thisItem.VID, "rgb"));
							}
							else {
								this.log(sprintf("New load added (VID=%s, Name=%s, DIMMER)", thisItem.VID, thisItem.Name));
								this.items.push(new VantageLoad(this.log, this, name, thisItem.VID, "dimmer"));
							}
						}
						this.pendingrequests = this.pendingrequests - 1;
						this.callbackPromesedAccessoriesDo();
					}
					if (typeBlind.includes(thisItem.ObjectType)) {
						//this.log.warn(sprintf("New light asked (VID=%s, Name=%s, ---)", thisItem.VID, thisItem.Name));
						if (thisItem.DName !== undefined && thisItem.DName != "" && (typeof thisItem.DName === 'string')) thisItem.Name = thisItem.DName;
						this.pendingrequests = this.pendingrequests + 1;
						//added below
						var name = thisItem.Name
						name = name.toString()
						if (thisItem.Area !== undefined && thisItem.Area != "") {
							var areaVID = thisItem.Area
							if (Area[areaVID] !== undefined && Area[areaVID].Name !== undefined && Area[areaVID].Name != "")
								name = Area[areaVID].Name + " " + name
						}
						name = name.replace('-', '');
						if (dict[name.toLowerCase()] === undefined && name != "")
							dict[name.toLowerCase()] = name
						else {
							name = name + " VID" + thisItem.VID
							dict[name.toLowerCase()] = name
						}
						if (thisItem.ObjectType == "RelayBlind") {
							blindItems[thisItem.OpenLoad] = thisItem.OpenLoad
							blindItems[thisItem.CloseLoad] = thisItem.CloseLoad
							// if (thisItem.PowerLoad != "0")
							// 	blindItems[thisItem.PowerLoad] = thisItem.PowerLoad
						}
						// var name = "VID" + thisItem.VID + " " + thisItem.Name
						this.log(sprintf("New Blind added (VID=%s, Name=%s, BLIND)", thisItem.VID, thisItem.Name));
						this.items.push(new VantageBlind(this.log, this, name, thisItem.VID, "blind"));
						this.pendingrequests = this.pendingrequests - 1;
						this.callbackPromesedAccessoriesDo();
					}
				}
			}
			for (var i = 0; i < this.items.length; i++) {
				if (blindItems[this.items[i].address]) {
					this.items.splice(i, 1);
					i--;
				}
			}
			this.log(sprintf("Found %f devices", this.items.length))
			if (this.items.length >= 150) {
				this.log(sprintf("Number of devices exceeds Apples limit of 149. Only loading first 149 devices. Please omit some loads"))
				this.items.splice(149)
			}
			this.log.warn("VantagePlatform for InFusion Controller (end configuration store)");
			this.ready = true;
			this.callbackPromesedAccessoriesDo();
		});
	}

	/**
	 * Called once, returns the list of accessories only
	 * when the list is complete
	 */
	callbackPromesedAccessoriesDo() {
		if (this.callbackPromesedAccessories !== undefined && this.ready && this.pendingrequests == 0) {
			this.log.warn("VantagePlatform for InFusion Controller (is open for business)");
			//console.log(this.items)
			this.callbackPromesedAccessories(this.items);
		} else {
			this.log.debug(sprintf("VantagePlatform for InFusion Controller (%s,%s)", this.ready, this.pendingrequests));
		}
	}

	getDevices() {
		return new Promise((resolve, reject) => {
			if (!this.ready) {
				this.log.debug("VantagePlatform for InFusion Controller (wait for getDevices promise)");
				this.callbackPromesedAccessories = resolve;
			} else {
				resolve(this.items);
			}
		});
	}

	/* Get accessory list */
	accessories(callback) {
		this.getDevices().then((devices) => {
			this.log.debug("VantagePlatform for InFusion Controller (accessories readed)");
			callback(devices);
		});
	}
}

class VantageThermostat {
	constructor(log, parent, name, vid, type) {
		this.DisplayName = name;
		this.name = name;
		this.UUID = UUIDGen.generate(vid);
		this.parent = parent;
		this.address = vid;
		this.log = log;
		this.temperature = 0;
		this.targetTemp = 0;
		this.type = type;
		this.heating = 0;
		this.cooling = 0;
		this.mode = 0;  //0=off, 1=heat, 2=cool, 3=auto
		this.current = 0; //0=off, 1=heat, 2=cool
		this.units = 1;  //0=celcius, 1=f
	}


	getServices() {
		var service = new Service.AccessoryInformation();
		service.setCharacteristic(Characteristic.Name, this.name)
			.setCharacteristic(Characteristic.Manufacturer, "Vantage Controls")
			.setCharacteristic(Characteristic.Model, "Thermostat")
			.setCharacteristic(Characteristic.SerialNumber, "VID " + this.address);

		this.thermostatService = new Service.Thermostat(this.name);
		this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
			.on('get', (callback) => {
				this.log.debug(sprintf("getTemperature %s = %.1f", this.address, this.temperature));
				callback(null, this.temperature);
			});


		this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
			.on('get', (callback) => {
				this.log.debug(sprintf("getCurrentState %s = %f", this.address, this.current));
				callback(null, this.current);
			});

		this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
			.on('set', (mode, callback) => {
				this.mode = mode
				if (mode == 1)
					this.targetTemp = this.heating
				else if (mode == 2)
					this.targetTemp = this.cooling
				else if (mode == 3)
					this.targetTemp = (this.temperature <= this.heating) ? this.heating : this.cooling
				this.log(sprintf("setTargetHeatingCoolingState %s = %s", this.address, mode));
				this.parent.infusion.Thermostat_SetTargetState(this.address, this.mode)
				callback(null);
			})
			.on('get', (callback) => {
				this.log.debug(sprintf("TargetHeatingCoolingState %s = %f", this.address, this.mode));
				callback(null, this.mode);
			});

		this.thermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature)
			.on('get', (callback) => {
				this.log.debug(sprintf("HeatingThresholdTemperature %s = %f", this.address, this.heating));
				callback(null, this.heating);
			});

		this.thermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature)
			.on('get', (callback) => {
				this.log.debug(sprintf("CoolingThresholdTemperature %s = %f", this.address, this.cooling));
				callback(null, this.cooling);
			});

		this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
			.on('set', (level, callback) => {
				this.targetTemp = parseFloat(level)
				if (this.mode == 0) {
					if (this.targetTemp > this.temperature)
						this.mode = 1
					else if (this.targetTemp < this.temperature)
						this.mode = 2
					this.current = this.mode
				}
				if (this.mode == 1) {
					this.heating = parseFloat(level)
				}
				else if (this.mode == 2) {
					this.cooling = parseFloat(level)
				}
				this.log(sprintf("setTemperature %s = %s and current mode = %f", this.address, level, this.mode));
				this.parent.infusion.Thermostat_SetIndoorTemperature(this.address, this.targetTemp, this.mode, this.heating, this.cooling)
				callback(null);
			})

			.on('get', (callback) => {
				this.log.debug(sprintf("getTargetTemperature %s = %.1f", this.address, this.targetTemp));
				callback(null, this.targetTemp);
			});

		this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
			.on('set', (units, callback) => {
				this.units = parseInt(units)
				this.log.debug(sprintf("getThermoUnit %s = %s", this.address, units));
				callback(null);
			})

			.on('get', (callback) => {
				this.log.debug(sprintf("getThermoUnits %s = %f", this.address, this.units));
				callback(null, this.units);
			});



		this.parent.infusion.Thermostat_GetIndoorTemperature(this.address);
		this.parent.infusion.Thermostat_GetState(this.address);
		this.parent.infusion.Thermostat_GetHeating(this.address);
		this.parent.infusion.Thermostat_GetCooling(this.address);
		this.parent.infusion.Thermostat_GetState(this.address);
		//console.log(service);console.log(this.thermostatService);
		return [service, this.thermostatService];
	}

}

class VantageLoad {
	constructor(log, parent, name, vid, type) {
		this.displayName = name;
		this.UUID = UUIDGen.generate(vid);
		this.name = name;
		this.parent = parent;
		this.address = vid;
		this.log = log;
		this.bri = 100;
		this.power = false;
		this.sat = 0;
		this.hue = 0;
		this.type = type;
	}

	getServices() {
		var service = new Service.AccessoryInformation();
		service.setCharacteristic(Characteristic.Name, this.name)
			.setCharacteristic(Characteristic.Manufacturer, "Vantage Controls")
			.setCharacteristic(Characteristic.Model, "Power Switch")
			.setCharacteristic(Characteristic.SerialNumber, "VID " + this.address);

		this.lightBulbService = new Service.Lightbulb(this.name);

		//console.log(this.lightBulbService); //here
		this.lightBulbService.getCharacteristic(Characteristic.On)
			.on('set', (level, callback) => {
				this.log.debug(sprintf("setPower %s = %s", this.address, level));
				this.power = (level > 0);
				if (this.power && this.bri == 0) {
					this.bri = 100;
				}
				this.parent.infusion.Load_Dim(this.address, this.power * this.bri);
				callback(null);
			})
			.on('get', (callback) => {
				this.log.debug(sprintf("getPower %s = %s", this.address, this.power));
				callback(null, this.power);
			});

		if (this.type == "dimmer" || this.type == "rgb") {
			this.lightBulbService.getCharacteristic(Characteristic.Brightness)
				.on('set', (level, callback) => {
					this.log.debug(sprintf("setBrightness %s = %d", this.address, level));
					this.bri = parseInt(level);
					this.power = (this.bri > 0);
					if (this.type == "rgb")
						this.parent.infusion.RGBLoad_DissolveHSL(this.address, this.hue, this.sat, this.power * this.bri)
					this.parent.infusion.Load_Dim(this.address, this.power * this.bri);
					callback(null);
				})
				.on('get', (callback) => {
					this.log.debug(sprintf("getBrightness %s = %d", this.address, this.bri));
					if (this.type == "rgb")
						this.log.debug(sprintf("getHSL %s = %d, %d, %d", this.address, this.hue, this.sat, this.bri));
					callback(null, this.bri);
				});
		}

		if (this.type == "rgb") {
			this.lightBulbService.getCharacteristic(Characteristic.Saturation)
				.on('set', (level, callback) => {
					this.power = true;
					this.sat = level;
					this.parent.infusion.RGBLoad_DissolveHSL(this.address, this.hue, this.sat, this.bri)
					callback(null);
				})
				.on('get', (callback) => {
					this.log.debug(sprintf("getHSL %s = %d, %d, %d", this.address, this.hue, this.sat, this.bri));
					callback(null, this.sat);
				});
			this.lightBulbService.getCharacteristic(Characteristic.Hue)
				.on('set', (level, callback) => {
					this.power = true;
					this.hue = level;
					this.parent.infusion.RGBLoad_DissolveHSL(this.address, this.hue, this.sat, this.bri)
					callback(null);
				})
				.on('get', (callback) => {
					this.log.debug(sprintf("getHSL %s = %d, %d, %d", this.address, this.hue, this.sat, this.bri));
					callback(null, this.hue);
				});
			this.parent.infusion.getLoadHSL(this.address, "hue");
			this.parent.infusion.getLoadHSL(this.address, "saturation");
			this.parent.infusion.getLoadHSL(this.address, "lightness");
		}

		this.parent.infusion.getLoadStatus(this.address);
		return [service, this.lightBulbService];
	}
}


class VantageBlind {
	constructor(log, parent, name, vid, type) {
		this.displayName = name;
		this.UUID = UUIDGen.generate(vid);
		this.name = name;
		this.parent = parent;
		this.address = vid;
		this.log = log;
		this.pos = 100;
		this.type = type;
		this.posState = 2; //decreasing=0, increasing=1, stopped=2
	}

	getServices() {
		var service = new Service.AccessoryInformation();
		service.setCharacteristic(Characteristic.Name, this.name)
			.setCharacteristic(Characteristic.Manufacturer, "Vantage Controls")
			.setCharacteristic(Characteristic.Model, "Blind")
			.setCharacteristic(Characteristic.SerialNumber, "VID " + this.address);

		this.blindService = new Service.WindowCovering(this.name);

		//console.log(this.lightBulbService); //here
		this.blindService.getCharacteristic(Characteristic.CurrentPosition)
			.on('get', (callback) => {
				this.log.debug(sprintf("getPos %s = %s", this.address, this.pos));
				callback(null, this.pos);
			});

		this.blindService.getCharacteristic(Characteristic.TargetPosition)
			.on('set', (pos, callback) => {
				this.log.debug(sprintf("setPos %s = %s", this.address, pos));
				this.pos = pos
				this.parent.infusion.setBlindPos(this.address, this.pos);
				callback(null);
			})
			.on('get', (callback) => {
				this.log.debug(sprintf("getTargetPos %s = %s", this.address, this.pos));
				callback(null, this.pos);
			});

		this.blindService.getCharacteristic(Characteristic.PositionState)
			.on('get', (callback) => {
				this.log.debug(sprintf("getBlindState %s = %s", this.address, this.posState));
				callback(null, this.posState);
			});


		this.parent.infusion.getBlindPos(this.address);
		return [service, this.blindService];
	}
}


class VantageSwitch {
	constructor(log, parent, name, vid, type) {
		this.displayName = name;
		this.UUID = UUIDGen.generate(vid);
		this.name = name;
		this.parent = parent;
		this.address = vid;
		this.log = log;
		this.type = type;
		this.bri = 100;
		this.power = false;
	}

	getServices() {
		var service = new Service.AccessoryInformation();
		service.setCharacteristic(Characteristic.Name, this.name)
			.setCharacteristic(Characteristic.Manufacturer, "Vantage Controls")
			.setCharacteristic(Characteristic.Model, "Switch")
			.setCharacteristic(Characteristic.SerialNumber, "VID " + this.address);

		this.switchService = new Service.Switch(this.name);

		//console.log(this.lightBulbService); //here
		this.switchService.getCharacteristic(Characteristic.On)
			.on('set', (level, callback) => {
				this.log.debug(sprintf("setPower %s = %s", this.address, level));
				this.power = (level > 0);
				if (this.power && this.bri == 0) {
					this.bri = 100;
				}
				this.parent.infusion.setRelay(this.address, this.power * this.bri);
				callback(null);
			})
			.on('get', (callback) => {
				this.log.debug(sprintf("getPower %s = %s", this.address, this.power));
				callback(null, this.power);
			});

		this.parent.infusion.getLoadStatus(this.address);
		return [service, this.switchService];
	}
}

//https://github.com/homebridge/HAP-NodeJS/blob/81652da554137d818d049f6f245e88efec43b1c5/src/lib/definitions/ServiceDefinitions.ts#L1438
class VantageSpeaker {
	constructor(log, parent, name, vid, type) {
		this.displayName = name;
		this.UUID = UUIDGen.generate(vid);
		this.name = name;
		this.parent = parent;
		this.address = vid;
		this.log = log;
		this.pos = 100;
		this.type = type;
		this.posState = 2; //decreasing=0, increasing=1, stopped=2
	}

	getServices() {
		var service = new Service.AccessoryInformation();
		service.setCharacteristic(Characteristic.Name, this.name)
			.setCharacteristic(Characteristic.Manufacturer, "Vantage Controls")
			.setCharacteristic(Characteristic.Model, "Speaker")
			.setCharacteristic(Characteristic.SerialNumber, "VID " + this.address);

		this.speakerService = new Service.SmartSpeaker(this.name);

		this.speakerService.getCharacteristic(Characteristic.CurrentMediaState)
			.on('get', (callback) => {
				this.log.debug(sprintf("getPos %s = %s", this.address, this.pos));
				callback(null, this.pos);
			});

		this.speakerService.getCharacteristic(Characteristic.TargetMediaState)
			.on('set', (pos, callback) => {
				this.log.debug(sprintf("setPos %s = %s", this.address, pos));
				this.pos = pos
				this.parent.infusion.setBlindPos(this.address, this.pos);
				callback(null);
			})
			.on('get', (callback) => {
				this.log.debug(sprintf("getTargetPos %s = %s", this.address, this.pos));
				callback(null, this.pos);
			});

		this.speakerService.getCharacteristic(Characteristic.Volume)
			.on('get', (callback) => {
				this.log.debug(sprintf("getBlindState %s = %s", this.address, this.posState));
				callback(null, this.posState);
			});

		this.speakerService.getCharacteristic(Characteristic.Mute)
			.on('get', (callback) => {
				this.log.debug(sprintf("getBlindState %s = %s", this.address, this.posState));
				callback(null, this.posState);
			});

		this.parent.infusion.getSpeakerStatus(this.address);
		return [service, this.speakerService];
	}
}
