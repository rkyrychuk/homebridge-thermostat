var Service, Characteristic
const fs = require("fs")
const CONFIG_PATH = "/opt/etc/homebridge/thermostat.data"
const mqtt = require('mqtt')

const STATE = {
  Off: 0, 
  Heat: 1, 
  Cool: 2, 
  Auto: 3
}
module.exports = function (homebridge) {
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  homebridge.registerPlatform("ThermostatHomePlugin", ThermostatHomePlugin);  
}

class ThermostatHomePlugin {
  constructor(log, config, api) {
    this.config = config
    this.accessories = [];
    this.log = log
    
    log.debug('ThermostatHomePlugin Platform Loaded');
    
    api.on('didFinishLaunching', () => {
      log.debug('didFinishLaunching');
      const uuid = api.hap.uuid.generate("000000003fb10225");

      if (!this.accessories.find(accessory => accessory.UUID === uuid)) {
        const accessory = new api.platformAccessory('Thermostat', uuid);
        new ThermostatAccesory(this, accessory)
        api.registerPlatformAccessories('homebridge-thermostat', 'ThermostatHome', [accessory]);
      }      
    })
    this.client = mqtt.connect('mqtt://localhost')
    this.client.on('connect', () => this.client.subscribe('zigbee2mqtt/+'))
  } 
  configureAccessory(accessory) {
    new ThermostatAccesory(this, accessory)
    this.accessories.push(accessory);
  }
}

class ThermostatAccesory {
  constructor(platform, accessory) {
    this.platform = platform
    this.log = platform.log
    this.config = platform.config
    this.accessory = accessory
    this.loadState()
    
    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Viesman')
      .setCharacteristic(Characteristic.Model, 'Vitopend 100')
      .setCharacteristic(Characteristic.SerialNumber, 'raspbery-pi-termostat');

    this.service = this.accessory.getService(Service.Thermostat) || this.accessory.addService(Service.Thermostat)
    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits).updateValue(0)
    this.service.getCharacteristic(Characteristic.CurrentTemperature).on('get', callback => callback(null, this.state.temperature))
    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on('set', this.setTargetHeatingCoolingState.bind(this))
      .setProps({
        validValues: [0, 1, 3]
      })
      .updateValue(this.state.targetMode)

    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .on('set', this.setTargetTemperature.bind(this))
      .setProps({
        minValue: 15,
        maxValue: 30,
        minStep: 0.1
      })
      .updateValue(this.state.targetTemperature)    
    
    //const {sensor, switch}: any = this.config
    
    this.platform.client.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString())
        this.log(data, topic)
        if (topic === `zigbee2mqtt/${this.config.sensor}`) {
          this.state.temperature = data.temperature
          this.state.relativeHumidity = data.humidity
          this.service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(this.state.temperature)
          this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(this.state.relativeHumidity)
        } 
        if (topic === `zigbee2mqtt/${this.config.switch}`) {
          this.state.mode = data.state === "ON" ? STATE.Heat : STATE.Off
          this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(this.state.mode)
        }
      }
      catch(error) {
        this.log(error)
      }       
    })

    setInterval(() => this.verifyHeatingState(), (this.config.pollInterval || 60) * 1000)
  }

  loadState() {
    const sensors = fs.existsSync("/opt/etc/zigbee2mqtt/data/state.json") ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) : {}
    const data = sensors[this.config.sensor] || {}

    this.state = fs.existsSync(CONFIG_PATH) ? 
      JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")): ({
        targetTemperature: 20.5,
        targetMode: STATE.Auto,
        mode: STATE.Off,
        temperature: data.temperature,
        relativeHumidity: data.humidity
      })    
  }
  saveState() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.state))
  }

  setTargetHeatingCoolingState(value, callback) {
    this.log("setTargetHeatingCoolingState", value)
    this.state.targetMode = value
    this.saveState()
    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(this.state.targetMode)
    this.verifyHeatingState()
    callback()
  }

  setTargetTemperature(value, callback) {
    this.log("setTargetTemperature", value)
    this.state.targetTemperature = value.toFixed(1)
    this.saveState()
    this.service.getCharacteristic(Characteristic.TargetTemperature).updateValue(this.state.targetTemperature)
    this.verifyHeatingState()
    callback()
  }

  verifyHeatingState() {
    if (this.state.targetMode === STATE.Auto) {
      if (this.state.temperature) {
        if (this.state.temperature < this.state.targetTemperature) {
          this.setHeatState(STATE.Heat)
        } else {
          this.setHeatState(STATE.Off)
        }
      }
    } else {
      this.setHeatState(this.state.targetMode)
    }    
  }

  setHeatState(state) {
    if (this.state.mode !== state) {
      this.state.mode = state
      this.platform.client.publish(`zigbee2mqtt/${this.config.switch}/set`, JSON.stringify({
       state: this.state.mode === STATE.Heat ? "ON" : "OFF"
      }))      
    }
    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(this.state.mode)
  }  
}
