
const home = require('../config').get('service').home;

function getHostings() {
  return {
    regions: {
      region1: {
        name: 'region1',
        zones: {
          zone1: {
            name: 'zone1',
            hostings: {
              hosting1: {
                url: home, // here we set the sole dynamic var
                name: 'Pryv.io',
                description: 'Self hosted',
                available: true
              }
            }
          }
        }
      }
    }
  }
}

function getCoreForHosting(
  hosting: string, callback: HostForHostingCallback
) {
  callback(null, 'http://localhost:3000');
}

exports.getHostings = getHostings;
exports.getCoreForHosting = getCoreForHosting;