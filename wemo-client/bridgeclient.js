var SoapClient = require('./soapclient');
var util = require('util');
var http = require('http');
var xml2js = require('xml2js');


var express = require('express');
var bodyparser = require('body-parser');
var os = require('os');

function getLocalInterfaceAddress() {
  var interfaces = os.networkInterfaces();
  var addresses = [];
  for (var k in interfaces) {
    for (var k2 in interfaces[k]) {
      var address = interfaces[k][k2];
      if (address.family === 'IPv4' && !address.internal) {
        addresses.push(address.address);
      }
    }
  }
  return addresses.shift();
}

var BridgeClient = module.exports = function(config) {
  SoapClient.call(this, config);
  this.path = '/upnp/control/bridge1';
  this.serviceType = 'urn:Belkin:service:bridge:1';
  this.sid = null;
  console.log(this.ip, this.port);
  this.listener();
};
util.inherits(BridgeClient, SoapClient);

BridgeClient.prototype.listener = function() {
  var self = this;
  var app = express();
  app.use(bodyparser.raw({type: 'text/xml'}));
  app.all('/', function(req, res) {
    console.log("HEADERS: %j", req.headers);
    xml2js.parseString(req.body, function(err, json){
      if (err) {
        console.log(err);
      }
      console.log("EVENT: %j" , json);
      // TODO: Check / validate req.headers.sid
      if (json['e:propertyset']['e:property'][0]['StatusChange']) {
        xml2js.parseString(json['e:propertyset']['e:property'][0]['StatusChange'][0], function (err, xml) {
          if (!err && xml) {
            self.emit('StatusChange', {
              DeviceId: xml.StateEvent.DeviceID[0]._,
              CapabilityId: xml.StateEvent.CapabilityId[0],
              Value: xml.StateEvent.Value[0]
            });
          }
        });
      }
    });
    res.sendStatus(200);
  });

  var server = app.listen(8080);
  var port = server.address().port;
  this.subscribe('http://' + getLocalInterfaceAddress() + ':' + port);
  console.info('Started Bridge callback server on port ' + port);
};

BridgeClient.prototype.getEndDevices = function(cb) {
  var self = this;

  var parseResponse = function(err, data) {
    if (err) cb(err);
    xml2js.parseString(data, function(err, result) {
      if (!err) {
        var list = result['s:Envelope']['s:Body'][0]['u:GetEndDevicesResponse'][0].DeviceLists[0];
        xml2js.parseString(list, function(err, result2) {
          if (!err) {
            var devinfo = result2.DeviceLists.DeviceList[0].DeviceInfos[0].DeviceInfo;
            if (devinfo) {
              for (var i = 0; i < devinfo.length; i++) {
                var device = {
                  bridge: {
                    ip: self.ip,
                    port: self.port,
                    UDN: self.UDN
                  },
                  friendlyName: devinfo[i].FriendlyName[0],
                  deviceId: devinfo[i].DeviceID[0],
                  currentState: devinfo[i].CurrentState[0].split(','),
                  capabilities: devinfo[i].CapabilityIDs[0].split(',')
                };
                device.internalState = {};
                for (var i = 0; i < device.capabilities.length; i++) {
                  device.internalState[device.capabilities[i]] = device.currentState[i];
                }
                cb(null, device);
              }
            }
            var groupinfos = result2.DeviceLists.DeviceList[0].GroupInfos;
            if (groupinfos) {
              for (var i = 0; i < groupinfos.length; i++) {
                var device = {
                  bridge: {
                    ip: self.ip,
                    port: self.port,
                    UDN: self.UDN
                  },
                  friendlyName: groupinfos[i].GroupInfo[0].GroupName[0],
                  deviceId: groupinfos[i].GroupInfo[0].GroupID[0],
                  currentState: groupinfos[i].GroupInfo[0].GroupCapabilityValues[0].split(','),
                  capabilities: groupinfos[i].GroupInfo[0].GroupCapabilityIDs[0].split(',')
                };
                device.internalState = {};
                for (var i = 0; i < device.capabilities.length; i++) {
                  device.internalState[device.capabilities[i]] = device.currentState[i];
                }
                cb(null, device);
              }
            }
          } else {
            console.log(err, data);
          }
        });
      }
    });
  };

  var body = '<u:GetEndDevices xmlns:u="urn:Belkin:service:bridge:1"><DevUDN>%s</DevUDN><ReqListType>PAIRED_LIST</ReqListType></u:GetEndDevices>';
  this.post('GetEndDevices', util.format(body, this.UDN), parseResponse);
}

BridgeClient.prototype.setDeviceStatus = function(deviceId, capability, value) {
  var isGroupAction = (deviceId.length === 10) ? 'YES' : 'NO';
  var body = [
    '<u:SetDeviceStatus xmlns:u="urn:Belkin:service:bridge:1">',
    '<DeviceStatusList>',
    '&lt;?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot;?&gt;&lt;DeviceStatus&gt;&lt;IsGroupAction&gt;%s&lt;/IsGroupAction&gt;&lt;DeviceID available=&quot;YES&quot;&gt;%s&lt;/DeviceID&gt;&lt;CapabilityID&gt;%s&lt;/CapabilityID&gt;&lt;CapabilityValue&gt;%s&lt;/CapabilityValue&gt;&lt;/DeviceStatus&gt;',
    '</DeviceStatusList>',
    '</u:SetDeviceStatus>'
  ].join('\n');
  this.post('SetDeviceStatus', util.format(body, isGroupAction, deviceId, capability, value));
};

BridgeClient.prototype.subscribe = function(callbackUri, cb) {
  var options = {
    host: this.ip,
    port: this.port,
    path: '/upnp/event/bridge1',
    method: 'SUBSCRIBE',
    headers: {
      TIMEOUT: 'Second-120'
    }
  };

  // Initial subscription, not a renewal
  if (!this.sid) {
    options.headers.CALLBACK = '<' + callbackUri + '>';
    options.headers.NT = 'upnp:event';
    console.log('initial event subscription', options);
  } else {
    options.headers.SID = this.sid;
    console.log('event subscription renewal', options);
  }

  var req = http.request(options, function(res) {
    if (res.headers.sid) this.sid = res.headers.sid;
    setTimeout(this.subscribe.bind(this), 100 * 1000, callbackUri);
  }.bind(this));
  req.end();
};
